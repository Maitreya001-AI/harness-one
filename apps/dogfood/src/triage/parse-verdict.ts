import type {
  AllowedLabel,
  DuplicateCandidate,
  DuplicateConfidence,
  TriageVerdict,
} from '../types.js';
import { isAllowedLabel } from '../types.js';

/**
 * Raised when the model's final message can't be parsed into a TriageVerdict.
 * The entry point catches this, records the raw message in the report, and
 * exits without posting a comment.
 */
export class VerdictParseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'VerdictParseError';
  }
}

const CONFIDENCE_VALUES: readonly DuplicateConfidence[] = ['high', 'medium', 'low'];

function isConfidence(value: unknown): value is DuplicateConfidence {
  return typeof value === 'string' && (CONFIDENCE_VALUES as readonly string[]).includes(value);
}

function coerceString(value: unknown, field: string, raw: string): string {
  if (typeof value !== 'string') {
    throw new VerdictParseError(`field "${field}" must be a string`, raw);
  }
  return value;
}

function coerceStringArray(value: unknown, field: string, raw: string): string[] {
  if (!Array.isArray(value)) {
    throw new VerdictParseError(`field "${field}" must be an array`, raw);
  }
  return value.map((entry, i) => coerceString(entry, `${field}[${i}]`, raw));
}

/**
 * Strip markdown code fences and leading prose. Most Anthropic Sonnet outputs
 * come back as a clean JSON object, but the occasional "```json ... ```" leak
 * is common enough to be worth tolerating here rather than re-prompting.
 */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (fenceMatch && fenceMatch[1] !== undefined) return fenceMatch[1].trim();
  return trimmed;
}

/**
 * Parse the model's final message into a validated {@link TriageVerdict}.
 *
 * Any unknown labels, missing fields, or type mismatches throw
 * {@link VerdictParseError}. The caller is responsible for logging the raw
 * message and bailing out of the comment post.
 */
export function parseVerdict(raw: string): TriageVerdict {
  const text = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new VerdictParseError(
      `final message is not valid JSON: ${(cause as Error).message}`,
      raw,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VerdictParseError('final message must be a JSON object', raw);
  }
  const obj = parsed as Record<string, unknown>;

  const rawLabels = coerceStringArray(obj['suggestedLabels'], 'suggestedLabels', raw);
  const suggestedLabels: AllowedLabel[] = [];
  for (const label of rawLabels) {
    if (isAllowedLabel(label) && !suggestedLabels.includes(label)) {
      suggestedLabels.push(label);
    }
  }

  const rawDups = obj['duplicates'];
  if (!Array.isArray(rawDups)) {
    throw new VerdictParseError('field "duplicates" must be an array', raw);
  }
  const duplicates: DuplicateCandidate[] = rawDups.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new VerdictParseError(`duplicates[${i}] must be an object`, raw);
    }
    const rec = entry as Record<string, unknown>;
    const issueNumber = rec['issueNumber'];
    if (typeof issueNumber !== 'number' || !Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new VerdictParseError(
        `duplicates[${i}].issueNumber must be a positive integer`,
        raw,
      );
    }
    const title = coerceString(rec['title'], `duplicates[${i}].title`, raw);
    const url = coerceString(rec['url'], `duplicates[${i}].url`, raw);
    if (!/^https:\/\/github\.com\//.test(url)) {
      throw new VerdictParseError(
        `duplicates[${i}].url must be a https://github.com/... URL`,
        raw,
      );
    }
    const confidence = rec['confidence'];
    if (!isConfidence(confidence)) {
      throw new VerdictParseError(
        `duplicates[${i}].confidence must be one of high|medium|low`,
        raw,
      );
    }
    return { issueNumber, title, url, confidence };
  });

  const reproSteps = coerceStringArray(obj['reproSteps'], 'reproSteps', raw).slice(0, 5);
  const rationale = coerceString(obj['rationale'], 'rationale', raw).slice(0, 200);

  return { suggestedLabels, duplicates, reproSteps, rationale };
}
