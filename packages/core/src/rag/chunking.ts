/**
 * Built-in chunking strategies for the RAG pipeline.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import type { ChunkingStrategy, Document, DocumentChunk } from './types.js';

/**
 * Fix 20: Find the nearest word boundary by searching backward from a position.
 * Returns the adjusted position that does not split a word.
 * If no whitespace is found, returns the original position.
 */
function findWordBoundary(text: string, position: number): number {
  if (position >= text.length) return position;
  // If we're already at a whitespace or the next char is whitespace, no adjustment needed
  if (position === 0) return position;
  // Check if we're at a word boundary already
  if (/\s/.test(text[position]) || /\s/.test(text[position - 1])) return position;
  // Search backward for nearest whitespace
  for (let i = position - 1; i > 0; i--) {
    if (/\s/.test(text[i])) {
      return i + 1;
    }
  }
  // No whitespace found, return original position to avoid empty chunks
  return position;
}

/**
 * Create a fixed-size chunking strategy that splits documents into chunks
 * of `chunkSize` characters with optional overlap.
 *
 * Fix 20: When a split point falls mid-word, the boundary is adjusted backward
 * to the nearest whitespace to avoid splitting words.
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
      HarnessErrorCode.RAG_INVALID_CONFIG,
      'Provide a positive chunkSize value',
    );
  }

  if (overlap < 0) {
    throw new HarnessError(
      `overlap must be non-negative, got ${overlap}`,
      HarnessErrorCode.RAG_INVALID_CONFIG,
      'Provide a non-negative overlap value',
    );
  }

  if (overlap >= chunkSize) {
    throw new HarnessError(
      `overlap (${overlap}) must be less than chunkSize (${chunkSize})`,
      HarnessErrorCode.RAG_INVALID_CONFIG,
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
        let end = Math.min(start + chunkSize, content.length);

        // Fix 20: Adjust end to word boundary if mid-word
        if (end < content.length) {
          const adjusted = findWordBoundary(content, end);
          if (adjusted > start) {
            end = adjusted;
          }
        }

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
 * @param config.splitOnSingleNewline - Fix 21: When true, split on single newlines
 *   instead of requiring double newlines. Default false for backward compatibility.
 *
 * @example
 * ```ts
 * const chunking = createParagraphChunking({ maxChunkSize: 500 });
 * const chunks = chunking.chunk({ id: 'd1', content: 'Para 1\n\nPara 2' });
 * ```
 */
export function createParagraphChunking(config?: {
  maxChunkSize?: number;
  /** Fix 21: When true, split on single newlines instead of double newlines. Default false. */
  splitOnSingleNewline?: boolean;
}): ChunkingStrategy {
  const maxChunkSize = config?.maxChunkSize;
  const splitOnSingleNewline = config?.splitOnSingleNewline ?? false;

  if (maxChunkSize !== undefined && maxChunkSize <= 0) {
    throw new HarnessError(
      `maxChunkSize must be greater than 0, got ${maxChunkSize}`,
      HarnessErrorCode.RAG_INVALID_CONFIG,
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

      // Fix 21: Split on single or double newlines based on config
      const splitPattern = splitOnSingleNewline ? /\n/ : /\n\s*\n/;
      const paragraphs = content.split(splitPattern).filter((p) => p.trim().length > 0);

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
 * Fix 20: When a window boundary falls mid-word, it is adjusted backward
 * to the nearest whitespace to avoid splitting words.
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
      HarnessErrorCode.RAG_INVALID_CONFIG,
      'Provide a positive windowSize value',
    );
  }

  if (stepSize <= 0) {
    throw new HarnessError(
      `stepSize must be greater than 0, got ${stepSize}`,
      HarnessErrorCode.RAG_INVALID_CONFIG,
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
        let end = Math.min(start + windowSize, content.length);

        // Fix 20: Adjust end to word boundary if mid-word
        if (end < content.length) {
          const adjusted = findWordBoundary(content, end);
          if (adjusted > start) {
            end = adjusted;
          }
        }

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
