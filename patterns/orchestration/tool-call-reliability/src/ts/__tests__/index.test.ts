import { describe, it, expect, vi } from 'vitest';
import { ToolCallValidator, ToolCallValidationError } from '../index.js';
import { MockLLMProvider } from '../mock-provider.js';
import type { ToolSchema, Message } from '../types.js';

// --- Shared test fixtures ---

const weatherTool: ToolSchema = {
  name: 'get_weather',
  description: 'Get current weather for a city',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
      units: { type: 'string', enum: ['celsius', 'fahrenheit'] },
      include_forecast: { type: 'boolean' },
      days: { type: 'integer', minimum: 1, maximum: 7 },
    },
    required: ['city'],
  },
};

const searchTool: ToolSchema = {
  name: 'search',
  description: 'Search for information',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer' },
    },
    required: ['query'],
  },
};

const tools = [weatherTool, searchTool];

const baseMessages: Message[] = [
  { role: 'user', content: 'What is the weather in Seattle?' },
];

// --- Unit Tests ---

describe('ToolCallValidator — unit tests', () => {
  describe('valid tool calls', () => {
    it('accepts a well-formed tool call', async () => {
      const provider = new MockLLMProvider({
        scenarios: [{ type: 'valid-call', toolName: 'get_weather', args: { city: 'Seattle' } }],
      });
      const validator = new ToolCallValidator(provider);

      const result = await validator.validate(
        { id: 'call_1', name: 'get_weather', arguments: JSON.stringify({ city: 'Seattle' }) },
        tools,
        baseMessages,
      );

      expect(result.valid).toBe(true);
      expect(result.toolName).toBe('get_weather');
      expect(result.arguments).toEqual({ city: 'Seattle' });
      expect(result.repairAttempts).toBe(0);
    });

    it('accepts arguments already parsed as an object', async () => {
      const provider = new MockLLMProvider();
      const validator = new ToolCallValidator(provider);

      const result = await validator.validate(
        { id: 'call_1', name: 'get_weather', arguments: { city: 'Portland' } },
        tools,
        baseMessages,
      );

      expect(result.valid).toBe(true);
      expect(result.arguments.city).toBe('Portland');
    });

    it('accepts valid enum values', async () => {
      const provider = new MockLLMProvider();
      const validator = new ToolCallValidator(provider, { schemaStrictness: 'all' });

      const result = await validator.validate(
        { id: 'call_1', name: 'get_weather', arguments: { city: 'Seattle', units: 'celsius' } },
        tools,
        baseMessages,
      );

      expect(result.valid).toBe(true);
    });

    it('accepts all-field validation when all fields are correct types', async () => {
      const provider = new MockLLMProvider();
      const validator = new ToolCallValidator(provider, { schemaStrictness: 'all' });

      const result = await validator.validate(
        {
          id: 'call_1',
          name: 'get_weather',
          arguments: { city: 'Seattle', units: 'celsius', include_forecast: true, days: 3 },
        },
        tools,
        baseMessages,
      );

      expect(result.valid).toBe(true);
    });
  });

  describe('schema validation', () => {
    it('rejects missing required fields', async () => {
      const provider = new MockLLMProvider({
        scenarios: [{ type: 'api-error', message: 'should not be called for immediate failures' }],
        // Won't actually be called because repair loop kicks in
      });

      const repairProvider = new MockLLMProvider({
        scenarios: [
          { type: 'api-error', message: 'repair exhausted' },
        ],
      });

      const validator = new ToolCallValidator(repairProvider, {
        maxRepairAttempts: 0,
        onRepairFailure: 'return-error',
      });

      const result = await validator.validate(
        { id: 'call_1', name: 'get_weather', arguments: '{}' },
        tools,
        baseMessages,
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some((e) => e.field === 'city')).toBe(true);
    });

    it('rejects wrong type for a field', async () => {
      const validator = new ToolCallValidator(new MockLLMProvider(), {
        maxRepairAttempts: 0,
        schemaStrictness: 'all',
        onRepairFailure: 'return-error',
      });

      const result = await validator.validate(
        // 'city' should be string but model passed number
        { id: 'call_1', name: 'get_weather', arguments: { city: 42 } },
        tools,
        baseMessages,
      );

      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field === 'city')).toBe(true);
    });

    it('rejects invalid enum values', async () => {
      const validator = new ToolCallValidator(new MockLLMProvider(), {
        maxRepairAttempts: 0,
        schemaStrictness: 'all',
        onRepairFailure: 'return-error',
      });

      const result = await validator.validate(
        { id: 'call_1', name: 'get_weather', arguments: { city: 'Seattle', units: 'kelvin' } },
        tools,
        baseMessages,
      );

      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field === 'units')).toBe(true);
    });

    it('rejects non-integer for integer field', async () => {
      const validator = new ToolCallValidator(new MockLLMProvider(), {
        maxRepairAttempts: 0,
        schemaStrictness: 'all',
        onRepairFailure: 'return-error',
      });

      const result = await validator.validate(
        { id: 'call_1', name: 'get_weather', arguments: { city: 'Seattle', days: 3.5 } },
        tools,
        baseMessages,
      );

      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field === 'days')).toBe(true);
    });

    it('does not validate optional fields when schemaStrictness is required-only', async () => {
      const validator = new ToolCallValidator(new MockLLMProvider(), {
        maxRepairAttempts: 0,
        schemaStrictness: 'required-only',
        onRepairFailure: 'return-error',
      });

      // 'units' is optional; pass wrong type — should still be valid in 'required-only' mode
      const result = await validator.validate(
        { id: 'call_1', name: 'get_weather', arguments: { city: 'Seattle', units: 123 } },
        tools,
        baseMessages,
      );

      expect(result.valid).toBe(true);
    });
  });

  describe('allowlist check', () => {
    it('rejects hallucinated tool names when strictAllowlist is true', async () => {
      const validator = new ToolCallValidator(new MockLLMProvider(), {
        strictAllowlist: true,
        onRepairFailure: 'return-error',
      });

      const result = await validator.validate(
        { id: 'call_1', name: 'hallucinated_tool', arguments: '{}' },
        tools,
        baseMessages,
      );

      expect(result.valid).toBe(false);
      expect(result.errors![0].field).toBe('name');
      // Allowlist failures do not trigger repair attempts
      expect(result.repairAttempts).toBe(0);
    });

    it('allows any tool name when strictAllowlist is false', async () => {
      const validator = new ToolCallValidator(new MockLLMProvider(), {
        strictAllowlist: false,
        onRepairFailure: 'return-error',
      });

      const result = await validator.validate(
        { id: 'call_1', name: 'unknown_tool', arguments: '{}' },
        tools,
        baseMessages,
      );

      // No schema to validate against, so passes through
      expect(result.valid).toBe(true);
    });
  });

  describe('JSON parsing', () => {
    it('rejects malformed JSON and attempts repair', async () => {
      const provider = new MockLLMProvider({
        scenarios: [
          // repair attempt returns valid call
          { type: 'valid-call', toolName: 'get_weather', args: { city: 'Seattle' } },
        ],
      });
      const validator = new ToolCallValidator(provider, { maxRepairAttempts: 1 });

      const result = await validator.validate(
        { id: 'call_1', name: 'get_weather', arguments: '{city: "Seattle"' },
        tools,
        baseMessages,
      );

      expect(result.valid).toBe(true);
      expect(result.repairAttempts).toBe(1);
    });
  });

  describe('configuration', () => {
    it('uses provided config over defaults', () => {
      const validator = new ToolCallValidator(new MockLLMProvider(), {
        maxRepairAttempts: 5,
        strictAllowlist: false,
      });
      // Just verify it constructs without error
      expect(validator).toBeTruthy();
    });
  });
});

