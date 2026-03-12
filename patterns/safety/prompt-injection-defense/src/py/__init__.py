"""
Prompt Injection Defense — Layered Defense Pipeline

Four-layer defense: input sanitizer → pattern detector → classifier → output scanner.
Each layer operates independently; the decision aggregator combines scores.

Framework-agnostic. Uses a pluggable classifier protocol so production deployments
can swap in Prompt Guard, a fine-tuned BERT, or any other ML backend.
"""

from __future__ import annotations

import re
import secrets
import string
import time
from dataclasses import dataclass, replace

from .defense_types import (
    BlockAction,
    DefenseMetrics,
    DetectionRule,
    InjectionClassifier,
    InjectionDefenseConfig,
    LayerScores,
    LayerWeights,
    ResolvedConfig,
    ScanResult,
    ScreenAction,
    ScreenInput,
    ScreenResult,
)

# ── Built-in Detection Rules ─────────────────────────────────────────

DEFAULT_RULES: list[DetectionRule] = [
    DetectionRule(
        id="ignore-previous",
        name="Ignore previous instructions",
        pattern=re.compile(
            r"ignore\s+(all\s+)?(previous|prior|above|preceding)\s+"
            r"(instructions?|rules?|prompts?|directives?)",
            re.IGNORECASE,
        ),
        severity=0.9,
        description="Classic direct injection attempting to override system prompt",
    ),
    DetectionRule(
        id="role-switch",
        name="Role switching attempt",
        pattern=re.compile(r"you\s+are\s+now\s+(a|an|the|my)\b", re.IGNORECASE),
        severity=0.85,
        description="Attempts to reassign the model's role",
    ),
    DetectionRule(
        id="system-prompt-extract",
        name="System prompt extraction",
        pattern=re.compile(
            r"(output|print|show|display|repeat|reveal)\s+(your\s+)?"
            r"(system\s+prompt|instructions?|rules?|initial\s+prompt)",
            re.IGNORECASE,
        ),
        severity=0.9,
        description="Attempts to extract the system prompt",
    ),
    DetectionRule(
        id="delimiter-escape",
        name="Delimiter escape attempt",
        pattern=re.compile(
            r"(```|</?system>|</?user>|</?assistant>|\[INST\]|\[/INST\]|<<SYS>>)",
            re.IGNORECASE,
        ),
        severity=0.7,
        description="Attempts to break out of content delimiters",
    ),
    DetectionRule(
        id="new-instructions",
        name="New instruction injection",
        pattern=re.compile(
            r"(new|updated|revised|override|replacement)\s+"
            r"(instructions?|rules?|directives?|system\s*prompt)\s*[:=]",
            re.IGNORECASE,
        ),
        severity=0.85,
        description="Attempts to inject new instructions",
    ),
    DetectionRule(
        id="encoding-evasion",
        name="Base64/encoding evasion",
        pattern=re.compile(r"(?:base64|atob|decode|eval)\s*\(", re.IGNORECASE),
        severity=0.6,
        description="Attempts to use encoding to hide injection payload",
    ),
    DetectionRule(
        id="do-anything-now",
        name="DAN-style jailbreak",
        pattern=re.compile(
            r"\b(DAN|do\s+anything\s+now|jailbreak|unlocked\s+mode)\b", re.IGNORECASE
        ),
        severity=0.95,
        description="Known jailbreak template patterns",
    ),
    DetectionRule(
        id="markdown-exfil",
        name="Markdown image exfiltration setup",
        pattern=re.compile(r"!\[.*?\]\(https?://[^)]*\{.*?\}[^)]*\)", re.IGNORECASE),
        severity=0.8,
        description="Attempts to set up data exfiltration via markdown images",
    ),
]

# ── Default Configuration ────────────────────────────────────────────

_DEFAULT_CONFIG = ResolvedConfig(
    block_threshold=0.85,
    flag_threshold=0.5,
    max_input_length=10_000,
    enable_classifier=True,
    enable_output_scan=True,
    enable_canary_tokens=True,
    pattern_rules=list(DEFAULT_RULES),
    layer_weights=LayerWeights(),
    on_block=BlockAction.REJECT,
)


