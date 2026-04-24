/**
 * Stateless skill registries for prompt composition.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import { HarnessError, HarnessErrorCode } from '../core/errors.js';
import type {
  AsyncSkillRegistry,
  RenderedSkills,
  SkillBackend,
  SkillDefinition,
  SkillRegistry,
  SkillValidationResult,
} from './skill-types.js';
import { DEFAULT_SKILL_VERSION } from './skill-types.js';

/**
 * Numeric semantic version pattern: `1.0.0`, `2.1`, etc.
 *
 * Pre-release (`1.0.0-rc1`) and build-metadata (`1.0.0+sha`) tags are
 * intentionally rejected. See the JSDoc on `SkillDefinition.version`
 * for the rationale. Widen this regex only in lockstep with an
 * explicit ordering rule in `compareSemver`; otherwise two skills can
 * tie on `(id, version)` and silently clobber each other in the
 * registry.
 */
const SEMVER_RE = /^\d+(?:\.\d+)+$/;

function validateSemver(version: string): void {
  if (!SEMVER_RE.test(version)) {
    throw new HarnessError(
      `Invalid skill version: "${version}". Expected numeric semantic version segments such as "1.0.0"`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
    );
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function normalizeSkill(skill: SkillDefinition): SkillDefinition & { version: string; cacheable: boolean } {
  if (typeof skill.id !== 'string' || skill.id.trim().length === 0) {
    throw new HarnessError(
      'Skill id must be a non-empty string',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide a stable skill id such as "customer_support"',
    );
  }
  if (typeof skill.description !== 'string' || skill.description.trim().length === 0) {
    throw new HarnessError(
      `Skill "${skill.id}" description must be a non-empty string`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
    );
  }
  if (typeof skill.content !== 'string' || skill.content.trim().length === 0) {
    throw new HarnessError(
      `Skill "${skill.id}" content must be a non-empty string`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
    );
  }
  const version = skill.version ?? DEFAULT_SKILL_VERSION;
  validateSemver(version);
  if (skill.requiredTools !== undefined) {
    if (!Array.isArray(skill.requiredTools)) {
      throw new HarnessError(
        `Skill "${skill.id}" requiredTools must be an array of tool names`,
        HarnessErrorCode.CORE_INVALID_CONFIG,
      );
    }
    for (const toolName of skill.requiredTools) {
      if (typeof toolName !== 'string' || toolName.trim().length === 0) {
        throw new HarnessError(
          `Skill "${skill.id}" requiredTools must contain only non-empty strings`,
          HarnessErrorCode.CORE_INVALID_CONFIG,
        );
      }
    }
  }

  return Object.freeze({
    id: skill.id,
    version,
    description: skill.description,
    content: skill.content,
    ...(skill.requiredTools !== undefined && { requiredTools: Object.freeze([...skill.requiredTools]) }),
    cacheable: skill.cacheable ?? true,
    ...(skill.metadata !== undefined && { metadata: Object.freeze({ ...skill.metadata }) }),
  });
}

function renderBlock(skill: SkillDefinition & { version: string }): string {
  return [
    `## Skill: ${skill.id}@${skill.version}`,
    skill.content.trim(),
  ].join('\n');
}

function matchesMetadata(
  skill: SkillDefinition,
  filter?: { metadata?: Record<string, unknown> },
): boolean {
  if (!filter?.metadata) return true;
  const metadata = skill.metadata ?? {};
  return Object.entries(filter.metadata).every(([key, value]) => metadata[key] === value);
}

function createValidationResult(
  missingSkills: Set<string>,
  missingTools: Set<string>,
): SkillValidationResult {
  return Object.freeze({
    valid: missingSkills.size === 0 && missingTools.size === 0,
    missingSkills: Object.freeze([...missingSkills]),
    missingTools: Object.freeze([...missingTools]),
  });
}

function normalizeIds(ids: string | readonly string[]): readonly string[] {
  return typeof ids === 'string' ? [ids] : ids;
}

/**
 * Create a synchronous skill registry.
 *
 * The registry is intentionally state-free: it stores immutable skill
 * definitions and can render them, but never tracks turns, stages, or flow.
 */
export function createSkillRegistry(): SkillRegistry {
  const store = new Map<string, Map<string, SkillDefinition & { version: string; cacheable: boolean }>>();
  const latestVersions = new Map<string, string>();

  function getLatestVersion(id: string): SkillDefinition | undefined {
    const latest = latestVersions.get(id);
    if (!latest) return undefined;
    return store.get(id)?.get(latest);
  }

  return {
    register(skill) {
      const normalized = normalizeSkill(skill);
      let versions = store.get(normalized.id);
      if (!versions) {
        versions = new Map();
        store.set(normalized.id, versions);
      }
      versions.set(normalized.version, normalized);

      const existingLatest = latestVersions.get(normalized.id);
      if (!existingLatest || compareSemver(normalized.version, existingLatest) > 0) {
        latestVersions.set(normalized.id, normalized.version);
      }
    },

    get(id, version) {
      const versions = store.get(id);
      if (!versions) return undefined;
      if (version !== undefined) return versions.get(version);
      return getLatestVersion(id);
    },

    has(id) {
      return store.has(id);
    },

    list(filter) {
      const result: SkillDefinition[] = [];
      for (const versions of store.values()) {
        for (const skill of versions.values()) {
          if (matchesMetadata(skill, filter)) {
            result.push(skill);
          }
        }
      }
      result.sort((a, b) => {
        if (a.id === b.id) {
          return compareSemver((b.version ?? DEFAULT_SKILL_VERSION), (a.version ?? DEFAULT_SKILL_VERSION));
        }
        return a.id.localeCompare(b.id);
      });
      return result;
    },

    render(ids) {
      const requested = normalizeIds(ids);
      const resolved = requested.map((id) => {
        const skill = this.get(id);
        if (!skill) {
          throw new HarnessError(
            `Skill not found: ${id}`,
            HarnessErrorCode.PROMPT_SKILL_NOT_FOUND,
            'Register the skill before rendering it',
          );
        }
        return skill as SkillDefinition & { version: string; cacheable: boolean };
      });

      const ordered = [
        ...resolved.filter((skill) => skill.cacheable),
        ...resolved.filter((skill) => !skill.cacheable),
      ];
      const content = ordered.map(renderBlock).join('\n\n');
      const stableHash = createHash('sha256').update(content).digest('hex');
      const rendered = ordered.map((skill) => Object.freeze({ id: skill.id, version: skill.version }));

      return Object.freeze({
        content,
        rendered: Object.freeze(rendered),
        stableHash,
      }) satisfies RenderedSkills;
    },

    validate(ids, availableToolNames) {
      const toolNames = new Set(availableToolNames);
      const missingSkills = new Set<string>();
      const missingTools = new Set<string>();

      for (const id of ids) {
        const skill = this.get(id);
        if (!skill) {
          missingSkills.add(id);
          continue;
        }
        for (const toolName of skill.requiredTools ?? []) {
          if (!toolNames.has(toolName)) {
            missingTools.add(toolName);
          }
        }
      }

      return createValidationResult(missingSkills, missingTools);
    },

    size() {
      let total = 0;
      for (const versions of store.values()) total += versions.size;
      return total;
    },

    clear() {
      store.clear();
      latestVersions.clear();
    },
  };
}

/**
 * Create an async skill registry backed by a remote source plus local cache.
 *
 * Reads prefer the local cache and only hit the backend on misses.
 */
export function createAsyncSkillRegistry(backend: SkillBackend): AsyncSkillRegistry {
  const local = createSkillRegistry();

  async function ensureSkill(id: string, version?: string): Promise<SkillDefinition | undefined> {
    const cached = local.get(id, version);
    if (cached) return cached;

    const fetched = await backend.fetch(id, version);
    if (!fetched) return undefined;
    local.register(fetched);
    return local.get(id, version ?? fetched.version);
  }

  return {
    register(skill) {
      local.register(skill);
    },

    has(id) {
      return local.has(id);
    },

    list(filter) {
      return local.list(filter);
    },

    size() {
      return local.size();
    },

    clear() {
      local.clear();
    },

    async get(id, version) {
      return ensureSkill(id, version);
    },

    async render(ids) {
      const requested = normalizeIds(ids);
      await Promise.all(requested.map((id) => ensureSkill(id)));
      return local.render(requested);
    },

    async validate(ids, availableToolNames) {
      await Promise.all(ids.map((id) => ensureSkill(id)));
      return local.validate(ids, availableToolNames);
    },

    async prefetch(ids) {
      await Promise.all(ids.map((id) => ensureSkill(id)));
    },
  };
}