// --- Failure Mode Tests ---

describe('ToolCallValidator — failure mode tests', () => {
  describe('FM: repair loop exhaustion', () => {
    it('throws ToolCallValidationError when all repair attempts fail (onRepairFailure: throw)', async () => {
      // Provider always returns malformed call
      const provider = new MockLLMProvider({
        scenarios: [
          { type: 'missing-required', toolName: 'get_weather', args: {} }, // repair 1: still missing city
          { type: 'missing-required', toolName: 'get_weather', args: {} }, // repair 2: still missing city
        ],
      });

      const validator = new ToolCallValidator(provider, {
        maxRepairAttempts: 2,
        onRepairFailure: 'throw',
      });

      await expect(
        validator.validate(
          { id: 'call_1', name: 'get_weather', arguments: '{}' },
          tools,
          baseMessages,
        ),
      ).rejects.toThrow(ToolCallValidationError);
    });

    it('returns invalid result when all repair attempts fail (onRepairFailure: return-error)', async () => {
      const provider = new MockLLMProvider({
        scenarios: [
          { type: 'missing-required', toolName: 'get_weather', args: {} },
        ],
      });

      const validator = new ToolCallValidator(provider, {
        maxRepairAttempts: 1,
        onRepairFailure: 'return-error',
      });

      const result = await validator.validate(
        { id: 'call_1', name: 'get_weather', arguments: '{}' },
        tools,
        baseMessages,
      );

      expect(result.valid).toBe(false);
      expect(result.repairAttempts).toBe(1);
    });

    it('tracks repair attempt count accurately', async () => {
      const provider = new MockLLMProvider({
        scenarios: [
          { type: 'missing-required', toolName: 'get_weather', args: {} },
          { type: 'missing-required', toolName: 'get_weather', args: {} },
        ],
      });

      const validator = new ToolCallValidator(provider, {
        maxRepairAttempts: 2,
        onRepairFailure: 'return-error',
      });

      const result = await validator.validate(
        { id: 'call_1', name: 'get_weather', arguments: '{}' },
        tools,
        baseMessages,
      );

      expect(result.repairAttempts).toBe(2);
    });
  });

  describe('FM: allowlist bypass prevention', () => {
    it('blocks hallucinated tool before executing, with no repair attempts', async () => {
      const validator = new ToolCallValidator(new MockLLMProvider(), {
        strictAllowlist: true,
        maxRepairAttempts: 3, // would be used for schema errors, but not for allowlist failures
        onRepairFailure: 'return-error',
      });

      const result = await validator.validate(
        { id: 'call_1', name: 'system_exec', arguments: '{"cmd":"rm -rf /"}' },
        tools,
        baseMessages,
      );

      expect(result.valid).toBe(false);
      expect(result.repairAttempts).toBe(0);
      expect(result.errors![0].field).toBe('name');
    });
  });

  describe('FM: over-validation (strict schema rejects valid partial calls)', () => {
    it('required-only mode passes optional fields with wrong types', async () => {
      const validator = new ToolCallValidator(new MockLLMProvider(), {
        schemaStrictness: 'required-only',
        onRepairFailure: 'return-error',
      });

      // Optional field 'include_forecast' gets wrong type — should not fail in required-only mode
      const result = await validator.validate(
        { id: 'call_1', name: 'get_weather', arguments: { city: 'Seattle', include_forecast: 'yes' } },
        tools,
        baseMessages,
      );

      expect(result.valid).toBe(true);
    });

    it('all-fields mode catches optional field type errors', async () => {
      const validator = new ToolCallValidator(new MockLLMProvider(), {
        schemaStrictness: 'all',
        maxRepairAttempts: 0,
        onRepairFailure: 'return-error',
      });

      const result = await validator.validate(
        { id: 'call_1', name: 'get_weather', arguments: { city: 'Seattle', include_forecast: 'yes' } },
        tools,
        baseMessages,
      );

      expect(result.valid).toBe(false);
    });
  });

  describe('FM: repair success path', () => {
    it('succeeds on second attempt after initial schema error', async () => {
      const provider = new MockLLMProvider({
        scenarios: [
          // First repair attempt returns a valid call
          { type: 'valid-call', toolName: 'get_weather', args: { city: 'Seattle' } },
        ],
      });

      const validator = new ToolCallValidator(provider, { maxRepairAttempts: 2 });

      const result = await validator.validate(
        { id: 'call_1', name: 'get_weather', arguments: '{}' }, // missing city
        tools,
        baseMessages,
      );

      expect(result.valid).toBe(true);
      expect(result.repairAttempts).toBe(1);
      expect(provider.getCallCount()).toBe(1);
    });
  });

  describe('FM: silent degradation detection', () => {
    it('repair rate can be tracked across multiple calls', async () => {
      // Simulates 10 calls where 3 require repair — repair rate = 30%
      const scenarios = [];
      for (let i = 0; i < 10; i++) {
        if (i % 3 === 0) {
          // Every 3rd call fails initially, then repairs
          scenarios.push({ type: 'missing-required' as const, toolName: 'get_weather', args: {} });
          scenarios.push({ type: 'valid-call' as const, toolName: 'get_weather', args: { city: 'Seattle' } });
        } else {
          scenarios.push({ type: 'valid-call' as const, toolName: 'get_weather', args: { city: 'Seattle' } });
        }
      }

      const provider = new MockLLMProvider({ scenarios });
      const validator = new ToolCallValidator(provider, { maxRepairAttempts: 1, onRepairFailure: 'return-error' });

      let repairsNeeded = 0;

      for (let i = 0; i < 10; i++) {
        const args = i % 3 === 0 ? '{}' : JSON.stringify({ city: 'Seattle' });
        const result = await validator.validate(
          { id: `call_${i}`, name: 'get_weather', arguments: args },
          tools,
          baseMessages,
        );
        if (result.repairAttempts > 0) repairsNeeded++;
      }

      // At least some calls required repair — this metric is what monitoring should track
      expect(repairsNeeded).toBeGreaterThan(0);
    });
  });
});

