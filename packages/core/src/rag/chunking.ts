/**
 * Built-in chunking strategies for the RAG pipeline.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
import type { ChunkingStrategy, Document, DocumentChunk } from './types.js';

/**
 * Create a fixed-size chunking strategy that splits documents into chunks
 * of `chunkSize` characters with optional overlap.
 *
 * @example
 * ```ts
 * const chunking = createFixedSizeChunking({ chunkSize: 100, overlap: 20 });
 * const chunks = chunking.chunk({ id: 'd1', content: 'Hello world...' });
 * ```
 */
export function createFixedSizeChunking(config: {
  chunkSize: number;
  overlap?: number;
}): ChunkingStrategy {
  const { chunkSize, overlap = 0 } = config;

  if (chunkSize <= 0) {
    throw new HarnessError(
      `chunkSize must be greater than 0, got ${chunkSize}`,
      'RAG_INVALID_CONFIG',
      'Provide a positive chunkSize value',
    );
  }

  if (overlap < 0) {
    throw new HarnessError(
      `overlap must be non-negative, got ${overlap}`,
      'RAG_INVALID_CONFIG',
      'Provide a non-negative overlap value',
    );
  }

  if (overlap >= chunkSize) {
    throw new HarnessError(
      `overlap (${overlap}) must be less than chunkSize (${chunkSize})`,
      'RAG_INVALID_CONFIG',
      'Reduce overlap or increase chunkSize',
    );
  }

  return Object.freeze({
    name: 'fixed-size',
    chunk(document: Document): DocumentChunk[] {
      const { content } = document;
      if (content.length === 0) {
        return [];
      }

      const chunks: DocumentChunk[] = [];
      const step = chunkSize - overlap;
      let index = 0;

      for (let start = 0; start < content.length; start += step) {
        const end = Math.min(start + chunkSize, content.length);
        chunks.push({
          id: `${document.id}_chunk_${index}`,
          documentId: document.id,
          content: content.slice(start, end),
          index,
          metadata: { ...document.metadata },
        });
        index++;
        // If we've reached the end of the content, stop
        if (end === content.length) break;
      }

      return chunks;
    },
  });
}

/**
 * Create a paragraph-based chunking strategy that splits on double newlines.
 *
 * @example
 * ```ts
 * const chunking = createParagraphChunking({ maxChunkSize: 500 });
 * const chunks = chunking.chunk({ id: 'd1', content: 'Para 1\n\nPara 2' });
 * ```
 */
export function createParagraphChunking(config?: {
  maxChunkSize?: number;
}): ChunkingStrategy {
  const maxChunkSize = config?.maxChunkSize;

  if (maxChunkSize !== undefined && maxChunkSize <= 0) {
    throw new HarnessError(
      `maxChunkSize must be greater than 0, got ${maxChunkSize}`,
      'RAG_INVALID_CONFIG',
      'Provide a positive maxChunkSize value',
    );
  }

  return Object.freeze({
    name: 'paragraph',
    chunk(document: Document): DocumentChunk[] {
      const { content } = document;
      if (content.length === 0) {
        return [];
      }

      // Split on double newlines (with optional whitespace between)
      const paragraphs = content.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

      if (paragraphs.length === 0) {
        return [];
      }

      const chunks: DocumentChunk[] = [];
      let index = 0;

      for (const paragraph of paragraphs) {
        const trimmed = paragraph.trim();

        if (maxChunkSize !== undefined && trimmed.length > maxChunkSize) {
          // Sub-split long paragraphs into maxChunkSize segments
          for (let start = 0; start < trimmed.length; start += maxChunkSize) {
            const end = Math.min(start + maxChunkSize, trimmed.length);
            chunks.push({
              id: `${document.id}_chunk_${index}`,
              documentId: document.id,
              content: trimmed.slice(start, end),
              index,
              metadata: { ...document.metadata },
            });
            index++;
          }
        } else {
          chunks.push({
            id: `${document.id}_chunk_${index}`,
            documentId: document.id,
            content: trimmed,
            index,
            metadata: { ...document.metadata },
          });
          index++;
        }
      }

      return chunks;
    },
  });
}

/**
 * Create a sliding window chunking strategy with overlapping windows.
 *
 * @example
 * ```ts
 * const chunking = createSlidingWindowChunking({ windowSize: 200, stepSize: 100 });
 * const chunks = chunking.chunk({ id: 'd1', content: 'Long text...' });
 * ```
 */
export function createSlidingWindowChunking(config: {
  windowSize: number;
  stepSize: number;
}): ChunkingStrategy {
  const { windowSize, stepSize } = config;

  if (windowSize <= 0) {
    throw new HarnessError(
      `windowSize must be greater than 0, got ${windowSize}`,
      'RAG_INVALID_CONFIG',
      'Provide a positive windowSize value',
    );
  }

  if (stepSize <= 0) {
    throw new HarnessError(
      `stepSize must be greater than 0, got ${stepSize}`,
      'RAG_INVALID_CONFIG',
      'Provide a positive stepSize value',
    );
  }

  return Object.freeze({
    name: 'sliding-window',
    chunk(document: Document): DocumentChunk[] {
      const { content } = document;
      if (content.length === 0) {
        return [];
      }

      const chunks: DocumentChunk[] = [];
      let index = 0;

      for (let start = 0; start < content.length; start += stepSize) {
        const end = Math.min(start + windowSize, content.length);
        chunks.push({
          id: `${document.id}_chunk_${index}`,
          documentId: document.id,
          content: content.slice(start, end),
          index,
          metadata: { ...document.metadata },
        });
        index++;
        // If window reaches the end, stop
        if (end === content.length) break;
      }

      return chunks;
    },
  });
}
