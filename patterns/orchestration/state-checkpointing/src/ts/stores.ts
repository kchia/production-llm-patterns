import { CheckpointStore, WorkflowCheckpoint } from "./types.js";

/**
 * In-memory checkpoint store for testing and development.
 *
 * Does NOT survive process restarts. For production, replace with a
 * RedisCheckpointStore or PostgresCheckpointStore that persists to durable storage.
 * The interface is the same — the store is the only thing that changes.
 */
export class InMemoryCheckpointStore implements CheckpointStore {
  private store = new Map<string, WorkflowCheckpoint>();

  async save(workflowId: string, checkpoint: WorkflowCheckpoint): Promise<void> {
    // Deep clone on write to prevent external mutation of stored state.
    // In a real store this is handled by serialization (JSON to Redis, etc.)
    this.store.set(workflowId, JSON.parse(JSON.stringify(checkpoint)));
  }

  async load(workflowId: string): Promise<WorkflowCheckpoint | null> {
    const checkpoint = this.store.get(workflowId);
    if (!checkpoint) return null;
    // Return a clone to prevent callers from mutating internal state
    return JSON.parse(JSON.stringify(checkpoint));
  }

  async clear(workflowId: string): Promise<void> {
    this.store.delete(workflowId);
  }

  // Utility for tests: inspect store size without exposing internals
  size(): number {
    return this.store.size;
  }

  // Utility for tests: list all workflow IDs in the store
  keys(): string[] {
    return Array.from(this.store.keys());
  }
}