// --- Integration Tests ---

describe('ToolCallValidator — integration tests', () => {
  it('full flow: parse → allowlist → schema → execute-ready result', async () => {
    const provider = new MockLLMProvider({
      scenarios: [
        { type: 'valid-call', toolName: 'search', args: { query: 'TypeScript best practices', limit: 5 } },
      ],
    });

    const validator = new ToolCallValidator(provider, {
      maxRepairAttempts: 2,
      strictAllowlist: true,
      schemaStrictness: 'all',
    });

    const result = await validator.validate(
      {
        id: 'call_1',
        name: 'search',
        arguments: JSON.stringify({ query: 'TypeScript best practices', limit: 5 }),
      },
      tools,
      baseMessages,
    );

    expect(result.valid).toBe(true);
    expect(result.toolName).toBe('search');
    expect(result.arguments).toEqual({ query: 'TypeScript best practices', limit: 5 });
    expect(result.repairAttempts).toBe(0);
    expect(result.errors).toBeUndefined();
  });

  it('full flow: repair from malformed JSON → valid result', async () => {
    const provider = new MockLLMProvider({
      scenarios: [
        // On repair call, returns valid
        { type: 'valid-call', toolName: 'search', args: { query: 'test' } },
      ],
    });

    const validator = new ToolCallValidator(provider, { maxRepairAttempts: 1 });

    const result = await validator.validate(
      { id: 'call_1', name: 'search', arguments: 'not json' },
      tools,
      baseMessages,
    );

    expect(result.valid).toBe(true);
    expect(result.repairAttempts).toBe(1);
  });

  it('concurrent validation calls do not interfere', async () => {
    const provider = new MockLLMProvider({
      scenarios: [{ type: 'valid-call', toolName: 'get_weather', args: { city: 'Seattle' } }],
    });

    const validator = new ToolCallValidator(provider);

    const results = await Promise.all([
      validator.validate({ id: 'call_1', name: 'get_weather', arguments: { city: 'Seattle' } }, tools, baseMessages),
      validator.validate({ id: 'call_2', name: 'get_weather', arguments: { city: 'Portland' } }, tools, baseMessages),
      validator.validate({ id: 'call_3', name: 'search', arguments: { query: 'test' } }, tools, baseMessages),
    ]);

    expect(results.every((r) => r.valid)).toBe(true);
    expect(results[0].arguments.city).toBe('Seattle');
    expect(results[1].arguments.city).toBe('Portland');
    expect(results[2].toolName).toBe('search');
  });

  it('ToolCallValidationError carries the full result for diagnostics', async () => {
    const provider = new MockLLMProvider({ scenarios: [] });

    const validator = new ToolCallValidator(provider, {
      maxRepairAttempts: 0,
      onRepairFailure: 'throw',
    });

    let caught: ToolCallValidationError | null = null;
    try {
      await validator.validate(
        { id: 'call_1', name: 'get_weather', arguments: '{}' },
        tools,
        baseMessages,
      );
    } catch (e) {
      if (e instanceof ToolCallValidationError) {
        caught = e;
      }
    }

    expect(caught).not.toBeNull();
    expect(caught!.result.valid).toBe(false);
    expect(caught!.result.errors).toBeDefined();
  });
});
