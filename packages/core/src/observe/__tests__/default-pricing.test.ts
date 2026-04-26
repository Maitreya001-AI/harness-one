/**
 * Tests for `defaultModelPricing` snapshot + the construction-time warning
 * when `createCostTracker` is given a budget but no pricing.
 */
import { describe, it, expect } from 'vitest';
import {
  defaultModelPricing,
  DEFAULT_PRICING_SNAPSHOT_DATE,
  getDefaultPricing,
} from '../default-pricing.js';
import { createCostTracker } from '../cost-tracker.js';
import { priceUsage } from '../../core/pricing.js';
import type { Logger } from '../logger.js';

function createCapturingLogger(): {
  logger: Logger;
  warns: Array<{ msg: string; meta?: Record<string, unknown> }>;
} {
  const warns: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  const logger: Logger = {
    info: () => {},
    warn: (msg: string, meta?: Record<string, unknown>) => {
      warns.push({ msg, ...(meta !== undefined && { meta }) });
    },
    error: () => {},
    debug: () => {},
  } as unknown as Logger;
  return { logger, warns };
}

describe('defaultModelPricing', () => {
  it('exposes a non-empty, frozen snapshot', () => {
    expect(defaultModelPricing.length).toBeGreaterThan(0);
    expect(Object.isFrozen(defaultModelPricing)).toBe(true);
  });

  it('snapshot date is a valid ISO date', () => {
    expect(DEFAULT_PRICING_SNAPSHOT_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isFinite(Date.parse(DEFAULT_PRICING_SNAPSHOT_DATE))).toBe(true);
  });

  it('every entry has finite, non-negative input/output rates', () => {
    for (const p of defaultModelPricing) {
      expect(typeof p.model).toBe('string');
      expect(p.model.length).toBeGreaterThan(0);
      expect(Number.isFinite(p.inputPer1kTokens)).toBe(true);
      expect(p.inputPer1kTokens).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(p.outputPer1kTokens)).toBe(true);
      expect(p.outputPer1kTokens).toBeGreaterThanOrEqual(0);
      if (p.cacheReadPer1kTokens !== undefined) {
        expect(p.cacheReadPer1kTokens).toBeGreaterThanOrEqual(0);
      }
      if (p.cacheWritePer1kTokens !== undefined) {
        expect(p.cacheWritePer1kTokens).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('Claude entries follow the documented cache-pricing ratios', () => {
    // Claude prompt-caching: write = 1.25x input, read = 0.10x input.
    const claudeEntries = defaultModelPricing.filter((p) => p.model.startsWith('claude-'));
    expect(claudeEntries.length).toBeGreaterThan(0);
    for (const p of claudeEntries) {
      expect(p.cacheWritePer1kTokens).toBeDefined();
      expect(p.cacheReadPer1kTokens).toBeDefined();
      const expectedWrite = +(p.inputPer1kTokens * 1.25).toFixed(8);
      const expectedRead = +(p.inputPer1kTokens * 0.1).toFixed(8);
      expect(+p.cacheWritePer1kTokens!.toFixed(8)).toBeCloseTo(expectedWrite, 6);
      expect(+p.cacheReadPer1kTokens!.toFixed(8)).toBeCloseTo(expectedRead, 6);
    }
  });

  it('OpenAI entries omit cache pricing (Anthropic-only feature)', () => {
    const openaiEntries = defaultModelPricing.filter((p) => p.model.startsWith('gpt-'));
    expect(openaiEntries.length).toBeGreaterThan(0);
    for (const p of openaiEntries) {
      expect(p.cacheReadPer1kTokens).toBeUndefined();
      expect(p.cacheWritePer1kTokens).toBeUndefined();
    }
  });

  it('contains no duplicate model identifiers', () => {
    const seen = new Set<string>();
    for (const p of defaultModelPricing) {
      expect(seen.has(p.model)).toBe(false);
      seen.add(p.model);
    }
  });

  describe('getDefaultPricing', () => {
    it('returns the matching entry for a known model', () => {
      const entry = getDefaultPricing('claude-sonnet-4-6');
      expect(entry).toBeDefined();
      expect(entry?.model).toBe('claude-sonnet-4-6');
    });

    it('returns undefined for unknown models — caller must NOT treat that as $0', () => {
      expect(getDefaultPricing('not-a-real-model')).toBeUndefined();
    });
  });

  it('plays correctly with priceUsage()', () => {
    const sonnet = getDefaultPricing('claude-sonnet-4-6')!;
    const cost = priceUsage(
      { traceId: 't', model: sonnet.model, inputTokens: 10_000, outputTokens: 1_000 },
      sonnet,
    );
    // 10k * 0.003/1k = 0.03; 1k * 0.015/1k = 0.015 → total 0.045 USD
    expect(cost).toBeCloseTo(0.045, 6);
  });
});

describe('createCostTracker — budget without pricing emits a loud warning', () => {
  it('warns at construction when budget is set but pricing is empty', () => {
    const { logger, warns } = createCapturingLogger();
    createCostTracker({ budget: 5.0, logger });
    const found = warns.find((w) => w.msg.includes('budget is set but no pricing'));
    expect(found).toBeDefined();
    expect(found?.meta).toMatchObject({ budget: 5.0 });
  });

  it('does not warn when both budget and pricing are supplied', () => {
    const { logger, warns } = createCapturingLogger();
    createCostTracker({
      budget: 5.0,
      pricing: [
        { model: 'm', inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 },
      ],
      logger,
    });
    const found = warns.find((w) => w.msg.includes('budget is set but no pricing'));
    expect(found).toBeUndefined();
  });

  it('does not warn when neither budget nor pricing is supplied', () => {
    const { logger, warns } = createCapturingLogger();
    createCostTracker({ logger });
    const found = warns.find((w) => w.msg.includes('budget is set but no pricing'));
    expect(found).toBeUndefined();
  });

  it('does not warn when budget is zero (treat as "no budget")', () => {
    const { logger, warns } = createCapturingLogger();
    createCostTracker({ budget: 0, logger });
    const found = warns.find((w) => w.msg.includes('budget is set but no pricing'));
    expect(found).toBeUndefined();
  });

  it('warns when budget is set + pricing is an empty array (caller mistake)', () => {
    const { logger, warns } = createCapturingLogger();
    createCostTracker({ budget: 5.0, pricing: [], logger });
    const found = warns.find((w) => w.msg.includes('budget is set but no pricing'));
    expect(found).toBeDefined();
  });

  it('warning hint mentions defaultModelPricing as the canonical fix', () => {
    const { logger, warns } = createCapturingLogger();
    createCostTracker({ budget: 1, logger });
    const found = warns.find((w) => w.msg.includes('budget is set but no pricing'));
    expect(found?.msg).toContain('defaultModelPricing');
    expect(found?.msg).toContain('harness-one/observe');
  });

  it('warning is non-fatal even when caller logger throws', () => {
    const throwingLogger = {
      info: () => {},
      warn: () => {
        throw new Error('logger explosion');
      },
      error: () => {},
      debug: () => {},
    } as unknown as Logger;
    expect(() =>
      createCostTracker({ budget: 5, logger: throwingLogger }),
    ).not.toThrow();
  });

  it('uses defaultModelPricing produces non-zero costs end-to-end', () => {
    const tracker = createCostTracker({
      pricing: [...defaultModelPricing],
      budget: 1,
    });
    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'claude-sonnet-4-6',
      inputTokens: 10_000,
      outputTokens: 1_000,
    });
    expect(record.estimatedCost).toBeGreaterThan(0);
  });
});
