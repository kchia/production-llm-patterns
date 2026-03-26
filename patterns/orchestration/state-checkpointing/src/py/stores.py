from __future__ import annotations

import copy

from .types import CheckpointStore, WorkflowCheckpoint


class InMemoryCheckpointStore(CheckpointStore):
    """
    In-memory checkpoint store for testing and development.

    Does NOT survive process restarts. For production, replace with a
    RedisCheckpointStore or PostgresCheckpointStore. The interface is
    identical — only the store implementation changes.
    """

    def __init__(self) -> None:
        self._store: dict[str, WorkflowCheckpoint] = {}

    async def save(self, workflow_id: str, checkpoint: WorkflowCheckpoint) -> None:
        # Deep copy on write to prevent external mutation of stored state.
        # In a real store this is handled by serialization (to Redis, Postgres, etc.)
        self._store[workflow_id] = copy.deepcopy(checkpoint)

    async def load(self, workflow_id: str) -> WorkflowCheckpoint | None:
        checkpoint = self._store.get(workflow_id)
        if checkpoint is None:
            return None
        return copy.deepcopy(checkpoint)

    async def clear(self, workflow_id: str) -> None:
        self._store.pop(workflow_id, None)

    def size(self) -> int:
        return len(self._store)

    def keys(self) -> list[str]:
        return list(self._store.keys())
