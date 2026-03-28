"""Type definitions for the Streaming Backpressure pattern."""

from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional


@dataclass
class BackpressureOptions:
    """Configuration for the backpressure controller."""

    # Max tokens to buffer before pausing the producer.
    # Default 16 matches Node.js object-mode highWaterMark.
    high_water_mark: int = 16

    # Max seconds to wait for drain before aborting the stream.
    drain_timeout: float = 5.0

    # Called each time the producer is paused due to backpressure.
    on_backpressure: Optional[Callable[[], None]] = None

    # Called each time the producer resumes after a drain.
    on_drain: Optional[Callable[[], None]] = None


@dataclass
class StreamResult:
    """Results from a completed or aborted streaming session."""

    tokens_delivered: int = 0

    # How many times the producer was paused due to a full buffer.
    backpressure_events: int = 0

    # How many drain events allowed the producer to resume.
    drain_events: int = 0

    # True if the stream ended because the client disconnected.
    client_disconnected: bool = False

    # True if the stream ended because drain_timeout expired.
    drain_timeout_expired: bool = False

    duration_ms: float = 0.0