# ── Built-in Heuristic Classifier ───────────────────────────────────

# Regex patterns compiled once at module level for the heuristic classifier
_ROLEPLAY_RE = re.compile(
    r"\b(you are|act as|pretend to be|roleplay as|simulate)\b", re.IGNORECASE
)
_META_RE = re.compile(
    r"\b(system message|developer mode|training data|behind the scenes)\b", re.IGNORECASE
)
_IMPERATIVE_RE = re.compile(
    r"\b(do|don't|never|always|must|output|print|show|reveal|tell|give|send)\b", re.IGNORECASE
)
_INSTRUCTION_WORDS = [
    "ignore", "override", "forget", "disregard", "instead",
    "new instructions", "system prompt", "you are now",
    "do not follow", "bypass", "pretend", "act as",
]


class HeuristicClassifier:
    """Heuristic injection classifier using multiple text signals.

    In production, swap this for a real ML model via the InjectionClassifier protocol.
    """

    async def classify(self, input_text: str) -> float:
        score = 0.0
        lower = input_text.lower()

        # Signal: instruction-like language density
        match_count = sum(1 for w in _INSTRUCTION_WORDS if w in lower)
        score += min(match_count * 0.15, 0.6)

        # Signal: role-play or persona switching
        if _ROLEPLAY_RE.search(input_text):
            score += 0.25

        # Signal: meta-conversation references
        if _META_RE.search(input_text):
            score += 0.2

        # Signal: unusual non-ASCII ratio suggesting encoding evasion
        if input_text:
            ascii_printable = sum(1 for c in input_text if 0x20 <= ord(c) <= 0x7E)
            non_ascii_ratio = 1.0 - (ascii_printable / len(input_text))
            if non_ascii_ratio > 0.3:
                score += 0.15

        # Signal: high ratio of imperative verbs
        imperatives = _IMPERATIVE_RE.findall(input_text)
        word_count = len(input_text.split())
        if imperatives and word_count > 0 and len(imperatives) / word_count > 0.15:
            score += 0.2

        return min(score, 1.0)


# ── Sanitizer regexes (compiled once) ────────────────────────────────

_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_HOMOGLYPH_RE = re.compile(
    r"[\u0400-\u04ff\u2000-\u200f\u2028-\u202f\ufeff\u200b-\u200d]"
)
_BASE64_BLOCK_RE = re.compile(r"[A-Za-z0-9+/]{40,}={0,2}")


# ── Output scan regexes (compiled once) ──────────────────────────────

_IMG_PATTERN_RE = re.compile(r"!\[([^\]]*)\]\((https?://[^)]+)\)")
_URL_PATTERN_RE = re.compile(r"https?://[^\s)]+")
_ENCODED_URL_RE = re.compile(r"[?&][^=]+=([A-Za-z0-9+/]{20,}={0,2})")
_SYSTEM_PROMPT_LEAK_RE = re.compile(r"\b(system\s*prompt|instructions?)\s*:", re.IGNORECASE)


# ── Main Defense Pipeline ────────────────────────────────────────────

