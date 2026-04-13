import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted — use vi.hoisted() for shared state
const { mockEncode, mockFree, mockEncodingForModel, mockRegisterTokenizer } = vi.hoisted(() => {
  const mockEncode = vi.fn().mockReturnValue(new Uint32Array([1, 2, 3, 4, 5]));
  const mockFree = vi.fn();
  // Each call returns a fresh "native encoder" whose free method shares the
  // single mockFree spy so tests can count total free invocations.
  const mockEncodingForModel = vi.fn().mockImplementation(() => ({
    encode: mockEncode,
    free: mockFree,
  }));
  const mockRegisterTokenizer = vi.fn();
  return { mockEncode, mockFree, mockEncodingForModel, mockRegisterTokenizer };
});

vi.mock('tiktoken', () => ({
  encoding_for_model: mockEncodingForModel,
}));

vi.mock('harness-one/context', () => ({
  registerTokenizer: mockRegisterTokenizer,
}));

// We need to reset the module-level cache between tests
// Import dynamically to allow cache clearing
let createTiktokenTokenizer: typeof import('../index.js').createTiktokenTokenizer;
let registerTiktokenModels: typeof import('../index.js').registerTiktokenModels;
let disposeTiktoken: typeof import('../index.js').disposeTiktoken;

beforeEach(async () => {
  vi.clearAllMocks();
  mockEncode.mockReturnValue(new Uint32Array([1, 2, 3, 4, 5]));
  // Restore the default factory for encoding_for_model — individual tests
  // may override it via `mockImplementationOnce`, and we don't want that
  // override to leak into later tests when `vi.resetModules()` happens to
  // re-trigger model creation inside the module init path.
  mockEncodingForModel.mockImplementation(() => ({
    encode: mockEncode,
    free: mockFree,
  }));
  // Re-import to reset module-level cache
  vi.resetModules();
  const mod = await import('../index.js');
  createTiktokenTokenizer = mod.createTiktokenTokenizer;
  registerTiktokenModels = mod.registerTiktokenModels;
  disposeTiktoken = mod.disposeTiktoken;
});

