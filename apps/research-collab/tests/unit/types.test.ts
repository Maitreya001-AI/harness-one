import { describe, expect, it } from 'vitest';

import { AGENT_ROLES } from '../../src/types.js';

describe('AGENT_ROLES', () => {
  it('lists exactly the three pipeline roles', () => {
    expect([...AGENT_ROLES]).toEqual(['researcher', 'specialist', 'coordinator']);
  });
});
