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

import { createTiktokenTokenizer, registerTiktokenModels, isSupportedTiktokenModel } from '../index.js';

describe('createTiktokenTokenizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEncode.mockReturnValue(new Uint32Array([1, 2, 3, 4, 5]));
  });

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

  it('throws a clear error for unsupported model names before calling tiktoken', () => {
    expect(() => createTiktokenTokenizer('totally-fake-model')).toThrow(
      'Unsupported tiktoken model: "totally-fake-model"'
    );
    // encoding_for_model should NOT have been called because validation rejects early
    expect(mockEncodingForModel).not.toHaveBeenCalled();
  });

  it('includes the model name in the error message for unsupported models', () => {
    expect(() => createTiktokenTokenizer('claude-3-opus')).toThrow('claude-3-opus');
    expect(mockEncodingForModel).not.toHaveBeenCalled();
  });

  it('lists supported models in the error message', () => {
    try {
      createTiktokenTokenizer('invalid-model');
    } catch (err) {
      expect((err as Error).message).toContain('gpt-4');
      expect((err as Error).message).toContain('gpt-4o');
      expect((err as Error).message).toContain('gpt-3.5-turbo');
    }
  });
});

describe('isSupportedTiktokenModel', () => {
  it('returns true for known models', () => {
    expect(isSupportedTiktokenModel('gpt-4')).toBe(true);
    expect(isSupportedTiktokenModel('gpt-4o')).toBe(true);
    expect(isSupportedTiktokenModel('gpt-4o-mini')).toBe(true);
    expect(isSupportedTiktokenModel('gpt-3.5-turbo')).toBe(true);
    expect(isSupportedTiktokenModel('text-davinci-003')).toBe(true);
  });

  it('returns false for unknown models', () => {
    expect(isSupportedTiktokenModel('claude-3-opus')).toBe(false);
    expect(isSupportedTiktokenModel('fake-model')).toBe(false);
    expect(isSupportedTiktokenModel('')).toBe(false);
  });
});

describe('registerTiktokenModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
