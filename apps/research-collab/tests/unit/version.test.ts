import { describe, expect, it } from 'vitest';

import { readVersions } from '../../src/cli/version.js';

describe('readVersions', () => {
  it('returns the app version from package.json', () => {
    const v = readVersions();
    expect(v.app).toMatch(/^\d+\.\d+\.\d+/);
    expect(v.harness).toMatch(/^\d+\.\d+\.\d+/);
  });
});