class InjectionDefense:
    """Layered prompt injection defense pipeline.

    Screens user input through sanitizer, pattern detector, and classifier layers,
    then aggregates scores to produce an allow/flag/block decision.
    """

    def __init__(
        self,
        config: InjectionDefenseConfig | None = None,
        classifier: InjectionClassifier | None = None,
    ) -> None:
        self._config = self._resolve_config(config or InjectionDefenseConfig())
        self._classifier: InjectionClassifier = classifier or HeuristicClassifier()
        self._metrics = DefenseMetrics()

    async def screen(self, input_data: ScreenInput) -> ScreenResult:
        """Run the full defense pipeline on user input."""
        start = time.perf_counter()
        flagged_patterns: list[str] = []

        # Layer 1: Input sanitizer (deterministic)
        sanitizer_score = self._run_sanitizer(input_data.user_input)

        # Short-circuit on length violation
        if len(input_data.user_input) > self._config.max_input_length:
            result = self._build_result(
                LayerScores(sanitizer=1.0, pattern=0.0, classifier=0.0, combined=1.0),
                ["input-too-long"],
                start,
                input_data.system_prompt,
            )
            self._record_metric(result)
            return result

        # Layer 2: Pattern detector (rule-based)
        pattern_score, matched = self._run_pattern_detector(input_data.user_input)
        flagged_patterns.extend(matched)

        # Layer 3: Classifier (ML-based or heuristic)
        classifier_score = 0.0
        if self._config.enable_classifier:
            try:
                classifier_score = await self._classifier.classify(input_data.user_input)
            except Exception:
                # Classifier failure doesn't block — other layers still defend.
                self._metrics.classifier_timeouts += 1

        # Combine scores: weighted average as baseline, but a single high-confidence
        # layer can override to prevent dilution by zero scores elsewhere.
        w = self._config.layer_weights
        weighted_avg = (
            sanitizer_score * w.sanitizer
            + pattern_score * w.pattern
            + classifier_score * w.classifier
        )
        max_layer_score = max(sanitizer_score, pattern_score, classifier_score)
        combined = max(weighted_avg, max_layer_score)

        scores = LayerScores(
            sanitizer=sanitizer_score,
            pattern=pattern_score,
            classifier=classifier_score,
            combined=combined,
        )

        result = self._build_result(scores, flagged_patterns, start, input_data.system_prompt)
        self._record_metric(result)
        return result

    def scan_output(self, output: str, canary_token: str | None = None) -> ScanResult:
        """Scan LLM output for post-generation attack indicators."""
        suspicious: list[str] = []
        exfiltration_risk = 0.0
        canary_leaked = False

        # Canary token leakage
        if canary_token and canary_token in output:
            canary_leaked = True
            suspicious.append("canary-token-leaked")
            exfiltration_risk = 1.0
            self._metrics.canary_leaks += 1

        # Markdown image exfiltration
        for m in _IMG_PATTERN_RE.finditer(output):
            url = m.group(2)
            if re.search(r"[?&](data|d|q|payload)=", url, re.IGNORECASE) or len(url) > 200:
                suspicious.append(f"markdown-image-exfil: {url[:80]}")
                exfiltration_risk = max(exfiltration_risk, 0.8)

        # URLs with suspiciously encoded query params
        for m in _URL_PATTERN_RE.finditer(output):
            url = m.group(0)
            if _ENCODED_URL_RE.search(url):
                suspicious.append(f"encoded-url-exfil: {url[:80]}")
                exfiltration_risk = max(exfiltration_risk, 0.7)

        # System prompt content patterns
        if _SYSTEM_PROMPT_LEAK_RE.search(output) and len(output) > 500:
            suspicious.append("possible-system-prompt-leak")
            exfiltration_risk = max(exfiltration_risk, 0.5)

        return ScanResult(
            clean=len(suspicious) == 0,
            canary_leaked=canary_leaked,
            suspicious_patterns=suspicious,
            exfiltration_risk=exfiltration_risk,
        )

    def update_rules(self, rules: list[DetectionRule]) -> None:
        """Replace detection rules without redeployment."""
        self._config.pattern_rules = rules

    def add_rules(self, rules: list[DetectionRule]) -> None:
        """Add rules to the existing set."""
        self._config.pattern_rules = [*self._config.pattern_rules, *rules]

    def get_metrics(self) -> DefenseMetrics:
        """Return a copy of current defense metrics."""
        return replace(self._metrics)

    def reset_metrics(self) -> None:
        """Reset all metric counters."""
        self._metrics = DefenseMetrics()

    # ── Layer Implementations ──────────────────────────────────────────

    def _run_sanitizer(self, text: str) -> float:
        """Layer 1: Deterministic sanitization checks."""
        score = 0.0

        # Null bytes / control characters
        control_chars = _CONTROL_CHARS_RE.findall(text)
        if control_chars:
            score += min(len(control_chars) * 0.1, 0.5)

        # Unicode homoglyph abuse
        homoglyphs = _HOMOGLYPH_RE.findall(text)
        if len(homoglyphs) > 3:
            score += 0.3

        # Base64-encoded blocks that might hide instructions
        base64_blocks = _BASE64_BLOCK_RE.findall(text)
        if base64_blocks:
            score += min(len(base64_blocks) * 0.2, 0.5)

        # Excessive length signal
        if len(text) > self._config.max_input_length * 0.8:
            score += 0.1

        return min(score, 1.0)

    def _run_pattern_detector(self, text: str) -> tuple[float, list[str]]:
        """Layer 2: Pattern-based detection using configurable rules."""
        matched: list[str] = []
        max_severity = 0.0
        for rule in self._config.pattern_rules:
            if rule.pattern.search(text):
                matched.append(rule.id)
                max_severity = max(max_severity, rule.severity)

        # Multiple low-severity matches together can indicate a sophisticated attack
        multi_match_bonus = min((len(matched) - 1) * 0.1, 0.3) if len(matched) > 1 else 0.0
        score = min(max_severity + multi_match_bonus, 1.0)
        return score, matched

    # ── Helpers ────────────────────────────────────────────────────────

    def _build_result(
        self,
        scores: LayerScores,
        flagged_patterns: list[str],
        start_time: float,
        system_prompt: str | None,
    ) -> ScreenResult:
        combined = scores.combined
        if combined >= self._config.block_threshold:
            action = ScreenAction.BLOCK
        elif combined >= self._config.flag_threshold:
            action = ScreenAction.FLAG
        else:
            action = ScreenAction.ALLOW

        result = ScreenResult(
            allowed=action != ScreenAction.BLOCK,
            action=action,
            scores=scores,
            flagged_patterns=flagged_patterns,
            latency_ms=(time.perf_counter() - start_time) * 1000.0,
        )

        # Inject canary token if enabled and system prompt is present
        if self._config.enable_canary_tokens and system_prompt:
            result.canary_token = self._generate_canary_token()

        return result

    @staticmethod
    def _generate_canary_token() -> str:
        """High-entropy token unlikely to appear in normal output."""
        alphabet = string.ascii_letters + string.digits
        suffix = "".join(secrets.choice(alphabet) for _ in range(24))
        return f"CANARY_{suffix}"

    def _record_metric(self, result: ScreenResult) -> None:
        self._metrics.total_screened += 1
        if result.action == ScreenAction.BLOCK:
            self._metrics.blocked += 1
        elif result.action == ScreenAction.FLAG:
            self._metrics.flagged += 1
        else:
            self._metrics.allowed += 1

        # Rolling average latency
        self._metrics.avg_latency_ms += (
            (result.latency_ms - self._metrics.avg_latency_ms)
            / self._metrics.total_screened
        )

    @staticmethod
    def _resolve_config(user_config: InjectionDefenseConfig) -> ResolvedConfig:
        return ResolvedConfig(
            block_threshold=user_config.block_threshold if user_config.block_threshold is not None else _DEFAULT_CONFIG.block_threshold,
            flag_threshold=user_config.flag_threshold if user_config.flag_threshold is not None else _DEFAULT_CONFIG.flag_threshold,
            max_input_length=user_config.max_input_length if user_config.max_input_length is not None else _DEFAULT_CONFIG.max_input_length,
            enable_classifier=user_config.enable_classifier if user_config.enable_classifier is not None else _DEFAULT_CONFIG.enable_classifier,
            enable_output_scan=user_config.enable_output_scan if user_config.enable_output_scan is not None else _DEFAULT_CONFIG.enable_output_scan,
            enable_canary_tokens=user_config.enable_canary_tokens if user_config.enable_canary_tokens is not None else _DEFAULT_CONFIG.enable_canary_tokens,
            pattern_rules=user_config.pattern_rules if user_config.pattern_rules is not None else list(_DEFAULT_CONFIG.pattern_rules),
            layer_weights=user_config.layer_weights if user_config.layer_weights is not None else LayerWeights(),
            on_block=user_config.on_block if user_config.on_block is not None else _DEFAULT_CONFIG.on_block,
        )


__all__ = [
    "InjectionDefense",
    "HeuristicClassifier",
    "DEFAULT_RULES",
    "BlockAction",
    "DefenseMetrics",
    "DetectionRule",
    "InjectionClassifier",
    "InjectionDefenseConfig",
    "LayerScores",
    "LayerWeights",
    "ResolvedConfig",
    "ScanResult",
    "ScreenAction",
    "ScreenInput",
    "ScreenResult",
]
