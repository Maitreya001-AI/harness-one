import { describe, expect, it } from 'vitest';

import { HarnessError } from '../../core/errors.js';
import { createAsyncSkillRegistry, createSkillRegistry } from '../skill-registry.js';
import { DEFAULT_SKILL_VERSION } from '../skill-types.js';
import type { SkillDefinition } from '../skill-types.js';

const SUPPORT_SKILL: SkillDefinition = {
  id: 'customer_support',
  description: 'Customer support workflow',
  content: 'Ask clarifying questions, use tools when needed, and confirm resolution.',
  requiredTools: ['lookup_order', 'search_kb'],
};

describe('createSkillRegistry', () => {
  it('registers and retrieves the latest version by default', () => {
    const registry = createSkillRegistry();
    registry.register(SUPPORT_SKILL);
    registry.register({
      ...SUPPORT_SKILL,
      version: '1.1.0',
      content: 'Updated support workflow.',
    });

    expect(registry.get('customer_support')).toEqual(
      expect.objectContaining({
        id: 'customer_support',
        version: '1.1.0',
        cacheable: true,
      }),
    );
    expect(registry.get('customer_support', DEFAULT_SKILL_VERSION)).toEqual(
      expect.objectContaining({
        version: DEFAULT_SKILL_VERSION,
        content: SUPPORT_SKILL.content,
      }),
    );
  });

  it('lists all registered versions and filters by metadata', () => {
    const registry = createSkillRegistry();
    registry.register({
      id: 'safety',
      version: '1.0.0',
      description: 'Safety policy',
      content: 'Always respect policy.',
      metadata: { domain: 'global', owner: 'trust' },
    });
    registry.register({
      id: 'safety',
      version: '1.1.0',
      description: 'Safety policy',
      content: 'Always respect updated policy.',
      metadata: { domain: 'global', owner: 'trust' },
    });
    registry.register({
      id: 'billing',
      description: 'Billing workflow',
      content: 'Handle invoices.',
      metadata: { domain: 'finance', owner: 'ops' },
    });

    expect(registry.list()).toHaveLength(3);
    expect(registry.list({ metadata: { owner: 'trust' } })).toEqual([
      expect.objectContaining({ id: 'safety', version: '1.1.0' }),
      expect.objectContaining({ id: 'safety', version: '1.0.0' }),
    ]);
  });

  it('renders cacheable skills first and returns a stable hash', () => {
    const registry = createSkillRegistry();
    registry.register({
      id: 'dynamic_policy',
      description: 'Per-request policy',
      content: 'Dynamic instructions.',
      cacheable: false,
    });
    registry.register({
      id: 'safety_policy',
      description: 'Stable safety policy',
      content: 'Stable instructions.',
      cacheable: true,
    });

    const rendered = registry.render(['dynamic_policy', 'safety_policy']);

    expect(rendered.rendered).toEqual([
      { id: 'safety_policy', version: DEFAULT_SKILL_VERSION },
      { id: 'dynamic_policy', version: DEFAULT_SKILL_VERSION },
    ]);
    expect(rendered.content).toContain('## Skill: safety_policy@1.0.0');
    expect(rendered.content.indexOf('safety_policy')).toBeLessThan(
      rendered.content.indexOf('dynamic_policy'),
    );
    expect(rendered.stableHash).toMatch(/^[a-f0-9]{64}$/);
    expect(registry.render(['dynamic_policy', 'safety_policy']).stableHash).toBe(rendered.stableHash);
  });

  it('validates missing tools and missing skills separately', () => {
    const registry = createSkillRegistry();
    registry.register(SUPPORT_SKILL);

    expect(
      registry.validate(['customer_support', 'missing'], ['lookup_order']),
    ).toEqual({
      valid: false,
      missingSkills: ['missing'],
      missingTools: ['search_kb'],
    });
  });

  it('throws when rendering an unknown skill', () => {
    const registry = createSkillRegistry();
    expect(() => registry.render(['missing'])).toThrow(HarnessError);
  });

  it('tracks size, clear, and has without runtime state', () => {
    const registry = createSkillRegistry();
    registry.register(SUPPORT_SKILL);
    registry.register({
      id: 'report_stage',
      description: 'Stage-reporting helper',
      content: 'Call this whenever the stage changes.',
    });

    expect(registry.size()).toBe(2);
    expect(registry.has('report_stage')).toBe(true);
    registry.clear();
    expect(registry.size()).toBe(0);
    expect(registry.has('report_stage')).toBe(false);
  });

  it('rejects invalid skill definitions early', () => {
    const registry = createSkillRegistry();
    expect(() =>
      registry.register({
        id: '',
        description: 'bad',
        content: 'bad',
      }),
    ).toThrow(HarnessError);
    expect(() =>
      registry.register({
        id: 'bad-version',
        version: 'latest',
        description: 'bad',
        content: 'bad',
      }),
    ).toThrow(HarnessError);
  });
});

describe('createAsyncSkillRegistry', () => {
  it('prefers local cache, falls back to the backend, and renders fetched skills', async () => {
    const fetchCalls: Array<{ id: string; version?: string }> = [];
    const registry = createAsyncSkillRegistry({
      async fetch(id, version) {
        fetchCalls.push({ id, version });
        if (id === 'customer_support') {
          return {
            ...SUPPORT_SKILL,
            version: version ?? '2.0.0',
            content: 'Remote support workflow.',
          };
        }
        return null;
      },
    });

    expect(await registry.get('customer_support')).toEqual(
      expect.objectContaining({ version: '2.0.0' }),
    );
    expect(await registry.get('customer_support')).toEqual(
      expect.objectContaining({ version: '2.0.0' }),
    );
    const rendered = await registry.render(['customer_support']);
    expect(rendered.rendered).toEqual([{ id: 'customer_support', version: '2.0.0' }]);
    expect(fetchCalls).toEqual([{ id: 'customer_support', version: undefined }]);
  });

  it('supports prefetch and validate against the warmed local cache', async () => {
    const registry = createAsyncSkillRegistry({
      async fetch(id) {
        if (id === 'customer_support') {
          return SUPPORT_SKILL;
        }
        return null;
      },
    });

    await registry.prefetch(['customer_support']);
    expect(registry.list()).toEqual([
      expect.objectContaining({ id: 'customer_support', version: DEFAULT_SKILL_VERSION }),
    ]);
    expect(await registry.validate(['customer_support'], ['lookup_order'])).toEqual({
      valid: false,
      missingSkills: [],
      missingTools: ['search_kb'],
    });
  });
});
