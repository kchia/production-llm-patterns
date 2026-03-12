"""
Type definitions for Prompt Injection Defense.

Uses dataclasses and Protocol for idiomatic Python typing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal, Protocol, runtime_checkable
import re


class ScreenAction(str, Enum):
    """Decision outcome from the defense pipeline."""
    ALLOW = "allow"
    FLAG = "flag"
    BLOCK = "block"


class BlockAction(str, Enum):
    """What to do when input is blocked."""
    REJECT = "reject"
    SANITIZE = "sanitize"


@dataclass(frozen=True)
class DetectionRule:
    """A pattern-matching rule for injection detection."""
    id: str
    name: str
    pattern: re.Pattern[str]
    severity: float
    description: str


@dataclass(frozen=True)
class LayerWeights:
    """Weights for combining layer scores."""
    sanitizer: float = 0.1
    pattern: float = 0.3
    classifier: float = 0.6


@dataclass(frozen=True)
class LayerScores:
    """Scores from each defense layer plus the combined result."""
    sanitizer: float
    pattern: float
    classifier: float
    combined: float


@dataclass
class ScreenInput:
    """Input to the defense screening pipeline."""
    user_input: str
    system_prompt: str | None = None


@dataclass
class ScreenResult:
    """Result of screening user input through the defense pipeline."""
    allowed: bool
    action: ScreenAction
    scores: LayerScores
    flagged_patterns: list[str]
    latency_ms: float
    canary_token: str | None = None


@dataclass
class ScanResult:
    """Result of scanning LLM output for post-generation attacks."""
    clean: bool
    canary_leaked: bool
    suspicious_patterns: list[str]
    exfiltration_risk: float


@dataclass
class InjectionDefenseConfig:
    """User-facing configuration — all fields optional with sensible defaults."""
    block_threshold: float | None = None
    flag_threshold: float | None = None
    max_input_length: int | None = None
    enable_classifier: bool | None = None
    enable_output_scan: bool | None = None
    enable_canary_tokens: bool | None = None
    pattern_rules: list[DetectionRule] | None = None
    layer_weights: LayerWeights | None = None
    on_block: BlockAction | None = None


@dataclass
class ResolvedConfig:
    """Fully resolved configuration with no optional fields."""
    block_threshold: float
    flag_threshold: float
    max_input_length: int
    enable_classifier: bool
    enable_output_scan: bool
    enable_canary_tokens: bool
    pattern_rules: list[DetectionRule]
    layer_weights: LayerWeights
    on_block: BlockAction


@dataclass
class DefenseMetrics:
    """Runtime metrics for observability."""
    total_screened: int = 0
    blocked: int = 0
    flagged: int = 0
    allowed: int = 0
    avg_latency_ms: float = 0.0
    canary_leaks: int = 0
    classifier_timeouts: int = 0


@runtime_checkable
class InjectionClassifier(Protocol):
    """Protocol for pluggable injection classifiers.

    Implement this to swap in a real ML model (e.g., Meta Prompt Guard).
    """

    async def classify(self, input_text: str) -> float:
        """Return injection probability between 0.0 and 1.0."""
        ...
