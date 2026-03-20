"""Tests for Context Management pattern — Python implementation."""

from __future__ import annotations

import pytest
from .. import ContextManager, create_mock_tokenizer, create_mock_summarizer
from ..types import ContextConfig
from ..mock_provider import MockTokenizer


# ─── Helpers ──────────────────────────────────────────────────────────────────

def make_manager(**kwargs) -> ContextManager:
    defaults = dict(max_tokens=1_000, reserve_for_output=100)
    defaults.update(kwargs)
    return ContextManager(config=ContextConfig(**defaults))


def add_n(manager: ContextManager, n: int, role: str = "user") -> None:
    for i in range(n):
        manager.add(role=role, content=f"Message {i} with some content that takes up tokens in the window.")


# ─── Unit Tests: Configuration ────────────────────────────────────────────────

class TestConfiguration:
    def test_default_config(self):
        manager = ContextManager()
        config = manager.config
        assert config.max_tokens == 128_000
        assert config.reserve_for_output == 4_000
        assert config.strategy == "sliding-window"
        assert config.keep_recent == 10

    def test_partial_config_override(self):
        manager = ContextManager(config=ContextConfig(max_tokens=32_000, strategy="priority"))
        config = manager.config
        assert config.max_tokens == 32_000
        assert config.strategy == "priority"
        assert config.reserve_for_output == 4_000  # default preserved

    def test_config_is_copy(self):
        manager = ContextManager(config=ContextConfig(max_tokens=10_000))
        config = manager.config
        config.max_tokens = 999  # mutate the copy
        assert manager.config.max_tokens == 10_000  # original unchanged


# ─── Unit Tests: add(), remove(), clear() ────────────────────────────────────

class TestHistoryManagement:
    def test_add_returns_id(self):
        manager = make_manager()
        msg_id = manager.add(role="user", content="Hello")
        assert isinstance(msg_id, str)
        assert len(msg_id) > 0

    def test_add_caches_token_count(self):
        manager = make_manager()
        manager.add(role="user", content="Hello world")
        history = manager.get_history()
        assert history[0].tokens is not None
        assert history[0].tokens > 0

    def test_remove_by_id(self):
        manager = make_manager()
        msg_id = manager.add(role="user", content="Remove me")
        assert len(manager.get_history()) == 1
        result = manager.remove(msg_id)
        assert result is True
        assert len(manager.get_history()) == 0

    def test_remove_unknown_id_returns_false(self):
        manager = make_manager()
        assert manager.remove("nonexistent-id") is False

    def test_clear_empties_history(self):
        manager = make_manager()
        add_n(manager, 5)
        manager.clear()
        assert len(manager.get_history()) == 0

    def test_build_empty_history(self):
        manager = make_manager()
        window = manager.build()
        assert len(window.messages) == 0
        assert window.total_tokens == 0
        assert window.dropped_messages == 0


# ─── Unit Tests: Sliding Window ───────────────────────────────────────────────

class TestSlidingWindow:
    def test_keeps_all_when_within_budget(self):
        manager = make_manager(strategy="sliding-window")
        add_n(manager, 3)
        window = manager.build()
        assert len(window.messages) == 3
        assert window.dropped_messages == 0

    def test_preserves_system_messages(self):
        manager = make_manager(max_tokens=200, reserve_for_output=20, strategy="sliding-window")
        manager.add(role="system", content="You are a helpful assistant.")
        add_n(manager, 20)
        window = manager.build()
        system_msgs = [m for m in window.messages if m.role == "system"]
        assert len(system_msgs) == 1
        assert system_msgs[0].content == "You are a helpful assistant."

    def test_keeps_most_recent_messages(self):
        manager = make_manager(max_tokens=200, reserve_for_output=20, strategy="sliding-window")
        add_n(manager, 10)
        final_content = "This is the final most-recent message unique-xyz"
        manager.add(role="user", content=final_content)
        window = manager.build()
        last = window.messages[-1]
        assert last.content == final_content

    def test_total_tokens_within_budget(self):
        manager = make_manager(max_tokens=300, reserve_for_output=50, strategy="sliding-window")
        add_n(manager, 20)
        window = manager.build()
        assert window.total_tokens <= 250

    def test_budget_used_in_range(self):
        manager = make_manager(strategy="sliding-window")
        add_n(manager, 5)
        window = manager.build()
        assert 0 <= window.budget_used <= 1


