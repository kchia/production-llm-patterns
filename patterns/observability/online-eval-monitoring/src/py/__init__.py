"""
Online Eval Monitoring — Python implementation.

Wraps async handlers to sample production traces and run eval scorers
asynchronously — zero impact on request latency.

Design notes vs. the TypeScript implementation:
- Uses asyncio.create_task() for fire-and-forget queue processing instead of
  void-cast promises. asyncio.Task is the idiomatic Python equivalent.
- Uses collections.deque(maxlen=N) for the rolling window circular buffer —
  Python's deque automatically drops from the left when full, which is cleaner
  than a manual circular index.
- Scorer protocol uses duck typing (structural subtyping via Protocol) rather
  than an abstract base class, matching Python convention for collaborator types.
- asyncio.wait_for() handles scorer timeout instead of Promise.race().
- time.time() for timestamps (float seconds) vs Date.now() (int milliseconds).
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Optional, TypeVar

from .types import (
    AlertCallback,
    AlertEvent,
    AlertLevel,
    EvalContext,
    OnlineEvalConfig,
    ScoreCallback,
    ScoreResult,
    TimeWindow,
    Trace,
)

T = TypeVar("T")


@dataclass
class _QueuedJob:
    trace: Trace
    scorer: Any  # Any object with .name, .sampling_rate, .score(Trace) -> Awaitable[float]


class OnlineEvalMonitor:
    """Samples production traces and runs eval scorers asynchronously.

    Usage::

        monitor = OnlineEvalMonitor()
        monitor.add_scorer(MyScorer())
        monitor.on_score(lambda r: print(r.score))

        result = await monitor.wrap(
            lambda: llm_provider.complete(prompt),
            EvalContext(input=prompt, output=""),
        )
    """

    def __init__(self, config: Optional[OnlineEvalConfig] = None) -> None:
        self._config = config or OnlineEvalConfig()
        self._scorers: list[Any] = []
        self._score_callbacks: list[ScoreCallback] = []
        self._alert_callbacks: list[AlertCallback] = []

        # Rolling window per scorer: deque(maxlen=window_size) as circular buffer.
        # deque automatically evicts the oldest value when maxlen is exceeded —
        # no manual index tracking needed vs. the TypeScript implementation.
        self._score_windows: dict[str, deque[float]] = {}

        # Append-only score log for time-windowed queries
        self._score_log: list[ScoreResult] = []

        # Simple list as FIFO queue; bounded by dropping from the front
        self._queue: list[_QueuedJob] = []
        self._processing_task: Optional[asyncio.Task[None]] = None

        # Metrics
        self._dropped_jobs = 0
        self._total_scored = 0
        self._total_errors = 0

    def add_scorer(self, scorer: Any) -> None:
        """Register a scorer. scorer must have .name, .sampling_rate, and async .score(Trace)."""
        self._scorers.append(scorer)
        self._score_windows[scorer.name] = deque(maxlen=self._config.window_size)

    def on_score(self, callback: ScoreCallback) -> None:
        self._score_callbacks.append(callback)

    def on_alert(self, callback: AlertCallback) -> None:
        self._alert_callbacks.append(callback)

    async def wrap(self, handler: Callable[[], Any], context: EvalContext) -> Any:
        """Run handler immediately; sample eval jobs asynchronously after.

        The handler's result is returned before any eval work begins.
        """
        result = await handler()

        # Capture output as string; JSON-serialize non-string results
        output = result if isinstance(result, str) else json.dumps(result, default=str)
        trace = Trace(
            id=str(uuid.uuid4()),
            timestamp=time.time(),
            context=EvalContext(
                input=context.input,
                output=output,
                metadata=context.metadata,
            ),
        )

        import random

        for scorer in self._scorers:
            if random.random() < scorer.sampling_rate:
                self._enqueue(_QueuedJob(trace=trace, scorer=scorer))

        # Start background processing if not already running.
        # create_task schedules without awaiting — equivalent to TS `void this.processQueue()`
        if self._processing_task is None or self._processing_task.done():
            self._processing_task = asyncio.create_task(self._process_queue())

        return result

    def get_scores(self, scorer_name: str, window: TimeWindow) -> list[ScoreResult]:
        return [
            r
            for r in self._score_log
            if r.scorer_name == scorer_name
            and r.timestamp >= window.start_s
            and r.timestamp <= window.end_s
        ]

    def get_rolling_mean(self, scorer_name: str) -> Optional[float]:
        window = self._score_windows.get(scorer_name)
        if window is None or len(window) == 0:
            return None
        return sum(window) / len(window)

    def get_metrics(self) -> dict[str, int]:
        return {
            "queue_depth": len(self._queue),
            "dropped_jobs": self._dropped_jobs,
            "total_scored": self._total_scored,
            "total_errors": self._total_errors,
        }

    # --- Private ---

    def _enqueue(self, job: _QueuedJob) -> None:
        if len(self._queue) >= self._config.queue_size:
            # Drop oldest to keep memory bounded
            self._queue.pop(0)
            self._dropped_jobs += 1
        self._queue.append(job)

    async def _process_queue(self) -> None:
        while self._queue:
            job = self._queue.pop(0)
            await self._run_job(job)

    async def _run_job(self, job: _QueuedJob) -> None:
        start = time.time()
        try:
            # asyncio.wait_for raises asyncio.TimeoutError on expiry —
            # caught by the bare except below alongside scorer errors
            score = await asyncio.wait_for(
                job.scorer.score(job.trace),
                timeout=self._config.async_timeout_s,
            )
            result = ScoreResult(
                trace_id=job.trace.id,
                scorer_name=job.scorer.name,
                score=score,
                timestamp=time.time(),
                duration_ms=(time.time() - start) * 1000,
            )
            self._record_score(result)
            self._total_scored += 1
        except Exception:
            # Eval failures are non-fatal — never surface to the caller
            self._total_errors += 1

    def _record_score(self, result: ScoreResult) -> None:
        self._score_log.append(result)

        # Append to circular buffer — deque handles eviction automatically
        self._score_windows[result.scorer_name].append(result.score)

        for cb in self._score_callbacks:
            cb(result)

        mean = self.get_rolling_mean(result.scorer_name)
        if mean is not None:
            level: Optional[AlertLevel] = None
            if mean < self._config.critical_threshold:
                level = "critical"
            elif mean < self._config.alert_threshold:
                level = "warning"

            if level is not None:
                event = AlertEvent(
                    level=level,
                    scorer_name=result.scorer_name,
                    score=result.score,
                    rolling_mean=mean,
                    trace_id=result.trace_id,
                )
                for cb in self._alert_callbacks:
                    cb(event)
