/**
 * Strict JSON parsers for agent outputs.
 *
 * The pipeline never accepts free-form prose. If the model leaks a wrapping
 * code-fence we tolerate it (commonly ``` ```json ... ``` ```), but anything
 * else throws {@link ParseError} so the caller can surface the failure
 * rather than degrading silently.
 */

import { MAX_SUBQUESTIONS, MIN_SUBQUESTIONS } from '../config/defaults.js';
import type {
  Citation,
  ResearchReport,
  SpecialistAnswer,
  SubQuestion,
} from '../types.js';

/** Raised when an agent's final assistant message can't be parsed. */
export class ParseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Researcher output → SubQuestion[]
 * ────────────────────────────────────────────────────────────────────────── */

export function parseSubQuestions(raw: string): SubQuestion[] {
  const obj = parseJsonObject(raw);
  const arr = obj['subQuestions'];
  if (!Array.isArray(arr)) {
    throw new ParseError('field "subQuestions" must be an array', raw);
  }
  if (arr.length < MIN_SUBQUESTIONS || arr.length > MAX_SUBQUESTIONS) {
    throw new ParseError(
      `subQuestions length must be between ${MIN_SUBQUESTIONS} and ${MAX_SUBQUESTIONS}; got ${arr.length}`,
      raw,
    );
  }
  return arr.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ParseError(`subQuestions[${i}] must be an object`, raw);
    }
    const rec = entry as Record<string, unknown>;
    const expectedIndex = i + 1;
    const idx = rec['index'];
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx !== expectedIndex) {
      throw new ParseError(
        `subQuestions[${i}].index must equal ${expectedIndex}, got ${JSON.stringify(idx)}`,
        raw,
      );
    }
    const text = requireString(rec['text'], `subQuestions[${i}].text`, raw).trim();
    const rationale = requireString(rec['rationale'], `subQuestions[${i}].rationale`, raw).trim();
    if (text.length === 0) {
      throw new ParseError(`subQuestions[${i}].text must be non-empty`, raw);
    }
    if (rationale.length === 0) {
      throw new ParseError(`subQuestions[${i}].rationale must be non-empty`, raw);
    }
    return { index: expectedIndex, text, rationale };
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * Specialist output → SpecialistAnswer
 * ────────────────────────────────────────────────────────────────────────── */

export interface ParseSpecialistOptions {
  /** Subquestion index this answer is bound to. */
  readonly subQuestionIndex: number;
  /**
   * URLs the Specialist actually fetched in-loop. The parser refuses any
   * citation whose URL was not present in this list — this is the MVP
   * defence against citation fabrication called out in DESIGN §8 OQ7.
   *
   * When omitted, the parser only enforces the URL syntax (https://...).
   */
  readonly fetchedUrls?: ReadonlySet<string>;
}

const CONFIDENCE_VALUES: readonly SpecialistAnswer['confidence'][] = ['high', 'medium', 'low'];

export function parseSpecialistAnswer(
  raw: string,
  options: ParseSpecialistOptions,
): SpecialistAnswer {
  const obj = parseJsonObject(raw);
  const answer = requireString(obj['answer'], 'answer', raw).trim();
  if (answer.length === 0) {
    throw new ParseError('answer must be non-empty', raw);
  }

  const confidence = obj['confidence'];
  if (typeof confidence !== 'string' || !(CONFIDENCE_VALUES as readonly string[]).includes(confidence)) {
    throw new ParseError('confidence must be high|medium|low', raw);
  }

  const rawCitations = obj['citations'];
  if (!Array.isArray(rawCitations)) {
    throw new ParseError('citations must be an array', raw);
  }

  const citations: Citation[] = rawCitations.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ParseError(`citations[${i}] must be an object`, raw);
    }
    const rec = entry as Record<string, unknown>;
    const url = requireString(rec['url'], `citations[${i}].url`, raw);
    if (!/^https:\/\/[^\s]+$/i.test(url)) {
      throw new ParseError(`citations[${i}].url must be an https:// URL`, raw);
    }
    if (options.fetchedUrls && !options.fetchedUrls.has(url)) {
      throw new ParseError(
        `citations[${i}].url ${url} was not fetched by this Specialist`,
        raw,
      );
    }
    const title = requireString(rec['title'], `citations[${i}].title`, raw).slice(0, 300);
    const excerpt = requireString(rec['excerpt'], `citations[${i}].excerpt`, raw).slice(0, 800);
    return { url, title, excerpt };
  });

  return {
    subQuestionIndex: options.subQuestionIndex,
    answer: answer.slice(0, 8_000),
    citations: dedupeCitationsByUrl(citations),
    confidence: confidence as SpecialistAnswer['confidence'],
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Coordinator output → ResearchReport
 * ────────────────────────────────────────────────────────────────────────── */

export interface ParseReportOptions {
  /**
   * Set of URLs the upstream Specialists actually cited. Coordinator citations
   * not in this set are rejected. Mirrors the Specialist defence one layer up.
   */
  readonly allowedUrls: ReadonlySet<string>;
}

export function parseResearchReport(raw: string, options: ParseReportOptions): ResearchReport {
  const obj = parseJsonObject(raw);
  const summary = requireString(obj['summary'], 'summary', raw).trim();
  if (summary.length === 0) {
    throw new ParseError('summary must be non-empty', raw);
  }
  if (summary.length > 800) {
    throw new ParseError(`summary must be <= 800 chars (got ${summary.length})`, raw);
  }

  const markdown = requireString(obj['markdown'], 'markdown', raw);
  if (markdown.trim().length === 0) {
    throw new ParseError('markdown must be non-empty', raw);
  }

  const rawCitations = obj['citations'];
  if (!Array.isArray(rawCitations)) {
    throw new ParseError('citations must be an array', raw);
  }
  const citations: Citation[] = rawCitations.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ParseError(`citations[${i}] must be an object`, raw);
    }
    const rec = entry as Record<string, unknown>;
    const url = requireString(rec['url'], `citations[${i}].url`, raw);
    if (!/^https:\/\/[^\s]+$/i.test(url)) {
      throw new ParseError(`citations[${i}].url must be an https:// URL`, raw);
    }
    if (!options.allowedUrls.has(url)) {
      throw new ParseError(
        `citations[${i}].url ${url} was not cited by any Specialist; refusing to fabricate`,
        raw,
      );
    }
    const title = requireString(rec['title'], `citations[${i}].title`, raw).slice(0, 300);
    const excerpt = requireString(rec['excerpt'], `citations[${i}].excerpt`, raw).slice(0, 800);
    return { url, title, excerpt };
  });

  return {
    summary: summary.slice(0, 800),
    markdown,
    citations: dedupeCitationsByUrl(citations),
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Module-private helpers
 * ────────────────────────────────────────────────────────────────────────── */

function parseJsonObject(raw: string): Record<string, unknown> {
  const text = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ParseError(
      `final message is not valid JSON: ${(cause as Error).message}`,
      raw,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ParseError('final message must be a JSON object', raw);
  }
  return parsed as Record<string, unknown>;
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (fenceMatch && fenceMatch[1] !== undefined) return fenceMatch[1].trim();
  return trimmed;
}

function requireString(value: unknown, field: string, raw: string): string {
  if (typeof value !== 'string') {
    throw new ParseError(`field "${field}" must be a string`, raw);
  }
  return value;
}

function dedupeCitationsByUrl(citations: readonly Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
}