# ─── Unit Tests: Priority Strategy ───────────────────────────────────────────

class TestPriorityStrategy:
    def test_preserves_system_messages(self):
        manager = make_manager(max_tokens=200, reserve_for_output=20, strategy="priority")
        manager.add(role="system", content="You are a helpful assistant.")
        add_n(manager, 15)
        window = manager.build()
        system_msgs = [m for m in window.messages if m.role == "system"]
        assert len(system_msgs) == 1

    def test_prefers_high_priority(self):
        manager = make_manager(max_tokens=200, reserve_for_output=20, strategy="priority")
        for i in range(5):
            manager.add(role="user", content=f"Low priority filler message {i} words here too", priority=0.1)
        high_content = "HIGH PRIORITY: critical instruction unique-abc"
        manager.add(role="user", content=high_content, priority=0.99)
        for i in range(5):
            manager.add(role="user", content=f"Another low priority {i} filler filler text", priority=0.1)

        window = manager.build()
        texts = [m.content for m in window.messages]
        assert high_content in texts

    def test_total_tokens_within_budget(self):
        manager = make_manager(max_tokens=300, reserve_for_output=50, strategy="priority")
        add_n(manager, 20)
        window = manager.build()
        assert window.total_tokens <= 250

    def test_original_order_preserved(self):
        manager = make_manager(max_tokens=500, reserve_for_output=50, strategy="priority")
        id1 = manager.add(role="user", content="First message priority 0.9 content words", priority=0.9)
        id2 = manager.add(role="assistant", content="Second message priority 0.8 reply here", priority=0.8)
        id3 = manager.add(role="user", content="Third message priority 0.7 question text", priority=0.7)

        window = manager.build()
        if window.dropped_messages == 0:
            assert window.messages[0].id == id1
            assert window.messages[1].id == id2
            assert window.messages[2].id == id3


# ─── Unit Tests: Summarize Strategy ──────────────────────────────────────────

class TestSummarizeStrategy:
    def test_preserves_system_messages(self):
        manager = make_manager(max_tokens=300, reserve_for_output=30, strategy="summarize", keep_recent=3)
        manager.add(role="system", content="System instructions here.")
        add_n(manager, 15)
        window = manager.build()
        system_msgs = [m for m in window.messages if m.role == "system"]
        assert len(system_msgs) == 1

    def test_keeps_recent_messages_verbatim(self):
        manager = make_manager(max_tokens=500, reserve_for_output=50, strategy="summarize", keep_recent=3)
        for i in range(5):
            manager.add(role="user", content=f"Old message {i} old content filler text words here")
        recent = ["Recent A unique first", "Recent B unique second", "Recent C unique third"]
        for content in recent:
            manager.add(role="assistant", content=content)

        window = manager.build()
        texts = [m.content for m in window.messages]
        for r in recent:
            keyword = r.split()[0]
            assert any(keyword in t for t in texts)

    def test_total_tokens_within_budget(self):
        manager = make_manager(max_tokens=300, reserve_for_output=30, strategy="summarize", keep_recent=4)
        add_n(manager, 20)
        window = manager.build()
        assert window.total_tokens <= 270


# ─── Unit Tests: reserveForOutput ────────────────────────────────────────────

class TestReserveForOutput:
    def test_available_budget_reduced(self):
        manager = make_manager(max_tokens=1000, reserve_for_output=200, strategy="sliding-window")
        add_n(manager, 50)
        window = manager.build()
        assert window.total_tokens <= 800

    def test_budget_used_relative_to_available(self):
        manager = make_manager(max_tokens=1000, reserve_for_output=200)
        manager.add(role="user", content="Short message")
        window = manager.build()
        assert window.budget_used < 0.1


# ─── Unit Tests: stats() ─────────────────────────────────────────────────────

class TestStats:
    def test_correct_count(self):
        manager = make_manager()
        manager.add(role="user", content="Hello")
        manager.add(role="assistant", content="World")
        stats = manager.stats()
        assert stats.total_messages == 2
        assert stats.total_tokens > 0

    def test_budget_used_positive(self):
        manager = make_manager(max_tokens=200, reserve_for_output=20)
        add_n(manager, 30)
        stats = manager.stats()
        assert stats.budget_used > 0


