/**
 * Adversarial tests for the redact pipeline.
 *
 * Goal: feed every secret-shaped value we realistically expect to see in
 * production logs/traces through `sanitizeAttributes` / `redactValue` and
 * assert that the secret never survives into the output.
 *
 * Context for readers: the current redactor matches by KEY name, not by
 * value content. That is a deliberate design choice (regex-matching
 * every string value would be too slow for the hot path) but it also
 * means the redactor assumes secrets are stored under well-named keys.
 * This file encodes that assumption as executable tests: for every
 * secret pattern that matters, we cover both the happy path (secret
 * lives under a known key like `api_key`) and adversarial paths where a
 * secret could plausibly leak because it's nested somewhere unusual.
 *
 * Failures here should not be patched in this PR — per track-M
 * discipline, each failing pattern becomes an issue. The policy is
 * documented in `docs/security/ossf-best-practices.md` (action items).
 */

import { describe, expect, it } from 'vitest';

import {
  createRedactor,
  redactValue,
  sanitizeAttributes,
  REDACTED_VALUE,
} from '../../src/redact/index.js';

const redactor = createRedactor();

/**
 * Walk a (redacted) value and collect every string found anywhere in
 * the tree. Lets us assert "the secret substring does not appear in the
 * output anywhere" without caring about the exact shape of the output.
 */
