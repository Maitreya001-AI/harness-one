import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted — use vi.hoisted() for shared state
const { mockEncode, mockEncodingForModel, mockRegisterTokenizer } = vi.hoisted(() => {
  const mockEncode = vi.fn().mockReturnValue(new Uint32Array([1, 2, 3, 4, 5]));
  const mockEncodingForModel = vi.fn().mockReturnValue({ encode: mockEncode });
  const mockRegisterTokenizer = vi.fn();
  return { mockEncode, mockEncodingForModel, mockRegisterTokenizer };
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

beforeEach(async () => {
  vi.clearAllMocks();
  mockEncode.mockReturnValue(new Uint32Array([1, 2, 3, 4, 5]));
  // Re-import to reset module-level cache
  vi.resetModules();
  const mod = await import('../index.js');
  createTiktokenTokenizer = mod.createTiktokenTokenizer;
  registerTiktokenModels = mod.registerTiktokenModels;
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

  it('throws a clear error when encoding_for_model fails (unsupported model)', () => {
    mockEncodingForModel.mockImplementationOnce(() => {
      throw new Error('Unknown model: totally-fake-model');
    });
    expect(() => createTiktokenTokenizer('totally-fake-model')).toThrow(
      'Unsupported or failed tiktoken model: "totally-fake-model"'
    );
  });

  it('includes the model name and original error in the error message', () => {
    mockEncodingForModel.mockImplementationOnce(() => {
      throw new Error('no model found');
    });
    try {
      createTiktokenTokenizer('claude-3-opus');
    } catch (err) {
      expect((err as Error).message).toContain('claude-3-opus');
      expect((err as Error).message).toContain('no model found');
    }
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