# ─── Failure Mode Tests ───────────────────────────────────────────────────────

class TestFailureModes:
    def test_system_prompt_never_evicted_sliding_window(self):
        manager = ContextManager(
            config=ContextConfig(max_tokens=50, reserve_for_output=10, strategy="sliding-window"),
            tokenizer=MockTokenizer(tokens_per_word=1.0),
        )
        manager.add(role="system", content="You are a helpful assistant.")
        for i in range(20):
            manager.add(role="user", content="Fill up the context window with text.")
        window = manager.build()
        system_msgs = [m for m in window.messages if m.role == "system"]
        assert len(system_msgs) >= 1

    def test_system_prompt_never_evicted_priority(self):
        manager = make_manager(max_tokens=100, reserve_for_output=10, strategy="priority")
        manager.add(role="system", content="You are a helpful assistant.", priority=0)
        add_n(manager, 20)
        window = manager.build()
        system_msgs = [m for m in window.messages if m.role == "system"]
        assert len(system_msgs) >= 1

    def test_tokenizer_error_propagates(self):
        error_tokenizer = MockTokenizer(error_rate=1.0)
        manager = ContextManager(config=ContextConfig(max_tokens=1_000), tokenizer=error_tokenizer)
        with pytest.raises(RuntimeError, match="simulated tokenization failure"):
            manager.add(role="user", content="test")

    def test_total_tokens_within_budget_sliding_window(self):
        manager = make_manager(max_tokens=500, reserve_for_output=50, strategy="sliding-window")
        add_n(manager, 40)
        window = manager.build()
        assert window.total_tokens <= 450

    def test_total_tokens_within_budget_priority(self):
        manager = make_manager(max_tokens=500, reserve_for_output=50, strategy="priority")
        add_n(manager, 40)
        window = manager.build()
        assert window.total_tokens <= 450

    def test_empty_history_no_error(self):
        manager = make_manager()
        window = manager.build()
        assert len(window.messages) == 0
        assert window.dropped_messages == 0
        assert window.budget_used == 0

    def test_only_system_messages(self):
        manager = make_manager(max_tokens=1_000, reserve_for_output=100)
        manager.add(role="system", content="System only.")
        window = manager.build()
        assert len(window.messages) == 1
        assert window.messages[0].role == "system"


# ─── Integration Tests ────────────────────────────────────────────────────────

class TestIntegration:
    def test_full_conversation_lifecycle(self):
        manager = ContextManager(
            config=ContextConfig(max_tokens=500, reserve_for_output=50, strategy="sliding-window"),
            tokenizer=create_mock_tokenizer(),
        )
        manager.add(role="system", content="You are a helpful assistant.")
        for turn in range(20):
            manager.add(role="user", content=f"User turn {turn}: ask a question about topic {turn}")
            manager.add(role="assistant", content=f"Assistant reply {turn}: here is the answer for topic {turn}")

        window = manager.build()
        system_msgs = [m for m in window.messages if m.role == "system"]
        assert len(system_msgs) == 1
        assert window.total_tokens <= 450
        assert window.dropped_messages > 0
        assert 0 < window.budget_used <= 1

    def test_build_is_deterministic(self):
        manager = make_manager(max_tokens=300, reserve_for_output=30, strategy="sliding-window")
        add_n(manager, 15)
        first = manager.build()
        second = manager.build()
        assert [m.id for m in first.messages] == [m.id for m in second.messages]
        assert first.total_tokens == second.total_tokens

    def test_strategy_comparison_both_within_budget(self):
        msgs = [
            ("user" if i % 2 == 0 else "assistant", f"Message {i} with some filler words for token counting", 0.5)
            for i in range(15)
        ]

        sw_manager = make_manager(max_tokens=300, reserve_for_output=30, strategy="sliding-window")
        prio_manager = make_manager(max_tokens=300, reserve_for_output=30, strategy="priority")

        for role, content, priority in msgs:
            sw_manager.add(role=role, content=content, priority=priority)
            prio_manager.add(role=role, content=content, priority=priority)

        sw_window = sw_manager.build()
        prio_window = prio_manager.build()

        assert sw_window.total_tokens <= 270
        assert prio_window.total_tokens <= 270
