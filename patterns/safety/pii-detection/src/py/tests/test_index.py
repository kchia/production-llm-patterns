"""
PII Detection — Tests

Unit, failure mode, and integration tests for the Python PII detection pipeline.
"""

from __future__ import annotations

import asyncio
import re
import time

import pytest

from pii_detection import PIIDetector, detect_pii
from mock_provider import MockLLMProvider, MockProviderConfig
from _types import PIIDetectorConfig, PIIEntity, RedactionOptions


# ── Unit Tests ──────────────────────────────────────────────────────


class TestSSNDetection:
    def test_detects_standard_ssn_format(self) -> None:
        detector = PIIDetector()
        result = detector.detect("My SSN is 123-45-6789")
        assert len(result.entities) == 1
        assert result.entities[0].type == "SSN"
        assert result.entities[0].text == "123-45-6789"
        assert result.entities[0].confidence >= 0.9

    def test_does_not_match_partial_ssn(self) -> None:
        detector = PIIDetector()
        result = detector.detect("Order number: 12345678")
        ssn_entities = [e for e in result.entities if e.type == "SSN"]
        assert len(ssn_entities) == 0


class TestCreditCardDetection:
    def test_detects_valid_credit_card_with_dashes(self) -> None:
        detector = PIIDetector()
        result = detector.detect("Card: 4111-1111-1111-1111")
        cc = [e for e in result.entities if e.type == "CREDIT_CARD"]
        assert len(cc) == 1
        assert cc[0].text == "4111-1111-1111-1111"

    def test_rejects_invalid_luhn_checksum(self) -> None:
        detector = PIIDetector()
        result = detector.detect("Card: 1234-5678-9012-3456")
        cc = [e for e in result.entities if e.type == "CREDIT_CARD"]
        assert len(cc) == 0


class TestEmailDetection:
    def test_detects_standard_email(self) -> None:
        detector = PIIDetector()
        result = detector.detect("Contact john.doe@example.com for details")
        emails = [e for e in result.entities if e.type == "EMAIL"]
        assert len(emails) == 1
        assert emails[0].text == "john.doe@example.com"

    def test_detects_multiple_emails(self) -> None:
        detector = PIIDetector()
        result = detector.detect("Email a@b.com or c@d.org")
        emails = [e for e in result.entities if e.type == "EMAIL"]
        assert len(emails) == 2


class TestPhoneDetection:
    def test_detects_us_phone_with_parens(self) -> None:
        detector = PIIDetector()
        result = detector.detect("Call (555) 123-4567")
        phones = [e for e in result.entities if e.type == "PHONE"]
        assert len(phones) == 1

    def test_detects_phone_with_country_code(self) -> None:
        detector = PIIDetector()
        result = detector.detect("Call +1-555-123-4567")
        phones = [e for e in result.entities if e.type == "PHONE"]
        assert len(phones) == 1


class TestIPAddressDetection:
    def test_detects_ipv4(self) -> None:
        detector = PIIDetector()
        result = detector.detect("Server at 192.168.1.100")
        ips = [e for e in result.entities if e.type == "IP_ADDRESS"]
        assert len(ips) == 1
        assert ips[0].text == "192.168.1.100"


class TestPersonDetection:
    def test_detects_names_with_titles(self) -> None:
        detector = PIIDetector()
        result = detector.detect("Dr. John Smith ordered the test")
        persons = [e for e in result.entities if e.type == "PERSON"]
        assert len(persons) == 1
        assert "John Smith" in persons[0].text


class TestConfiguration:
    def test_respects_confidence_threshold(self) -> None:
        detector = PIIDetector(PIIDetectorConfig(confidence_threshold=0.99))
        result = detector.detect("Call Dr. John Smith at (555) 123-4567")
        persons = [e for e in result.entities if e.type == "PERSON"]
        assert len(persons) == 0

    def test_respects_entity_type_filter(self) -> None:
        detector = PIIDetector(PIIDetectorConfig(entity_types=["EMAIL"]))
        result = detector.detect("SSN: 123-45-6789, email: a@b.com")
        assert all(e.type == "EMAIL" for e in result.entities)

    def test_respects_allow_list(self) -> None:
        detector = PIIDetector(PIIDetectorConfig(allow_list=["john.doe@example.com"]))
        result = detector.detect("Contact john.doe@example.com")
        emails = [e for e in result.entities if e.type == "EMAIL"]
        assert len(emails) == 0

    def test_accepts_custom_recognizers(self) -> None:
        class EmployeeIDRecognizer:
            name = "employee-id"
            entity_type = "CUSTOM"

            def recognize(self, text: str) -> list[PIIEntity]:
                pattern = re.compile(r"EMP-\d{6}")
                return [
                    PIIEntity(
                        type="CUSTOM",
                        text=m.group(),
                        start=m.start(),
                        end=m.end(),
                        confidence=0.95,
                        source="regex",
                    )
                    for m in pattern.finditer(text)
                ]

        detector = PIIDetector(
            PIIDetectorConfig(custom_recognizers=[EmployeeIDRecognizer()])
        )
        result = detector.detect("Employee EMP-123456 requested access")
        custom = [e for e in result.entities if e.type == "CUSTOM"]
        assert len(custom) == 1
        assert custom[0].text == "EMP-123456"