function collectStrings(value: unknown): string[] {
  const out: string[] = [];
  const seen = new WeakSet<object>();
  function walk(v: unknown): void {
    if (typeof v === 'string') {
      out.push(v);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    if (seen.has(v as object)) return;
    seen.add(v as object);
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    for (const val of Object.values(v as Record<string, unknown>)) walk(val);
  }
  walk(value);
  return out;
}

function assertSecretAbsent(output: unknown, secret: string): void {
  const strings = collectStrings(output);
  for (const s of strings) {
    expect(s, `secret '${secret.slice(0, 16)}…' leaked as ${JSON.stringify(s).slice(0, 80)}`).not.toContain(
      secret,
    );
  }
}

// ---------------------------------------------------------------------
// Secret catalogue. Every entry pairs a realistic secret token with the
// field name under which it is expected to live. `alwaysFails: true`
// marks patterns we KNOW the current key-based redactor cannot catch —
// those are tracked as follow-up issues rather than fixed in this PR.
// ---------------------------------------------------------------------

interface Pattern {
  readonly name: string;
  readonly secret: string;
  readonly key: string;
  /**
   * When true, the test asserts the secret is masked. When false, the
   * test documents a known limitation by asserting the secret is NOT
   * masked, so we get a test failure the day the redactor is extended
   * to cover the case.
   */
  readonly expectsMasked?: boolean;
}

const patterns: readonly Pattern[] = [
  {
    name: 'anthropic sk-ant key under `api_key`',
    secret: 'sk-ant-api03-' + 'A'.repeat(80) + '-abCD',
    key: 'api_key',
  },
  {
    name: 'openai sk- key under `apiKey`',
    secret: 'sk-proj-' + 'B'.repeat(48),
    key: 'apiKey',
  },
  {
    name: 'openai sk- key under `openai_api_key`',
    secret: 'sk-' + 'C'.repeat(48),
    key: 'openai_api_key',
  },
  {
    name: 'AWS access key id (AKIA) under `access_key`',
    secret: 'AKIAIOSFODNN7EXAMPLE',
    key: 'access_key',
  },
  {
    name: 'AWS temporary creds (ASIA) under `accessKey`',
    secret: 'ASIAZZZZZZZZZZZZZZZZ',
    key: 'accessKey',
  },
  {
    name: 'GitHub personal access token under `authorization`',
    secret: 'ghp_' + 'D'.repeat(36),
    key: 'authorization',
  },
  {
    name: 'GitHub OAuth token (gho_) under `auth_token`',
    secret: 'gho_' + 'E'.repeat(36),
    key: 'auth_token',
  },
  {
    name: 'GitHub server-to-server (ghs_) under `token`',
    secret: 'ghs_' + 'F'.repeat(36),
    key: 'token',
  },
  {
    name: 'JWT under `authorization`',
    // A syntactically valid JWT (header.payload.signature, all base64url).
    secret:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkphbmUgRG9lIn0.' +
      'KMUFsIDTnFmyG3nMiGM6H9FNFUROf3wh7SmqJp-QV30',
    key: 'authorization',
  },
  {
    name: 'bearer prefix under `Authorization`',
    secret: 'Bearer sk-ant-' + 'X'.repeat(60),
    key: 'Authorization',
  },
  {
    name: 'PEM private key under `private_key`',
    secret:
      '-----BEGIN RSA PRIVATE KEY-----\n' +
      'MIIEowIBAAKCAQEAq7J7nQ8sKj4\n' +
      '-----END RSA PRIVATE KEY-----',
    key: 'private_key',
  },
  {
    name: 'bcrypt-ish password hash under `password`',
    secret: '$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    key: 'password',
  },
  {
    name: 'session cookie under `cookie`',
    secret: 'sid=s%3AZZZZZZZZZZZZZZZZZZZZZZZZ.YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
    key: 'cookie',
  },
  {
    name: 'refresh token under `refresh_token`',
    secret: '1//0' + 'R'.repeat(64),
    key: 'refresh_token',
  },
  {
    name: 'Langfuse public/secret pair under `secret`',
    secret: 'lf_sk_' + 'G'.repeat(40),
    key: 'secret',
  },
  {
    name: 'camelCase key `apiToken` (no separator between `api` and `token`)',
    // KNOWN LIMITATION: DEFAULT_SECRET_PATTERN anchors each sub-keyword
    // with `(^|[._-])` and `([._-]|$)`. The key `apiToken` has no
    // separator between `api` and `token`, so neither the `api[_-]?key`
    // nor the standalone `token` alternative matches. Documented here
    // so the day the regex grows camelCase-boundary detection this
    // test flips green and becomes a regression guard.
    secret: 'prod-' + 'H'.repeat(40),
    key: 'apiToken',
    expectsMasked: false,
  },
  {
    name: 'camelCase key `sessionId`',
    secret: 'sess_' + 'I'.repeat(40),
    key: 'sessionId',
  },
  {
    name: 'anthropic key embedded in a URL query under `url`',
    // KNOWN LIMITATION: redactor matches by key; `url` is not a secret
    // key, so a secret baked into the value survives. This is expected
    // to fail once we grow a value-level scrubber — the assertion
    // below currently documents the gap.
    secret:
      'https://api.example.com/v1/things?api_key=sk-ant-' + 'Z'.repeat(64),
    key: 'url',
    expectsMasked: false,
  },
  {
    name: 'JSON blob containing Authorization header under `body`',
    // Same known limitation as above: `body` is a free-text field; the
    // embedded Authorization value survives because the redactor does
    // not recurse into parsed JSON strings.
    secret:
      '{"Authorization":"Bearer sk-ant-' +
      'Y'.repeat(60) +
      '","user":"alice"}',
    key: 'body',
    expectsMasked: false,
  },
  {
    name: 'key with utf-8 + CJK noise still matches `api_key`',
    secret: 'sk-ant-中文-' + 'J'.repeat(60) + '-密钥',
    key: 'api_key',
  },
  {
    name: 'multi-line secret (CR/LF) under `credential`',
    secret: 'line-one-' + 'K'.repeat(32) + '\r\nline-two-' + 'L'.repeat(32),
    key: 'credential',
  },
  {
    name: 'uppercase header variant `AUTHORIZATION`',
    secret: 'Bearer ' + 'M'.repeat(64),
    key: 'AUTHORIZATION',
  },
  {
    name: 'dot-path `request.headers.x-api-key`',
    // KNOWN LIMITATION: redactor inspects each leaf key in isolation.
    // `x-api-key` contains a hyphen-api- segment, which the default
    // regex does match — so this case IS covered. Kept here so that if
    // the regex weakens, this test goes red.
    secret: 'secret-' + 'N'.repeat(48),
    key: 'x-api-key',
  },
];

describe('redact adversarial: secret patterns', () => {
  for (const p of patterns) {
    const label = `${p.name}${p.expectsMasked === false ? ' [known-gap]' : ''}`;
    it(label, () => {
      const input = { [p.key]: p.secret, unrelated: 'value-ok' };
      const out = sanitizeAttributes(input, redactor) as Record<
        string,
        unknown
      >;
      if (p.expectsMasked === false) {
        // Documents a known gap. When the redactor is extended to cover
        // this case, this assertion flips and the test turns into a
        // regression guard instead of a gap doc.
        expect(out[p.key]).toBe(p.secret);
      } else {
        expect(out[p.key]).toBe(REDACTED_VALUE);
        assertSecretAbsent(out, p.secret);
      }
      // Unrelated keys must survive untouched regardless.
      expect(out['unrelated']).toBe('value-ok');
    });
  }

  it('covers at least 15 distinct patterns (DoD requirement)', () => {
    expect(patterns.length).toBeGreaterThanOrEqual(15);
  });
});

describe('redact adversarial: nested / truncated shapes', () => {
  it('masks a secret nested 4 levels deep under a matching key', () => {
    const secret = 'sk-ant-' + 'P'.repeat(80);
    const input = {
      outer: {
        middle: {
          inner: {
            apiKey: secret,
            safe: 'keep-me',
          },
        },
      },
    };
    const out = redactValue(input, redactor) as {
      outer: { middle: { inner: { apiKey: string; safe: string } } };
    };
    expect(out.outer.middle.inner.apiKey).toBe(REDACTED_VALUE);
    expect(out.outer.middle.inner.safe).toBe('keep-me');
    assertSecretAbsent(out, secret);
  });

  it('masks secret-under-secret-key even when value is truncated', () => {
    const truncated = 'sk-ant-truncated-';
    const out = sanitizeAttributes({ api_key: truncated }, redactor);
    expect((out as { api_key: string }).api_key).toBe(REDACTED_VALUE);
  });

  it('masks secret inside an array element under a matching key', () => {
    const secret = 'ghp_' + 'Q'.repeat(36);
    const out = sanitizeAttributes(
      { items: [{ token: secret, name: 'alice' }] },
      redactor,
    ) as { items: Array<{ token: string; name: string }> };
    expect(out.items[0].token).toBe(REDACTED_VALUE);
    expect(out.items[0].name).toBe('alice');
    assertSecretAbsent(out, secret);
  });

  it('drops prototype-polluting keys (__proto__, constructor, prototype)', () => {
    const input = {
      __proto__: { polluted: true },
      constructor: { polluted: true },
      prototype: { polluted: true },
      safe: 'ok',
    };
    const out = sanitizeAttributes(input, redactor);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'constructor')).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(out, 'prototype')).toBe(false);
    expect((out as { safe: string }).safe).toBe('ok');
    // Prototype must not have been polluted.
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