describe('createTiktokenTokenizer', () => {
  it('creates a tokenizer for a given model', () => {
    const tokenizer = createTiktokenTokenizer('gpt-4');

    expect(mockEncodingForModel).toHaveBeenCalledWith('gpt-4');
    expect(tokenizer).toBeDefined();
    expect(typeof tokenizer.encode).toBe('function');
  });

  it('registers the tokenizer with harness-one', () => {
    createTiktokenTokenizer('gpt-4o');

    expect(mockRegisterTokenizer).toHaveBeenCalledWith('gpt-4o', expect.objectContaining({
      encode: expect.any(Function),
    }));
  });

  it('encode returns token count from tiktoken', () => {
    const tokenizer = createTiktokenTokenizer('gpt-4');
    const result = tokenizer.encode('Hello world');

    expect(mockEncode).toHaveBeenCalledWith('Hello world');
    expect(result.length).toBe(5);
  });

  it('handles empty string', () => {
    mockEncode.mockReturnValueOnce(new Uint32Array([]));
    const tokenizer = createTiktokenTokenizer('gpt-4');
    const result = tokenizer.encode('');

    expect(result.length).toBe(0);
  });

  it('CQ-044: falls back to a heuristic encoder when encoding_for_model fails and warns once', async () => {
    const warn = vi.fn();
    // Re-import the currently-loaded module (reset in beforeEach) to grab the
    // fallback-warner setter without triggering a second reset.
    const mod = await import('../index.js');
    mod.setTiktokenFallbackWarner(warn);
    mockEncodingForModel.mockImplementationOnce(() => {
      throw new Error('Unknown model: totally-fake-model');
    });
    const tokenizer = mod.createTiktokenTokenizer('totally-fake-model');
    // Fallback is a heuristic — ~len/4 + 4 framing overhead.
    expect(tokenizer.encode('hello world').length).toBe(Math.ceil('hello world'.length / 4) + 4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Tokenizer fallback for unknown model', 'totally-fake-model');
  });

  it('CQ-044: warns at most once per fallback model even across repeated calls', async () => {
    const warn = vi.fn();
    const mod = await import('../index.js');
    mod.setTiktokenFallbackWarner(warn);
    mockEncodingForModel.mockImplementation(() => {
      throw new Error('unknown');
    });
    mod.createTiktokenTokenizer('fake-model');
    mod.createTiktokenTokenizer('fake-model');
    mod.createTiktokenTokenizer('fake-model');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('delegates model validation to tiktoken instead of using a hardcoded list', () => {
    // Any model that tiktoken accepts should work without a hardcoded allowlist
    createTiktokenTokenizer('gpt-4');
    expect(mockEncodingForModel).toHaveBeenCalledWith('gpt-4');
    // No hardcoded list check -- just passes through to encoding_for_model
  });

  it('caches encoders per model to avoid expensive re-creation', () => {
    const tokenizer1 = createTiktokenTokenizer('gpt-4');
    const tokenizer2 = createTiktokenTokenizer('gpt-4');

    // encoding_for_model should only be called once for the same model
    expect(mockEncodingForModel).toHaveBeenCalledTimes(1);
    // Both calls should return the same tokenizer instance
    expect(tokenizer1).toBe(tokenizer2);
  });

  it('creates separate encoders for different models', () => {
    createTiktokenTokenizer('gpt-4');
    createTiktokenTokenizer('gpt-4o');

    expect(mockEncodingForModel).toHaveBeenCalledTimes(2);
    expect(mockEncodingForModel).toHaveBeenCalledWith('gpt-4');
    expect(mockEncodingForModel).toHaveBeenCalledWith('gpt-4o');
  });

  it('registers tokenizer only once per model when cached', () => {
    createTiktokenTokenizer('gpt-4');
    createTiktokenTokenizer('gpt-4');

    // registerTokenizer should only be called once for the same model
    expect(mockRegisterTokenizer).toHaveBeenCalledTimes(1);
  });
});

describe('registerTiktokenModels', () => {
  it('registers default models when no argument provided', () => {
    registerTiktokenModels();

    expect(mockEncodingForModel).toHaveBeenCalledWith('gpt-4');
    expect(mockEncodingForModel).toHaveBeenCalledWith('gpt-4o');
    expect(mockEncodingForModel).toHaveBeenCalledWith('gpt-4o-mini');
    expect(mockEncodingForModel).toHaveBeenCalledWith('gpt-3.5-turbo');
    expect(mockRegisterTokenizer).toHaveBeenCalledTimes(4);
  });

  it('registers specified models', () => {
    registerTiktokenModels(['gpt-4', 'gpt-4o']);

    expect(mockEncodingForModel).toHaveBeenCalledTimes(2);
    expect(mockRegisterTokenizer).toHaveBeenCalledTimes(2);
  });

  it('registers empty list without error', () => {
    registerTiktokenModels([]);
    expect(mockEncodingForModel).not.toHaveBeenCalled();
  });
});

describe('disposeTiktoken', () => {
  it('calls .free() on every cached encoder', () => {
    createTiktokenTokenizer('gpt-4');
    createTiktokenTokenizer('gpt-4o');
    createTiktokenTokenizer('gpt-3.5-turbo');

    expect(mockFree).not.toHaveBeenCalled();

    disposeTiktoken();

    expect(mockFree).toHaveBeenCalledTimes(3);
  });

  it('clears the cache so subsequent calls re-create encoders', () => {
    createTiktokenTokenizer('gpt-4');
    expect(mockEncodingForModel).toHaveBeenCalledTimes(1);

    disposeTiktoken();

    // After dispose, creating the same tokenizer should hit tiktoken again
    // (not a cached entry).
    createTiktokenTokenizer('gpt-4');
    expect(mockEncodingForModel).toHaveBeenCalledTimes(2);
  });

  it('is idempotent — calling dispose twice does not throw or re-free', () => {
    createTiktokenTokenizer('gpt-4');

    disposeTiktoken();
    expect(mockFree).toHaveBeenCalledTimes(1);

    // Second dispose: nothing left to free
    expect(() => disposeTiktoken()).not.toThrow();
    expect(mockFree).toHaveBeenCalledTimes(1);
  });

  it('repeated register/dispose cycles fully free WASM memory (no leak)', () => {
    for (let i = 0; i < 3; i++) {
      createTiktokenTokenizer('gpt-4');
      createTiktokenTokenizer('gpt-4o');
      disposeTiktoken();
    }

    // 3 cycles × 2 encoders = 6 free calls
    expect(mockFree).toHaveBeenCalledTimes(6);
    // 3 cycles × 2 encoders = 6 creation calls (cache is cleared each cycle)
    expect(mockEncodingForModel).toHaveBeenCalledTimes(6);
  });

  it('resets the defaultsRegistered flag so registerTiktokenModels() reruns', () => {
    registerTiktokenModels();
    expect(mockEncodingForModel).toHaveBeenCalledTimes(4);

    // Without dispose, a second no-arg call is a no-op
    registerTiktokenModels();
    expect(mockEncodingForModel).toHaveBeenCalledTimes(4);

    disposeTiktoken();

    // After dispose, the no-arg call should re-register the defaults
    registerTiktokenModels();
    expect(mockEncodingForModel).toHaveBeenCalledTimes(8);
  });

  it('tolerates encoders without a .free() method (older tiktoken builds)', () => {
    // Override the mock to return an encoder with NO free method
    mockEncodingForModel.mockImplementationOnce(() => ({
      encode: mockEncode,
      // no free
    }));
    createTiktokenTokenizer('weird-model');

    expect(() => disposeTiktoken()).not.toThrow();
  });
});
