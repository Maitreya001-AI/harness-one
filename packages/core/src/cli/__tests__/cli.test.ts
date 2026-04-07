import { describe, it, expect } from 'vitest';
import { parseArgs, getTemplate, auditProject, ALL_MODULES } from '../index.js';
import type { ModuleName } from '../index.js';

describe('CLI argument parser', () => {
  it('parses "init --all"', () => {
    const result = parseArgs(['node', 'harness-one', 'init', '--all']);
    expect(result.command).toBe('init');
    expect(result.all).toBe(true);
    expect(result.modules).toEqual([...ALL_MODULES]);
  });

  it('parses "init --modules core,tools"', () => {
    const result = parseArgs(['node', 'harness-one', 'init', '--modules', 'core,tools']);
    expect(result.command).toBe('init');
    expect(result.all).toBe(false);
    expect(result.modules).toEqual(['core', 'tools']);
  });

  it('parses "audit" command', () => {
    const result = parseArgs(['node', 'harness-one', 'audit']);
    expect(result.command).toBe('audit');
  });

  it('returns help for unknown commands', () => {
    const result = parseArgs(['node', 'harness-one', 'unknown']);
    expect(result.command).toBe('help');
  });

  it('returns help when no command given', () => {
    const result = parseArgs(['node', 'harness-one']);
    expect(result.command).toBe('help');
  });

  it('filters invalid module names', () => {
    const result = parseArgs(['node', 'harness-one', 'init', '--modules', 'core,invalid,tools']);
    expect(result.modules).toEqual(['core', 'tools']);
  });
});

describe('Template generation', () => {
  it('returns a template for every module', () => {
    for (const mod of ALL_MODULES) {
      const template = getTemplate(mod);
      expect(template).toBeTruthy();
      expect(template.length).toBeGreaterThan(50);
    }
  });

  it('templates use correct import paths', () => {
    for (const mod of ALL_MODULES) {
      const template = getTemplate(mod);
      expect(template).toContain(`harness-one/${mod === 'core' ? 'core' : mod}`);
    }
  });

  it('core template imports AgentLoop', () => {
    const template = getTemplate('core');
    expect(template).toContain('AgentLoop');
    expect(template).toContain("from 'harness-one/core'");
  });
});

describe('Audit logic', () => {
  it('returns empty when scanning a non-existent directory', () => {
    const result = auditProject('/tmp/nonexistent-harness-audit-test');
    expect(result.used).toEqual([]);
    expect(result.unused).toEqual([...ALL_MODULES]);
    expect(result.fileCount).toBe(0);
  });
});
