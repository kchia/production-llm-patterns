"""
PII Detection — Type definitions

Dataclasses and type aliases for the PII detection pipeline.
Uses Python-native typing: dataclasses, Literal, Protocol.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

PIIEntityType = Literal[
    "SSN",
    "CREDIT_CARD",
    "EMAIL",
    "PHONE",
    "IP_ADDRESS",
    "PERSON",
    "ORGANIZATION",
    "LOCATION",
    "DATE_OF_BIRTH",
    "MEDICAL",
    "CUSTOM",
]

RedactionStrategy = Literal["placeholder", "mask", "hash", "redact"]


@dataclass(frozen=True, slots=True)
class PIIEntity:
    """A single PII entity detected in text."""

    type: PIIEntityType
    text: str
    start: int
    end: int
    confidence: float
    source: Literal["regex", "ner"]


@dataclass(frozen=True, slots=True)
class DetectionStats:
    """Performance and detection statistics."""

    input_length: int
    entity_count: int
    detection_time_ms: float
    recognizers_used: list[str]


@dataclass
class PIIDetectionResult:
    """Result from running detection on a text input."""

    entities: list[PIIEntity]
    sanitized_text: str
    reversal_map: dict[str, str]
    stats: DetectionStats


@dataclass
class RedactedResult:
    """Result of applying redaction to detected entities."""

    sanitized_text: str
    reversal_map: dict[str, str]
    entity_count: int


@dataclass
class RedactionOptions:
    """Options for the redaction step."""

    strategy: RedactionStrategy | None = None
    reversible: bool | None = None
    mask_char: str = "*"


@runtime_checkable
class PIIRecognizer(Protocol):
    """A recognizer matches PII in text — regex or NER-based."""

    name: str
    entity_type: PIIEntityType

    def recognize(self, text: str) -> list[PIIEntity]: ...


@dataclass
class PIIDetectorConfig:
    """Full configuration for the PII detector."""

    confidence_threshold: float = 0.7
    entity_types: list[PIIEntityType] | None = None
    redaction_strategy: RedactionStrategy = "placeholder"
    custom_recognizers: list[PIIRecognizer] = field(default_factory=list)
    allow_list: list[str] = field(default_factory=list)
    reversible: bool = True


@dataclass
class MockProviderConfig:
    """Configuration for the mock LLM provider."""

    latency_ms: float = 50.0
    output_tokens: int = 100
    error_to_throw: Exception | None = None
    response_text: str = ""


@dataclass(frozen=True, slots=True)
class MockLLMResponse:
    """A mock LLM call result."""

    text: str
    input_tokens: int
    output_tokens: int
    latency_ms: float