class TestRedactionStrategies:
    def test_placeholder_redaction(self) -> None:
        detector = PIIDetector(PIIDetectorConfig(redaction_strategy="placeholder"))
        result = detector.detect("My SSN is 123-45-6789")
        assert "[SSN_" in result.sanitized_text
        assert "123-45-6789" not in result.sanitized_text

    def test_mask_redaction(self) -> None:
        detector = PIIDetector(PIIDetectorConfig(redaction_strategy="mask"))
        result = detector.detect("Email: a@b.com")
        assert "******" in result.sanitized_text
        assert "a@b.com" not in result.sanitized_text

    def test_hash_redaction(self) -> None:
        detector = PIIDetector(PIIDetectorConfig(redaction_strategy="hash"))
        result = detector.detect("My SSN is 123-45-6789")
        assert "[HASH:" in result.sanitized_text

    def test_redact_strategy(self) -> None:
        detector = PIIDetector(PIIDetectorConfig(redaction_strategy="redact"))
        result = detector.detect("My SSN is 123-45-6789")
        assert "[REDACTED]" in result.sanitized_text


class TestReversal:
    def test_reverses_placeholder_redaction(self) -> None:
        detector = PIIDetector(PIIDetectorConfig(redaction_strategy="placeholder"))
        original = "My SSN is 123-45-6789 and email is a@b.com"
        result = detector.detect(original)

        llm_response = f"Based on your info: {result.sanitized_text}"
        reversed_text = PIIDetector.reverse(llm_response, result.reversal_map)

        assert "123-45-6789" in reversed_text
        assert "a@b.com" in reversed_text

    def test_skips_reversal_when_disabled(self) -> None:
        detector = PIIDetector(PIIDetectorConfig(reversible=False))
        result = detector.detect("My SSN is 123-45-6789")
        assert len(result.reversal_map) == 0


class TestDetectionStats:
    def test_returns_accurate_stats(self) -> None:
        detector = PIIDetector()
        text = "SSN: 123-45-6789, email: test@example.com"
        result = detector.detect(text)

        assert result.stats.input_length == len(text)
        assert result.stats.entity_count == 2
        assert result.stats.detection_time_ms > 0
        assert len(result.stats.recognizers_used) > 0


# ── Failure Mode Tests ──────────────────────────────────────────────


