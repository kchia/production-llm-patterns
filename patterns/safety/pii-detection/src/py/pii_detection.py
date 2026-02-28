"""
PII Detection — Core Implementation

Hybrid regex + heuristic detection pipeline for identifying and redacting
personally identifiable information before it reaches LLM providers.
Framework-agnostic, no external NLP dependencies — ships with built-in
regex recognizers and a pluggable recognizer interface.
"""

from __future__ import annotations

import hashlib
import re
import time
from dataclasses import dataclass

from _types import (
    DetectionStats,
    PIIDetectionResult,
    PIIDetectorConfig,
    PIIEntity,
    PIIEntityType,
    RedactedResult,
    RedactionOptions,
    RedactionStrategy,
)

# ── Built-in Regex Recognizers ──────────────────────────────────────


@dataclass
class _RegexRecognizer:
    """Simple recognizer that wraps a compiled regex pattern."""

    name: str
    entity_type: PIIEntityType
    _pattern: re.Pattern[str]
    _confidence: float
    _source: str  # "regex" or "ner"
    _use_group: int = 0  # which capture group to use (0 = full match)

    def recognize(self, text: str) -> list[PIIEntity]:
        entities: list[PIIEntity] = []
        for match in self._pattern.finditer(text):
            matched_text = match.group(self._use_group)
            start = match.start(self._use_group)
            entities.append(
                PIIEntity(
                    type=self.entity_type,
                    text=matched_text,
                    start=start,
                    end=start + len(matched_text),
                    confidence=self._confidence,
                    source=self._source,  # type: ignore[arg-type]
                )
            )
        return entities


class _CreditCardRecognizer:
    """Credit card recognizer with Luhn checksum validation."""

    name = "credit-card-regex"
    entity_type: PIIEntityType = "CREDIT_CARD"

    _pattern = re.compile(r"\b(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{1,7})\b")

    def recognize(self, text: str) -> list[PIIEntity]:
        entities: list[PIIEntity] = []
        for match in self._pattern.finditer(text):
            matched_text = match.group(1)
            digits = re.sub(r"[-\s]", "", matched_text)
            if _luhn_check(digits):
                start = match.start(1)
                entities.append(
                    PIIEntity(
                        type="CREDIT_CARD",
                        text=matched_text,
                        start=start,
                        end=start + len(matched_text),
                        confidence=0.9,
                        source="regex",
                    )
                )
        return entities


def _luhn_check(num: str) -> bool:
    """Luhn algorithm for credit card validation."""
    if not num.isdigit() or not (13 <= len(num) <= 19):
        return False
    total = 0
    alternate = False
    for ch in reversed(num):
        n = int(ch)
        if alternate:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        alternate = not alternate
    return total % 10 == 0


_SSN = _RegexRecognizer(
    name="ssn-regex",
    entity_type="SSN",
    _pattern=re.compile(r"\b(\d{3}-\d{2}-\d{4})\b"),
    _confidence=0.95,
    _source="regex",
    _use_group=1,
)

_EMAIL = _RegexRecognizer(
    name="email-regex",
    entity_type="EMAIL",
    _pattern=re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    _confidence=0.98,
    _source="regex",
)

_PHONE = _RegexRecognizer(
    name="phone-regex",
    entity_type="PHONE",
    _pattern=re.compile(r"(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b"),
    _confidence=0.85,
    _source="regex",
)

_IP_ADDRESS = _RegexRecognizer(
    name="ip-regex",
    entity_type="IP_ADDRESS",
    _pattern=re.compile(
        r"\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b"
    ),
    _confidence=0.9,
    _source="regex",
)

# Catches title + capitalized names: "Dr. John Smith", "Ms. Jane Doe"
_PERSON = _RegexRecognizer(
    name="person-heuristic",
    entity_type="PERSON",
    _pattern=re.compile(
        r"\b(?:Mr|Mrs|Ms|Miss|Dr|Prof|Rev|Sr|Jr)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b"
    ),
    _confidence=0.75,
    _source="ner",
)

# Only match dates preceded by context clues like "born", "DOB"
_DOB = _RegexRecognizer(
    name="dob-regex",
    entity_type="DATE_OF_BIRTH",
    _pattern=re.compile(
        r"(?:born|DOB|date of birth|birthday|d\.o\.b\.?)[:\s]+(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4})",
        re.IGNORECASE,
    ),
    _confidence=0.85,
    _source="regex",
    _use_group=1,
)

_BUILT_IN_RECOGNIZERS = [_SSN, _CreditCardRecognizer(), _EMAIL, _PHONE, _IP_ADDRESS, _PERSON, _DOB]


# ── Entity Merging ──────────────────────────────────────────────────


def _merge_entities(entities: list[PIIEntity]) -> list[PIIEntity]:
    """Merge overlapping entities, preferring higher-confidence detections."""
    if not entities:
        return []

    # Sort by start position, then by confidence descending
    sorted_entities = sorted(entities, key=lambda e: (e.start, -e.confidence))
    merged: list[PIIEntity] = [sorted_entities[0]]

    for current in sorted_entities[1:]:
        last = merged[-1]

        # Skip if fully contained within a higher-confidence entity
        if current.start >= last.start and current.end <= last.end:
            continue

        # Overlapping but not contained: keep the higher-confidence one
        if current.start < last.end:
            if current.confidence > last.confidence:
                merged[-1] = current
            continue

        merged.append(current)

    return merged


