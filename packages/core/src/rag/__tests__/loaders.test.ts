import { describe, it, expect } from 'vitest';
import { createTextLoader, createDocumentArrayLoader } from '../loaders.js';
import type { Document } from '../types.js';

// ===========================================================================
// createTextLoader
// ===========================================================================

describe('createTextLoader', () => {
  it('converts an array of strings into Documents with sequential ids', async () => {
    const loader = createTextLoader(['alpha', 'beta', 'gamma']);
    const docs = await loader.load();

    expect(docs).toHaveLength(3);
    expect(docs[0]).toEqual({ id: 'doc_0', content: 'alpha', source: 'text', metadata: {} });
    expect(docs[1]).toEqual({ id: 'doc_1', content: 'beta', source: 'text', metadata: {} });
    expect(docs[2]).toEqual({ id: 'doc_2', content: 'gamma', source: 'text', metadata: {} });
  });

  it('uses default source "text" when no options provided', async () => {
    const loader = createTextLoader(['hello']);
    const docs = await loader.load();

    expect(docs[0].source).toBe('text');
  });

  it('uses custom source when provided', async () => {
    const loader = createTextLoader(['x'], { source: 'custom-api' });
    const docs = await loader.load();

    expect(docs[0].source).toBe('custom-api');
  });

  it('returns empty array for empty input', async () => {
    const loader = createTextLoader([]);
    const docs = await loader.load();

    expect(docs).toEqual([]);
  });

  it('preserves content including whitespace and special characters', async () => {
    const loader = createTextLoader(['  spaces  ', 'line\nbreak', '']);
    const docs = await loader.load();

    expect(docs[0].content).toBe('  spaces  ');
    expect(docs[1].content).toBe('line\nbreak');
    expect(docs[2].content).toBe('');
  });

  it('initializes metadata as an empty object for each document', async () => {
    const loader = createTextLoader(['a', 'b']);
    const docs = await loader.load();

    expect(docs[0].metadata).toEqual({});
    expect(docs[1].metadata).toEqual({});
    // Verify they are distinct objects
    expect(docs[0].metadata).not.toBe(docs[1].metadata);
  });

  it('returns a frozen loader object', () => {
    const loader = createTextLoader(['test']);
    expect(Object.isFrozen(loader)).toBe(true);
  });

  it('load() is async and returns a Promise', () => {
    const loader = createTextLoader(['test']);
    const result = loader.load();
    expect(result).toBeInstanceOf(Promise);
  });

  it('handles a single text input', async () => {
    const loader = createTextLoader(['only one']);
    const docs = await loader.load();

    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe('doc_0');
  });

  it('handles a large number of texts', async () => {
    const texts = Array.from({ length: 1000 }, (_, i) => `text_${i}`);
    const loader = createTextLoader(texts);
    const docs = await loader.load();

    expect(docs).toHaveLength(1000);
    expect(docs[999].id).toBe('doc_999');
    expect(docs[999].content).toBe('text_999');
  });

  it('can be loaded multiple times with the same result', async () => {
    const loader = createTextLoader(['stable']);
    const docs1 = await loader.load();
    const docs2 = await loader.load();

    expect(docs1).toEqual(docs2);
    // But they should be different array instances
    expect(docs1).not.toBe(docs2);
  });
});

// ===========================================================================
// createDocumentArrayLoader
// ===========================================================================

describe('createDocumentArrayLoader', () => {
  it('passes through pre-built Document objects', async () => {
    const original: Document[] = [
      { id: 'd1', content: 'hello', metadata: { a: 1 } },
      { id: 'd2', content: 'world' },
    ];
    const loader = createDocumentArrayLoader(original);
    const docs = await loader.load();

    expect(docs).toHaveLength(2);
    expect(docs[0]).toEqual(original[0]);
    expect(docs[1]).toEqual(original[1]);
  });

  it('returns a shallow copy (not the same array reference)', async () => {
    const original: Document[] = [{ id: 'd1', content: 'hi' }];
    const loader = createDocumentArrayLoader(original);
    const docs = await loader.load();

    expect(docs).not.toBe(original);
  });

  it('returns empty array for empty input', async () => {
    const loader = createDocumentArrayLoader([]);
    const docs = await loader.load();

    expect(docs).toEqual([]);
  });

  it('preserves all document fields (id, content, source, metadata)', async () => {
    const original: Document[] = [
      { id: 'custom-id', content: 'custom content', source: 'db', metadata: { key: 'val' } },
    ];
    const loader = createDocumentArrayLoader(original);
    const docs = await loader.load();

    expect(docs[0].id).toBe('custom-id');
    expect(docs[0].content).toBe('custom content');
    expect(docs[0].source).toBe('db');
    expect(docs[0].metadata).toEqual({ key: 'val' });
  });

  it('returns a frozen loader object', () => {
    const loader = createDocumentArrayLoader([]);
    expect(Object.isFrozen(loader)).toBe(true);
  });

  it('load() is async and returns a Promise', () => {
    const loader = createDocumentArrayLoader([]);
    const result = loader.load();
    expect(result).toBeInstanceOf(Promise);
  });

  it('can be loaded multiple times with consistent results', async () => {
    const original: Document[] = [{ id: 'd1', content: 'stable' }];
    const loader = createDocumentArrayLoader(original);
    const docs1 = await loader.load();
    const docs2 = await loader.load();

    expect(docs1).toEqual(docs2);
    expect(docs1).not.toBe(docs2);
  });

  it('handles documents with no optional fields', async () => {
    const original: Document[] = [{ id: 'minimal', content: 'just content' }];
    const loader = createDocumentArrayLoader(original);
    const docs = await loader.load();

    expect(docs[0].id).toBe('minimal');
    expect(docs[0].content).toBe('just content');
    expect(docs[0].source).toBeUndefined();
    expect(docs[0].metadata).toBeUndefined();
  });

  it('handles a large number of documents', async () => {
    const original: Document[] = Array.from({ length: 500 }, (_, i) => ({
      id: `doc_${i}`,
      content: `content_${i}`,
    }));
    const loader = createDocumentArrayLoader(original);
    const docs = await loader.load();

    expect(docs).toHaveLength(500);
    expect(docs[499].id).toBe('doc_499');
  });

  it('does not modify the original array when documents are added to result', async () => {
    const original: Document[] = [{ id: 'd1', content: 'a' }];
    const loader = createDocumentArrayLoader(original);
    const docs = await loader.load();

    docs.push({ id: 'd2', content: 'b' });
    expect(original).toHaveLength(1);
  });
});
