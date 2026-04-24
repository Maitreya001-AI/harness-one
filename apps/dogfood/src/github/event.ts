import { readFile } from 'node:fs/promises';

export interface IssueEvent {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly author: string;
  readonly isBot: boolean;
}

/**
 * Raised when the GITHUB_EVENT_PATH file can't be parsed into an issue
 * opened event. Triggers a clean exit from the entry point.
 */
export class EventParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventParseError';
  }
}

/**
 * Parse an `issues: opened` event payload. The path layout follows
 * <https://docs.github.com/webhooks/webhook-events-and-payloads#issues>.
 *
 * We only extract the fields the triage loop needs; anything missing is an
 * error so we never fall back to "unknown body" and waste an API call.
 */
export async function readIssueEvent(path: string): Promise<IssueEvent> {
  const raw = await readFile(path, 'utf8');
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (cause) {
    throw new EventParseError(
      `GITHUB_EVENT_PATH is not valid JSON: ${(cause as Error).message}`,
    );
  }
  if (!payload || typeof payload !== 'object') {
    throw new EventParseError('event payload must be an object');
  }
  const rec = payload as Record<string, unknown>;
  const action = rec['action'];
  if (action !== 'opened') {
    throw new EventParseError(
      `expected action=opened, got action=${JSON.stringify(action)}`,
    );
  }
  const issue = rec['issue'];
  if (!issue || typeof issue !== 'object') {
    throw new EventParseError('missing issue field');
  }
  const issueRec = issue as Record<string, unknown>;
  const number = issueRec['number'];
  if (typeof number !== 'number' || !Number.isInteger(number)) {
    throw new EventParseError('issue.number must be an integer');
  }
  const title = typeof issueRec['title'] === 'string' ? issueRec['title'] : '';
  const body = typeof issueRec['body'] === 'string' ? issueRec['body'] : '';
  const url = typeof issueRec['html_url'] === 'string' ? issueRec['html_url'] : '';
  const user = issueRec['user'];
  const userRec = user && typeof user === 'object' ? (user as Record<string, unknown>) : {};
  const author = typeof userRec['login'] === 'string' ? userRec['login'] : 'unknown';
  const isBot = userRec['type'] === 'Bot';
  return { number, title, body, url, author, isBot };
}