def _sha256_short(text: str) -> str:
    """SHA-256 hash truncated to 12 hex chars for the 'hash' redaction strategy."""
    return hashlib.sha256(text.encode()).hexdigest()[:12]


# ── Core PII Detector ───────────────────────────────────────────────


class PIIDetector:
    """Hybrid regex + heuristic PII detection with configurable redaction."""

    def __init__(self, config: PIIDetectorConfig | None = None) -> None:
        cfg = config or PIIDetectorConfig()

        self._confidence_threshold = cfg.confidence_threshold
        self._redaction_strategy: RedactionStrategy = cfg.redaction_strategy
        self._allow_list = {term.lower() for term in cfg.allow_list}
        self._reversible = cfg.reversible

        enabled_types: set[PIIEntityType] = set(
            cfg.entity_types
            or ["SSN", "CREDIT_CARD", "EMAIL", "PHONE", "IP_ADDRESS", "PERSON", "DATE_OF_BIRTH"]
        )

        # Filter built-in recognizers to enabled types, then append custom
        self._recognizers = [
            r for r in _BUILT_IN_RECOGNIZERS if r.entity_type in enabled_types
        ] + list(cfg.custom_recognizers)

    def detect(self, text: str) -> PIIDetectionResult:
        """Run full detection + redaction pipeline."""
        start = time.perf_counter()

        raw = self._run_recognizers(text)
        thresholded = [e for e in raw if e.confidence >= self._confidence_threshold]
        filtered = self._apply_allow_list(thresholded)
        entities = _merge_entities(filtered)

        redacted = self.redact(text, entities)
        detection_time_ms = (time.perf_counter() - start) * 1000

        return PIIDetectionResult(
            entities=entities,
            sanitized_text=redacted.sanitized_text,
            reversal_map=redacted.reversal_map,
            stats=DetectionStats(
                input_length=len(text),
                entity_count=len(entities),
                detection_time_ms=detection_time_ms,
                recognizers_used=[r.name for r in self._recognizers],
            ),
        )

    def detect_entities(self, text: str) -> list[PIIEntity]:
        """Run detection only — returns entities without redacting."""
        raw = self._run_recognizers(text)
        thresholded = [e for e in raw if e.confidence >= self._confidence_threshold]
        filtered = self._apply_allow_list(thresholded)
        return _merge_entities(filtered)

    def redact(
        self,
        text: str,
        entities: list[PIIEntity],
        options: RedactionOptions | None = None,
    ) -> RedactedResult:
        """Apply redaction to text using provided entities."""
        opts = options or RedactionOptions()
        strategy = opts.strategy or self._redaction_strategy
        reversible = opts.reversible if opts.reversible is not None else self._reversible
        mask_char = opts.mask_char

        reversal_map: dict[str, str] = {}
        count_by_type: dict[str, int] = {}

        # Process from end to start so indices stay valid
        sorted_entities = sorted(entities, key=lambda e: e.start, reverse=True)
        result = text

        for entity in sorted_entities:
            count_by_type[entity.type] = count_by_type.get(entity.type, 0) + 1
            count = count_by_type[entity.type]

            if strategy == "placeholder":
                replacement = f"[{entity.type}_{count}]"
            elif strategy == "mask":
                replacement = mask_char * len(entity.text)
            elif strategy == "hash":
                replacement = f"[HASH:{_sha256_short(entity.text)}]"
            elif strategy == "redact":
                replacement = "[REDACTED]"
            else:
                replacement = f"[{entity.type}]"

            if reversible:
                reversal_map[replacement] = entity.text

            result = result[: entity.start] + replacement + result[entity.end :]

        return RedactedResult(
            sanitized_text=result,
            reversal_map=reversal_map,
            entity_count=len(entities),
        )

    @staticmethod
    def reverse(text: str, reversal_map: dict[str, str]) -> str:
        """Reverse redaction on an LLM response using the reversal map."""
        result = text
        for placeholder, original in reversal_map.items():
            result = result.replace(placeholder, original)
        return result

    # ── Private ──────────────────────────────────────────────────────

    def _run_recognizers(self, text: str) -> list[PIIEntity]:
        all_entities: list[PIIEntity] = []
        for recognizer in self._recognizers:
            all_entities.extend(recognizer.recognize(text))
        return all_entities

    def _apply_allow_list(self, entities: list[PIIEntity]) -> list[PIIEntity]:
        if not self._allow_list:
            return entities
        return [e for e in entities if e.text.lower() not in self._allow_list]


def detect_pii(text: str, config: PIIDetectorConfig | None = None) -> PIIDetectionResult:
    """Convenience function: creates a PIIDetector and runs detection in one call."""
    detector = PIIDetector(config)
    return detector.detect(text)