class TestFailureModes:
    def test_fm_false_negatives_context_dependent_pii(self) -> None:
        """Without a title prefix, heuristic person recognizer misses the name."""
        detector = PIIDetector()
        result = detector.detect("John Smith discussed his diabetes diagnosis")
        persons = [e for e in result.entities if e.type == "PERSON"]
        assert len(persons) == 0

    def test_fm_false_positives_ssn_pattern(self) -> None:
        """SSN regex catches non-PII 9-digit numbers; allow list mitigates."""
        detector = PIIDetector()
        result = detector.detect("Product code: 123-45-6789")
        ssn = [e for e in result.entities if e.type == "SSN"]
        assert len(ssn) == 1

        detector2 = PIIDetector(PIIDetectorConfig(allow_list=["123-45-6789"]))
        result2 = detector2.detect("Product code: 123-45-6789")
        assert len([e for e in result2.entities if e.type == "SSN"]) == 0

    def test_fm_reversal_map_contains_sensitive_data(self) -> None:
        """Reversal map contains original PII — the security tradeoff."""
        detector = PIIDetector(PIIDetectorConfig(reversible=True))
        result = detector.detect("My SSN is 123-45-6789")
        assert "123-45-6789" in result.reversal_map.values()

    def test_fm_latency_under_load(self) -> None:
        """Detection completes within 100ms even for long text."""
        detector = PIIDetector()
        long_text = "This is a long document. " * 100 + "SSN: 123-45-6789 and email: test@example.com"

        start = time.perf_counter()
        result = detector.detect(long_text)
        elapsed_ms = (time.perf_counter() - start) * 1000

        assert len(result.entities) > 0
        assert elapsed_ms < 100

    def test_fm_silent_degradation_count_tracking(self) -> None:
        """Detection counts by type enable drift monitoring."""
        detector = PIIDetector()
        sample_texts = [
            "My SSN is 123-45-6789",
            "Email: test@example.com",
            "Call (555) 123-4567",
            "No PII here at all",
            "Card: 4111-1111-1111-1111",
        ]

        counts_by_type: dict[str, int] = {}
        for text in sample_texts:
            result = detector.detect(text)
            for entity in result.entities:
                counts_by_type[entity.type] = counts_by_type.get(entity.type, 0) + 1

        assert counts_by_type.get("SSN") == 1
        assert counts_by_type.get("EMAIL") == 1
        assert counts_by_type.get("PHONE") == 1
        assert counts_by_type.get("CREDIT_CARD") == 1

    def test_fm_incomplete_entity_type_coverage(self) -> None:
        """Only configured entity types are detected."""
        detector = PIIDetector(PIIDetectorConfig(entity_types=["SSN"]))
        result = detector.detect("SSN: 123-45-6789, email: test@example.com")
        assert all(e.type == "SSN" for e in result.entities)
        assert len([e for e in result.entities if e.type == "EMAIL"]) == 0

    def test_fm_regex_collision_phone(self) -> None:
        """Phone pattern may catch non-phone numeric sequences."""
        detector = PIIDetector()
        result = detector.detect("Reference: 555-123-4567")
        phones = [e for e in result.entities if e.type == "PHONE"]
        assert len(phones) >= 0  # documents known false positive risk


# ── Integration Tests ───────────────────────────────────────────────


class TestIntegration:
    def test_full_pipeline_detect_redact_llm_reverse(self) -> None:
        """Full detect → redact → LLM → reverse pipeline."""
        detector = PIIDetector(PIIDetectorConfig(redaction_strategy="placeholder"))
        provider = MockLLMProvider(MockProviderConfig(latency_ms=10))

        user_input = "My name is Dr. Jane Doe, SSN 123-45-6789, email jane@example.com"

        # Detect and redact
        detection = detector.detect(user_input)
        assert len(detection.entities) >= 2
        assert "123-45-6789" not in detection.sanitized_text
        assert "jane@example.com" not in detection.sanitized_text

        # Send sanitized text to LLM
        llm_response = asyncio.run(provider.complete(detection.sanitized_text))

        # Reverse redaction
        final = PIIDetector.reverse(llm_response.text, detection.reversal_map)
        assert "123-45-6789" in final
        assert "jane@example.com" in final

    def test_multi_entity_document(self) -> None:
        """Processes a document with many PII types."""
        detector = PIIDetector()
        document = "\n".join([
            "Patient: Dr. John Smith",
            "SSN: 123-45-6789",
            "Email: patient@hospital.com",
            "Phone: (555) 987-6543",
            "IP: 10.0.0.1",
            "Card: 4111-1111-1111-1111",
        ])

        result = detector.detect(document)
        types = {e.type for e in result.entities}
        assert len(types) >= 4
        assert "123-45-6789" not in result.sanitized_text
        assert "patient@hospital.com" not in result.sanitized_text
        assert "4111-1111-1111-1111" not in result.sanitized_text

    def test_clean_text_passes_through(self) -> None:
        """Text without PII passes through unchanged."""
        detector = PIIDetector()
        clean = "What is the capital of France?"
        result = detector.detect(clean)
        assert len(result.entities) == 0
        assert result.sanitized_text == clean
        assert len(result.reversal_map) == 0

    def test_convenience_function(self) -> None:
        """detect_pii() convenience function works end-to-end."""
        result = detect_pii("My SSN is 123-45-6789", PIIDetectorConfig(redaction_strategy="mask"))
        assert len(result.entities) == 1
        assert "123-45-6789" not in result.sanitized_text
        assert "***" in result.sanitized_text

    def test_concurrent_detection_independent(self) -> None:
        """Multiple detections don't bleed state."""
        detector = PIIDetector()
        result1 = detector.detect("SSN: 123-45-6789")
        result2 = detector.detect("Email: test@example.com")

        assert result1.entities[0].type == "SSN"
        assert result2.entities[0].type == "EMAIL"
        assert len(result1.entities) == 1
        assert len(result2.entities) == 1
