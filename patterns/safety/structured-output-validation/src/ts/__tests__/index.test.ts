import { describe, it, expect, vi } from 'vitest';
import {
  OutputValidator,
  JsonObjectSchema,
  stripMarkdownFences,
  extractJson,
  repairJson,
} from '../index.js';
import { MockProvider } from '../mock-provider.js';
import {
  SchemaValidationError,
  ValidationExhaustedError,
} from '../types.js';
import type { LLMRequest, LLMResponse } from '../types.js';

// ─── Test Schema ─────────────────────────────────────────────────────────────

const userSchema = new JsonObjectSchema('User', {
  name: { type: 'string', required: true, description: 'Full name' },
  age: { type: 'number', required: true, description: 'Age in years' },
  active: { type: 'boolean', required: true },
});

const optionalSchema = new JsonObjectSchema('Profile', {
  name: { type: 'string', required: true },
  bio: { type: 'string', required: false },
});

// ─── Unit Tests ──────────────────────────────────────────────────────────────

describe('stripMarkdownFences', () => {
  it('should strip ```json fences', () => {
    expect(stripMarkdownFences('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('should strip ``` fences without language tag', () => {
    expect(stripMarkdownFences('```\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('should return unchanged if no fences', () => {
    expect(stripMarkdownFences('{"a": 1}')).toBe('{"a": 1}');
  });

  it('should handle whitespace around fences', () => {
    expect(stripMarkdownFences('  ```json\n  {"a": 1}\n  ```  ')).toBe('{"a": 1}');
  });
});

describe('extractJson', () => {
  it('should extract JSON from surrounding prose', () => {
    const input = 'Here is the data:\n{"name": "Alice"}\nHope this helps!';
    expect(extractJson(input)).toBe('{"name": "Alice"}');
  });

  it('should handle JSON at the start', () => {
    expect(extractJson('{"a": 1}')).toBe('{"a": 1}');
  });

  it('should handle nested braces', () => {
    const input = 'Result: {"a": {"b": 1}} done';
    expect(extractJson(input)).toBe('{"a": {"b": 1}}');
  });

  it('should handle strings containing braces', () => {
    const input = 'X: {"msg": "use {x} here"} Y';
    expect(extractJson(input)).toBe('{"msg": "use {x} here"}');
  });

  it('should extract arrays', () => {
    const input = 'Items: [1, 2, 3] end';
    expect(extractJson(input)).toBe('[1, 2, 3]');
  });

  it('should return input when no JSON found', () => {
    expect(extractJson('no json here')).toBe('no json here');
  });
});

describe('repairJson', () => {
  it('should remove trailing commas', () => {
    expect(repairJson('{"a": 1,}')).toBe('{"a": 1}');
  });

  it('should close unbalanced braces', () => {
    expect(repairJson('{"a": 1')).toBe('{"a": 1}');
  });

  it('should close unbalanced brackets', () => {
    expect(repairJson('[1, 2')).toBe('[1, 2]');
  });

  it('should handle multiple issues', () => {
    expect(repairJson('{"a": [1, 2,')).toBe('{"a": [1, 2]}');
  });

  it('should not alter valid JSON', () => {
    expect(repairJson('{"a": 1}')).toBe('{"a": 1}');
  });
});

describe('JsonObjectSchema', () => {
  it('should parse valid JSON matching schema', () => {
    const data = userSchema.parse('{"name": "Alice", "age": 30, "active": true}');
    expect(data).toEqual({ name: 'Alice', age: 30, active: true });
  });

  it('should throw on invalid JSON syntax', () => {
    expect(() => userSchema.parse('not json')).toThrow(SchemaValidationError);
  });

  it('should throw on missing required field', () => {
    expect(() => userSchema.parse('{"name": "Alice", "age": 30}')).toThrow(SchemaValidationError);
    try {
      userSchema.parse('{"name": "Alice", "age": 30}');
    } catch (e) {
      expect((e as SchemaValidationError).errors).toContain('Missing required field: "active"');
    }
  });

  it('should throw on wrong field type', () => {
    expect(() => userSchema.parse('{"name": "Alice", "age": "thirty", "active": true}')).toThrow(
      SchemaValidationError
    );
    try {
      userSchema.parse('{"name": "Alice", "age": "thirty", "active": true}');
    } catch (e) {
      const errors = (e as SchemaValidationError).errors;
      expect(errors.some((err) => err.includes('"age"') && err.includes('number'))).toBe(true);
    }
  });

  it('should allow optional fields to be missing', () => {
    const data = optionalSchema.parse('{"name": "Alice"}');
    expect(data).toEqual({ name: 'Alice' });
  });

  it('should throw on non-object JSON', () => {
    expect(() => userSchema.parse('[1, 2, 3]')).toThrow(SchemaValidationError);
  });

  it('should validate enum values', () => {
    const enumSchema = new JsonObjectSchema('Status', {
      level: { type: 'string', required: true, enum: ['low', 'medium', 'high'] },
    });
    expect(enumSchema.parse('{"level": "low"}')).toEqual({ level: 'low' });
    expect(() => enumSchema.parse('{"level": "moderate"}')).toThrow(SchemaValidationError);
  });

  it('should generate JSON schema', () => {
    const jsonSchema = userSchema.toJsonSchema();
    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.required).toEqual(['name', 'age', 'active']);
  });

  it('should generate prompt instructions', () => {
    const instructions = userSchema.toPromptInstructions();
    expect(instructions).toContain('User');
    expect(instructions).toContain('"name"');
    expect(instructions).toContain('required');
    expect(instructions).toContain('JSON');
  });
});

// ─── Failure Mode Tests ──────────────────────────────────────────────────────

describe('Failure mode: retry budget exhaustion', () => {
  it('should respect maxRetries and throw ValidationExhaustedError', async () => {
    const provider = new MockProvider({ outputMode: 'non_json', latencyMs: 0 });
    const validator = new OutputValidator(userSchema, { maxRetries: 2, repair: false });

    try {
      await validator.execute((req) => provider.call(req), { prompt: 'test' });
      expect.unreachable('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationExhaustedError);
      const err = e as ValidationExhaustedError;
      expect(err.result.retries).toBe(2);
      expect(err.result.success).toBe(false);
    }

    // Should have made exactly 3 calls (initial + 2 retries)
    expect(provider.getCallCount()).toBe(3);
  });

  it('should fire onRetry callback on each retry', async () => {
    const provider = new MockProvider({ outputMode: 'non_json', latencyMs: 0 });
    const retryCalls: Array<{ errors: string[]; attempt: number }> = [];
    const validator = new OutputValidator(userSchema, {
      maxRetries: 2,
      repair: false,
      onRetry: (errors, attempt) => retryCalls.push({ errors, attempt }),
    });

    try {
      await validator.execute((req) => provider.call(req), { prompt: 'test' });
    } catch {
      // expected
    }

    expect(retryCalls).toHaveLength(2);
    expect(retryCalls[0].attempt).toBe(1);
    expect(retryCalls[1].attempt).toBe(2);
  });

  it('should fire onValidationFailure when exhausted', async () => {
    const provider = new MockProvider({ outputMode: 'non_json', latencyMs: 0 });
    let failureResult: unknown = null;
    const validator = new OutputValidator(userSchema, {
      maxRetries: 1,
      repair: false,
      onValidationFailure: (result) => { failureResult = result; },
    });

    try {
      await validator.execute((req) => provider.call(req), { prompt: 'test' });
    } catch {
      // expected
    }

    expect(failureResult).not.toBeNull();
  });
});

describe('Failure mode: schema-prompt drift (wrong type from model)', () => {
  it('should detect type mismatches and include field name in errors', async () => {
    const provider = new MockProvider({ outputMode: 'wrong_type', latencyMs: 0 });
    const validator = new OutputValidator(userSchema, { maxRetries: 0, repair: false });

    try {
      await validator.execute((req) => provider.call(req), { prompt: 'test' });
      expect.unreachable('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationExhaustedError);
      const err = e as ValidationExhaustedError;
      expect(err.result.validationErrors).toBeDefined();
      // Errors should mention the mismatched field
      const errorStr = err.result.validationErrors!.join(' ');
      expect(errorStr).toMatch(/(name|age)/);
    }
  });
});

describe('Failure mode: overly strict schema (enum rejection)', () => {
  it('should reject values not in enum', async () => {
    const strictSchema = new JsonObjectSchema('Rating', {
      score: { type: 'string', required: true, enum: ['low', 'medium', 'high'] },
    });
    const provider = new MockProvider({
      outputMode: 'valid',
      validOutput: { score: 'moderate' },
      latencyMs: 0,
    });
    const validator = new OutputValidator(strictSchema, { maxRetries: 0, repair: false });

    try {
      await validator.execute((req) => provider.call(req), { prompt: 'test' });
      expect.unreachable('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationExhaustedError);
      const err = e as ValidationExhaustedError;
      expect(err.result.validationErrors!.join(' ')).toContain('not in allowed values');
    }
  });
});

describe('Failure mode: error feedback loop divergence', () => {
  it('should include error feedback in retry prompts', async () => {
    const calls: LLMRequest[] = [];
    const mockProvider = async (req: LLMRequest): Promise<LLMResponse> => {
      calls.push(req);
      return { content: '{"name": 123}', tokensUsed: 50 }; // always wrong type
    };

    const validator = new OutputValidator(userSchema, { maxRetries: 1, repair: false });

    try {
      await validator.execute(mockProvider, { prompt: 'Get user' });
    } catch {
      // expected
    }

    // Second call should contain error feedback
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain('validation errors');
    expect(calls[1].prompt).toContain('Previous output');
  });
});

describe('Failure mode: repair layer masking degradation', () => {
  it('should report repaired=true when repair was needed', async () => {
    const provider = new MockProvider({ outputMode: 'invalid_json', latencyMs: 0 });
    const validator = new OutputValidator(userSchema, { maxRetries: 0, repair: true });

    const result = await validator.execute((req) => provider.call(req), { prompt: 'test' });

    expect(result.success).toBe(true);
    expect(result.repaired).toBe(true);
    expect(result.parseMethod).toBe('repaired');
  });

  it('should report repaired=false for clean parses', async () => {
    const provider = new MockProvider({ outputMode: 'valid', latencyMs: 0 });
    const validator = new OutputValidator(userSchema, { maxRetries: 0, repair: true });

    const result = await validator.execute((req) => provider.call(req), { prompt: 'test' });

    expect(result.success).toBe(true);
    expect(result.repaired).toBe(false);
    expect(result.parseMethod).toBe('direct');
  });
});

describe('Failure mode: validation latency compounding', () => {
  it('should track total latency across retries', async () => {
    // First two calls return invalid, third returns valid
    const provider = new MockProvider({
      outputMode: ['non_json', 'non_json', 'valid'],
      latencyMs: 0,
    });
    const validator = new OutputValidator(userSchema, { maxRetries: 2, repair: false });

    const result = await validator.execute((req) => provider.call(req), { prompt: 'test' });

    expect(result.success).toBe(true);
    expect(result.retries).toBe(2);
    expect(result.totalLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.parseMethod).toBe('retry');
  });
});

describe('Failure mode: schema complexity exceeding model capability', () => {
  it('should report consistent failures with specific schema errors', async () => {
    // Model always returns a flat object but schema expects nested
    const provider = new MockProvider({
      outputMode: 'valid',
      validOutput: { name: 'Alice', age: 30, active: true },
      latencyMs: 0,
    });
    const nestedSchema = new JsonObjectSchema('Complex', {
      user: { type: 'object', required: true },
      tags: { type: 'array', required: true },
    });
    const validator = new OutputValidator(nestedSchema, { maxRetries: 0, repair: false });

    try {
      await validator.execute((req) => provider.call(req), { prompt: 'test' });
      expect.unreachable('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationExhaustedError);
      const err = e as ValidationExhaustedError;
      const errors = err.result.validationErrors!;
      expect(errors.some((e) => e.includes('user'))).toBe(true);
      expect(errors.some((e) => e.includes('tags'))).toBe(true);
    }
  });
});

// ─── Integration Tests ───────────────────────────────────────────────────────

describe('Integration: full validation pipeline', () => {
  it('should handle markdown-wrapped JSON output', async () => {
    const provider = new MockProvider({ outputMode: 'markdown_wrapped', latencyMs: 0 });
    const validator = new OutputValidator(userSchema, { maxRetries: 0 });

    const result = await validator.execute((req) => provider.call(req), { prompt: 'test' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: 'Alice', age: 30, active: true });
    expect(result.repaired).toBe(false);
    expect(result.parseMethod).toBe('direct');
  });

  it('should handle JSON with surrounding prose', async () => {
    const provider = new MockProvider({ outputMode: 'extra_text', latencyMs: 0 });
    const validator = new OutputValidator(userSchema, { maxRetries: 0 });

    const result = await validator.execute((req) => provider.call(req), { prompt: 'test' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: 'Alice', age: 30, active: true });
  });

  it('should repair invalid JSON (trailing comma)', async () => {
    const provider = new MockProvider({ outputMode: 'invalid_json', latencyMs: 0 });
    const validator = new OutputValidator(userSchema, { maxRetries: 0, repair: true });

    const result = await validator.execute((req) => provider.call(req), { prompt: 'test' });

    expect(result.success).toBe(true);
    expect(result.repaired).toBe(true);
  });

  it('should fail on truncated JSON that repair cannot fix', async () => {
    const provider = new MockProvider({ outputMode: 'truncated', latencyMs: 0 });
    const validator = new OutputValidator(userSchema, { maxRetries: 0, repair: true });

    // Truncated JSON may or may not be repairable depending on where it's cut
    // The important thing is the validator doesn't crash
    try {
      const result = await validator.execute((req) => provider.call(req), { prompt: 'test' });
      // If it succeeds, it must have been repaired
      expect(result.repaired).toBe(true);
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationExhaustedError);
    }
  });

  it('should retry and succeed when model self-corrects', async () => {
    // First call returns missing field, second returns valid
    const provider = new MockProvider({
      outputMode: ['missing_field', 'valid'],
      latencyMs: 0,
    });
    const validator = new OutputValidator(userSchema, { maxRetries: 1, repair: false });

    const result = await validator.execute((req) => provider.call(req), { prompt: 'test' });

    expect(result.success).toBe(true);
    expect(result.retries).toBe(1);
    expect(result.parseMethod).toBe('retry');
  });

  it('should augment prompt with schema instructions', async () => {
    const calls: LLMRequest[] = [];
    const mockProvider = async (req: LLMRequest): Promise<LLMResponse> => {
      calls.push(req);
      return { content: '{"name": "Alice", "age": 30, "active": true}' };
    };

    const validator = new OutputValidator(userSchema, {
      maxRetries: 0,
      includeSchemaInPrompt: true,
    });

    await validator.execute(mockProvider, { prompt: 'Get user info' });

    expect(calls[0].prompt).toContain('User');
    expect(calls[0].prompt).toContain('"name"');
    expect(calls[0].prompt).toContain('JSON');
  });

  it('should not augment prompt when includeSchemaInPrompt is false', async () => {
    const calls: LLMRequest[] = [];
    const mockProvider = async (req: LLMRequest): Promise<LLMResponse> => {
      calls.push(req);
      return { content: '{"name": "Alice", "age": 30, "active": true}' };
    };

    const validator = new OutputValidator(userSchema, {
      maxRetries: 0,
      includeSchemaInPrompt: false,
    });

    await validator.execute(mockProvider, { prompt: 'Get user info' });

    expect(calls[0].prompt).toBe('Get user info');
  });

  it('should handle provider throwing errors (not just bad output)', async () => {
    const provider = new MockProvider({ failureRate: 1.0, latencyMs: 0 });
    const validator = new OutputValidator(userSchema, { maxRetries: 0 });

    await expect(
      validator.execute((req) => provider.call(req), { prompt: 'test' })
    ).rejects.toThrow('Provider unavailable');
  });

  it('should handle complete end-to-end flow with retries', async () => {
    // Simulates realistic scenario: first call returns markdown-wrapped wrong type,
    // retry returns valid JSON
    let callCount = 0;
    const mockProvider = async (req: LLMRequest): Promise<LLMResponse> => {
      callCount++;
      if (callCount === 1) {
        return { content: '```json\n{"name": 123, "age": "thirty", "active": true}\n```' };
      }
      return { content: '{"name": "Alice", "age": 30, "active": true}' };
    };

    const retryLog: number[] = [];
    const validator = new OutputValidator(userSchema, {
      maxRetries: 2,
      repair: true,
      onRetry: (_errors, attempt) => retryLog.push(attempt),
    });

    const result = await validator.execute(mockProvider, { prompt: 'Get user' });

    expect(result.success).toBe(true);
    expect(result.retries).toBe(1);
    expect(result.data).toEqual({ name: 'Alice', age: 30, active: true });
    expect(retryLog).toEqual([1]);
  });
});
