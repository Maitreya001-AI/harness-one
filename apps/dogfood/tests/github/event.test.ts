import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EventParseError, readIssueEvent } from '../../src/github/event.js';

async function writeFixture(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dogfood-event-'));
  const path = join(dir, 'event.json');
  await writeFile(path, content, 'utf8');
  return path;
}

describe('readIssueEvent', () => {
  it('parses a valid issues.opened payload', async () => {
    const path = await writeFixture(
      JSON.stringify({
        action: 'opened',
        issue: {
          number: 42,
          title: 'broken',
          body: 'body',
          html_url: 'https://github.com/acme/x/issues/42',
          user: { login: 'alice', type: 'User' },
        },
      }),
    );
    const evt = await readIssueEvent(path);
    expect(evt.number).toBe(42);
    expect(evt.title).toBe('broken');
    expect(evt.isBot).toBe(false);
    expect(evt.author).toBe('alice');
  });

  it('marks bot authors', async () => {
    const path = await writeFixture(
      JSON.stringify({
        action: 'opened',
        issue: {
          number: 1,
          title: '',
          body: '',
          user: { login: 'dependabot[bot]', type: 'Bot' },
        },
      }),
    );
    const evt = await readIssueEvent(path);
    expect(evt.isBot).toBe(true);
  });

  it('rejects actions other than opened', async () => {
    const path = await writeFixture(
      JSON.stringify({ action: 'edited', issue: { number: 1 } }),
    );
    await expect(readIssueEvent(path)).rejects.toBeInstanceOf(EventParseError);
  });

  it('rejects invalid JSON', async () => {
    const path = await writeFixture('not json');
    await expect(readIssueEvent(path)).rejects.toBeInstanceOf(EventParseError);
  });

  it('rejects payloads missing issue.number', async () => {
    const path = await writeFixture(JSON.stringify({ action: 'opened', issue: {} }));
    await expect(readIssueEvent(path)).rejects.toBeInstanceOf(EventParseError);
  });
});
