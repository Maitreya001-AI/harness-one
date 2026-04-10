import { describe, it, expect } from 'vitest';
import { createDriftDetector } from '../drift-detector.js';
import { HarnessError } from '../../core/errors.js';

describe('createDriftDetector', () => {
  describe('check', () => {
    it('detects no drift when values match', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { latency: 100, accuracy: 0.95 });
      const report = detector.check('comp-1', { latency: 100, accuracy: 0.95 });
      expect(report.driftDetected).toBe(false);
      expect(report.deviations).toHaveLength(0);
    });

    it('detects drift when values differ', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { latency: 100 });
      const report = detector.check('comp-1', { latency: 200 });
      expect(report.driftDetected).toBe(true);
      expect(report.deviations).toHaveLength(1);
      expect(report.deviations[0].field).toBe('latency');
      expect(report.deviations[0].expected).toBe(100);
      expect(report.deviations[0].actual).toBe(200);
    });

    it('classifies severity by numeric deviation', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { value: 100 });

      // Low: <10% change
      const low = detector.check('comp-1', { value: 105 });
      expect(low.deviations[0].severity).toBe('low');

      // Medium: 10-50% change
      const med = detector.check('comp-1', { value: 130 });
      expect(med.deviations[0].severity).toBe('medium');

      // High: >50% change
      const high = detector.check('comp-1', { value: 200 });
      expect(high.deviations[0].severity).toBe('high');
    });

    it('marks missing fields as high severity', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { a: 1, b: 2 });
      const report = detector.check('comp-1', { a: 1 });
      expect(report.driftDetected).toBe(true);
      const bDev = report.deviations.find((d) => d.field === 'b');
      expect(bDev?.severity).toBe('high');
    });

    it('marks new fields as high severity', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { a: 1 });
      const report = detector.check('comp-1', { a: 1, b: 2 });
      const bDev = report.deviations.find((d) => d.field === 'b');
      expect(bDev?.severity).toBe('high');
    });

    // Fix 8: Throws when no baseline set
    it('throws NO_BASELINE error for unknown component', () => {
      const detector = createDriftDetector();
      expect(() => detector.check('unknown', { a: 1 })).toThrow(HarnessError);
      try {
        detector.check('unknown', { a: 1 });
      } catch (e) {
        expect((e as HarnessError).code).toBe('NO_BASELINE');
      }
    });

    it('handles deep object comparison', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { nested: { a: 1 } });
      const same = detector.check('comp-1', { nested: { a: 1 } });
      expect(same.driftDetected).toBe(false);

      const diff = detector.check('comp-1', { nested: { a: 2 } });
      expect(diff.driftDetected).toBe(true);
    });

    it('handles array comparison', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { items: [1, 2, 3] });
      const same = detector.check('comp-1', { items: [1, 2, 3] });
      expect(same.driftDetected).toBe(false);

      const diff = detector.check('comp-1', { items: [1, 2, 4] });
      expect(diff.driftDetected).toBe(true);
    });
  });

  describe('checkAll', () => {
    it('checks multiple components', () => {
      const detector = createDriftDetector();
      detector.setBaseline('a', { x: 1 });
      detector.setBaseline('b', { y: 2 });

      const reports = detector.checkAll({ a: { x: 1 }, b: { y: 99 } });
      expect(reports).toHaveLength(2);
      expect(reports.find((r) => r.componentId === 'a')!.driftDetected).toBe(false);
      expect(reports.find((r) => r.componentId === 'b')!.driftDetected).toBe(true);
    });
  });

  describe('configurable severity thresholds', () => {
    it('uses custom thresholds for severity classification', () => {
      const detector = createDriftDetector({
        thresholds: { low: 0.2, medium: 0.8 },
      });
      detector.setBaseline('comp-1', { value: 100 });

      // 15% change: with default thresholds (0.1, 0.5) this would be medium,
      // but with custom thresholds (0.2, 0.8) this should be low
      const report = detector.check('comp-1', { value: 115 });
      expect(report.deviations[0].severity).toBe('low');
    });

    it('custom thresholds change medium to high boundary', () => {
      const detector = createDriftDetector({
        thresholds: { low: 0.05, medium: 0.3 },
      });
      detector.setBaseline('comp-1', { value: 100 });

      // 40% change: with default thresholds (0.1, 0.5) this would be medium,
      // but with custom (0.05, 0.3) this should be high
      const report = detector.check('comp-1', { value: 140 });
      expect(report.deviations[0].severity).toBe('high');
    });

    it('uses default thresholds when none provided', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { value: 100 });

      // 5% change: low
      const low = detector.check('comp-1', { value: 105 });
      expect(low.deviations[0].severity).toBe('low');

      // 30% change: medium
      const med = detector.check('comp-1', { value: 130 });
      expect(med.deviations[0].severity).toBe('medium');

      // 60% change: high
      const high = detector.check('comp-1', { value: 160 });
      expect(high.deviations[0].severity).toBe('high');
    });

    it('accepts empty config object and uses defaults', () => {
      const detector = createDriftDetector({});
      detector.setBaseline('comp-1', { value: 100 });

      const report = detector.check('comp-1', { value: 105 });
      expect(report.deviations[0].severity).toBe('low');
    });
  });

  describe('deepEqual edge cases', () => {
    it('handles null values correctly', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { a: null as unknown as string });

      const same = detector.check('comp-1', { a: null as unknown as string });
      expect(same.driftDetected).toBe(false);

      const diff = detector.check('comp-1', { a: 'not null' });
      expect(diff.driftDetected).toBe(true);
    });

    it('detects type change drift as high severity', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { value: 100 });

      // number -> string type change
      const report = detector.check('comp-1', { value: '100' as unknown as number });
      expect(report.driftDetected).toBe(true);
      expect(report.deviations[0].severity).toBe('high');
    });

    it('handles array length mismatch', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { items: [1, 2] });

      const report = detector.check('comp-1', { items: [1, 2, 3] });
      expect(report.driftDetected).toBe(true);
    });

    it('handles deeply nested object comparison', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { nested: { deep: { value: 42 } } });

      const same = detector.check('comp-1', { nested: { deep: { value: 42 } } });
      expect(same.driftDetected).toBe(false);

      const diff = detector.check('comp-1', { nested: { deep: { value: 43 } } });
      expect(diff.driftDetected).toBe(true);
    });

    it('null vs non-null is detected as drift', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { a: null as unknown as string });

      const report = detector.check('comp-1', { a: { b: 1 } as unknown as string });
      expect(report.driftDetected).toBe(true);
    });

    it('object key superset detection', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { a: { x: 1 } });

      // Extra key in current
      const report = detector.check('comp-1', { a: { x: 1, y: 2 } });
      expect(report.driftDetected).toBe(true);
    });
  });

  describe('classifyWithThresholds edge cases', () => {
    it('classifies zero baseline with zero actual as low', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { value: 0 });

      const report = detector.check('comp-1', { value: 0 });
      expect(report.driftDetected).toBe(false);
    });

    // Fix 9: Zero baseline uses absolute thresholds
    it('classifies zero baseline with small non-zero actual as low (Fix 9)', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { value: 0 });

      const report = detector.check('comp-1', { value: 0.5 });
      expect(report.driftDetected).toBe(true);
      expect(report.deviations[0].severity).toBe('low');
    });

    it('classifies zero baseline with medium non-zero actual as medium (Fix 9)', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { value: 0 });

      const report = detector.check('comp-1', { value: 5 });
      expect(report.driftDetected).toBe(true);
      expect(report.deviations[0].severity).toBe('medium');
    });

    it('classifies zero baseline with large non-zero actual as high (Fix 9)', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { value: 0 });

      const report = detector.check('comp-1', { value: 100 });
      expect(report.driftDetected).toBe(true);
      expect(report.deviations[0].severity).toBe('high');
    });

    it('classifies different types (number vs string) as high', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { value: 42 });

      const report = detector.check('comp-1', { value: 'forty-two' as unknown as number });
      expect(report.driftDetected).toBe(true);
      expect(report.deviations[0].severity).toBe('high');
    });

    it('classifies same type non-number values (string vs string) as medium', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { label: 'alpha' });

      const report = detector.check('comp-1', { label: 'beta' });
      expect(report.driftDetected).toBe(true);
      expect(report.deviations[0].severity).toBe('medium');
    });

    it('classifies undefined expected as high severity', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { a: 1 });

      // New key 'b' not in baseline => expected is undefined
      const report = detector.check('comp-1', { a: 1, b: 99 });
      expect(report.driftDetected).toBe(true);
      const bDev = report.deviations.find(d => d.field === 'b');
      expect(bDev!.severity).toBe('high');
    });

    it('classifies undefined actual as high severity', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { a: 1, b: 2 });

      // Key 'b' missing in current => actual is undefined
      const report = detector.check('comp-1', { a: 1 });
      expect(report.driftDetected).toBe(true);
      const bDev = report.deviations.find(d => d.field === 'b');
      expect(bDev!.severity).toBe('high');
    });
  });

  describe('circular reference protection', () => {
    it('does not infinite-loop on circular references in baseline', () => {
      const detector = createDriftDetector();
      const circularA: Record<string, unknown> = { name: 'a' };
      circularA.self = circularA;

      const circularB: Record<string, unknown> = { name: 'a' };
      circularB.self = circularB;

      detector.setBaseline('comp-1', { nested: circularA });
      // Should not hang — completes in finite time
      const report = detector.check('comp-1', { nested: circularB });
      expect(report.driftDetected).toBe(false);
    });

    it('detects drift with circular references when values differ', () => {
      const detector = createDriftDetector();
      const circularA: Record<string, unknown> = { name: 'a' };
      circularA.self = circularA;

      const circularB: Record<string, unknown> = { name: 'b' };
      circularB.self = circularB;

      detector.setBaseline('comp-1', { nested: circularA });
      const report = detector.check('comp-1', { nested: circularB });
      expect(report.driftDetected).toBe(true);
    });

    it('handles mutual circular references', () => {
      const detector = createDriftDetector();
      const a: Record<string, unknown> = { value: 1 };
      const b: Record<string, unknown> = { value: 2, ref: a };
      a.ref = b;

      const a2: Record<string, unknown> = { value: 1 };
      const b2: Record<string, unknown> = { value: 2, ref: a2 };
      a2.ref = b2;

      detector.setBaseline('comp-1', { data: a });
      const report = detector.check('comp-1', { data: a2 });
      // Should complete without infinite loop
      expect(report).toBeDefined();
    });
  });

  describe('isRecord type guard', () => {
    it('does not treat arrays as records during deep comparison', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { items: [1, 2, 3] });
      // Array vs object — should detect drift
      const report = detector.check('comp-1', { items: { 0: 1, 1: 2, 2: 3 } });
      expect(report.driftDetected).toBe(true);
    });

    it('handles mixed nested arrays and objects correctly', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { data: { list: [1, 2], meta: { key: 'value' } } });

      const same = detector.check('comp-1', { data: { list: [1, 2], meta: { key: 'value' } } });
      expect(same.driftDetected).toBe(false);

      const diff = detector.check('comp-1', { data: { list: [1, 3], meta: { key: 'value' } } });
      expect(diff.driftDetected).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('custom thresholds change severity classification', () => {
      // With very tight thresholds (low=0.01, medium=0.05)
      const detector = createDriftDetector({
        thresholds: { low: 0.01, medium: 0.05 },
      });
      detector.setBaseline('comp-1', { value: 100 });

      // 2% change — normally 'low' but with tight thresholds should be 'medium'
      const report = detector.check('comp-1', { value: 102 });
      expect(report.deviations[0].severity).toBe('medium');

      // 10% change — should be 'high' with tight thresholds
      const report2 = detector.check('comp-1', { value: 110 });
      expect(report2.deviations[0].severity).toBe('high');
    });

    it('zero baseline handling (Fix 9: absolute thresholds)', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { value: 0 });

      // When baseline is 0 and actual is also 0, should be 'low' (no drift)
      const sameReport = detector.check('comp-1', { value: 0 });
      expect(sameReport.driftDetected).toBe(false);

      // Fix 9: When baseline is 0 and actual is 5 (1 <= 5 < 10), should be 'medium'
      const diffReport = detector.check('comp-1', { value: 5 });
      expect(diffReport.driftDetected).toBe(true);
      expect(diffReport.deviations[0].severity).toBe('medium');
    });

    it('string value change detection', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { name: 'alpha', version: 'v1' });

      // Same strings — no drift
      const same = detector.check('comp-1', { name: 'alpha', version: 'v1' });
      expect(same.driftDetected).toBe(false);

      // Different string — drift detected with medium severity (same type, different value)
      const diff = detector.check('comp-1', { name: 'beta', version: 'v1' });
      expect(diff.driftDetected).toBe(true);
      const nameDev = diff.deviations.find(d => d.field === 'name');
      expect(nameDev).toBeDefined();
      expect(nameDev!.severity).toBe('medium');
    });

    it('boolean drift detection', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { enabled: true, debug: false });

      // Same booleans — no drift
      const same = detector.check('comp-1', { enabled: true, debug: false });
      expect(same.driftDetected).toBe(false);

      // Changed boolean — drift detected
      const diff = detector.check('comp-1', { enabled: false, debug: false });
      expect(diff.driftDetected).toBe(true);
      const enabledDev = diff.deviations.find(d => d.field === 'enabled');
      expect(enabledDev).toBeDefined();
      expect(enabledDev!.expected).toBe(true);
      expect(enabledDev!.actual).toBe(false);
      // Same type (boolean) but different value should be 'medium'
      expect(enabledDev!.severity).toBe('medium');
    });
  });

  // Fix 8: hasBaseline method
  describe('hasBaseline (Fix 8)', () => {
    it('returns false when no baseline is set', () => {
      const detector = createDriftDetector();
      expect(detector.hasBaseline('comp-1')).toBe(false);
    });

    it('returns true after setBaseline', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { value: 100 });
      expect(detector.hasBaseline('comp-1')).toBe(true);
    });

    it('returns false for different component id', () => {
      const detector = createDriftDetector();
      detector.setBaseline('comp-1', { value: 100 });
      expect(detector.hasBaseline('comp-2')).toBe(false);
    });
  });
});
