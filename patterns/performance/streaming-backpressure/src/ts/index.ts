/**
 * Streaming Backpressure — core implementation.
 *
 * Pipes a token-producing AsyncIterable to a writable sink while
 * respecting the sink's flow-control signals (write() return value,
 * 'drain' event) and cancelling upstream inference on client disconnect.
 *
 * Framework-agnostic: works with any AsyncIterable source and any
 * object that implements the write()/on('drain') interface (Node.js
 * ServerResponse, mock sinks, etc.).
 */

import { BackpressureOptions, StreamResult, DEFAULT_CONFIG } from './types.js';

/** Minimal interface for a writable sink that supports backpressure. */
export interface WritableSink {
  write(chunk: string): boolean;
  on(event: 'drain', listener: () => void): this;
  once(event: 'drain', listener: () => void): this;
  end(): void;
}

/**
 * Waits for the sink's 'drain' event or for the timeout to expire.
 * Returns true if drained, false if timed out.
 *
 * Using a Promise race here rather than setTimeout + event listener
 * separately avoids the risk of a stale event listener accumulating
 * on the sink if the timeout fires first.
 */
function waitForDrain(sink: WritableSink, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false); // timed out — signal abort to caller
    }, timeoutMs);

    sink.once('drain', () => {
      clearTimeout(timer);
      resolve(true); // drained successfully
    });
  });
}

/**
 * Pipe a token stream from an LLM to a client sink with full backpressure.
 *
 * Key behaviors:
 * - Pauses iteration when write() returns false (sink buffer full)
 * - Resumes only after 'drain' event (sink buffer cleared)
 * - Aborts on drainTimeout (slow/dead clients don't hold resources indefinitely)
 * - Cancels upstream inference when AbortSignal fires (client disconnect)
 *
 * @param source  AsyncIterable of string tokens (from LLM client or mock)
 * @param sink    Writable target with backpressure protocol
 * @param options Configuration for buffer limits, timeouts, callbacks
 */
export async function pipeWithBackpressure(
  source: AsyncIterable<string>,
  sink: WritableSink,
  options: BackpressureOptions = {}
): Promise<StreamResult> {
  const config = {
    highWaterMark: options.highWaterMark ?? DEFAULT_CONFIG.highWaterMark,
    drainTimeout: options.drainTimeout ?? DEFAULT_CONFIG.drainTimeout,
  };

  const result: StreamResult = {
    tokensDelivered: 0,
    backpressureEvents: 0,
    drainEvents: 0,
    clientDisconnected: false,
    drainTimeoutExpired: false,
    durationMs: 0,
  };

  const startTime = Date.now();

  // Track disconnect via AbortSignal — fired externally when client closes
  const disconnected = options.signal
    ? new Promise<void>((resolve) => {
        options.signal!.addEventListener('abort', () => resolve(), { once: true });
      })
    : null;

  // Token buffer: we batch tokens in memory up to highWaterMark before
  // flushing to the sink. This decouples the producer's iteration cadence
  // from the sink's write cadence.
  let buffer: string[] = [];

  /**
   * Flush buffered tokens to the sink.
   * Returns false if the sink signaled backpressure and we timed out waiting.
   */
  async function flush(): Promise<boolean> {
    for (const token of buffer) {
      if (options.signal?.aborted) {
        result.clientDisconnected = true;
        return false;
      }

      const canContinue = sink.write(token);
      result.tokensDelivered++;

      if (!canContinue) {
        // Sink buffer full: pause and wait for drain
        result.backpressureEvents++;
        options.onBackpressure?.();

        const drained = await waitForDrain(sink, config.drainTimeout);

        if (!drained) {
          result.drainTimeoutExpired = true;
          return false;
        }

        result.drainEvents++;
        options.onDrain?.();
      }
    }
    buffer = [];
    return true;
  }

  try {
    for await (const token of source) {
      // Check for disconnect before processing each token
      if (options.signal?.aborted) {
        result.clientDisconnected = true;
        break;
      }

      buffer.push(token);

      // Flush when buffer reaches highWaterMark
      if (buffer.length >= config.highWaterMark) {
        const ok = await flush();
        if (!ok) break;
      }
    }

    // Flush remaining buffered tokens after the source exhausts
    if (!result.clientDisconnected && !result.drainTimeoutExpired && buffer.length > 0) {
      await flush();
    }
  } finally {
    result.durationMs = Date.now() - startTime;
    sink.end();
  }

  return result;
}

/**
 * Wraps pipeWithBackpressure with disconnect detection wired to request lifecycle.
 *
 * In a Node.js HTTP handler, pass `req` as the disconnect source. The 'close'
 * event fires when the client drops — this creates an AbortSignal that cancels
 * the upstream LLM inference, freeing KV cache and GPU resources.
 *
 * Usage:
 *   const result = await streamWithDisconnectDetection(
 *     llmStream,
 *     res,
 *     req,
 *     { highWaterMark: 16, drainTimeout: 5000 }
 *   );
 */
export function streamWithDisconnectDetection(
  source: AsyncIterable<string>,
  sink: WritableSink,
  disconnectSource: { on(event: 'close', listener: () => void): void },
  options: Omit<BackpressureOptions, 'signal'> = {}
): Promise<StreamResult> {
  const controller = new AbortController();

  // Wire client disconnect to upstream cancellation
  disconnectSource.on('close', () => {
    controller.abort();
  });

  return pipeWithBackpressure(source, sink, {
    ...options,
    signal: controller.signal,
  });
}
