/**
 * Built-in document loaders for the RAG pipeline.
 *
 * @module
 */

import type { Document, DocumentLoader } from './types.js';

/**
 * Create a loader that converts an array of plain strings into Documents.
 *
 * @example
 * ```ts
 * const loader = createTextLoader(['Hello world', 'Another doc'], { source: 'test' });
 * const docs = await loader.load();
 * // docs[0].id === 'doc_0', docs[0].content === 'Hello world'
 * ```
 */
export function createTextLoader(
  texts: readonly string[],
  options?: { source?: string },
): DocumentLoader {
  return Object.freeze({
    async load(): Promise<Document[]> {
      return texts.map((content, i) => ({
        id: `doc_${i}`,
        content,
        source: options?.source ?? 'text',
        metadata: {},
      }));
    },
  });
}

/**
 * Create a loader that passes through an array of pre-built Document objects.
 *
 * @example
 * ```ts
 * const loader = createDocumentArrayLoader([{ id: 'd1', content: 'Hi' }]);
 * const docs = await loader.load();
 * // docs[0].id === 'd1'
 * ```
 */
export function createDocumentArrayLoader(
  documents: readonly Document[],
): DocumentLoader {
  return Object.freeze({
    async load(): Promise<Document[]> {
      return [...documents];
    },
  });
}
