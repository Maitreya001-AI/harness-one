import { describe, it, expect } from 'vitest';
import { createDriftDetector } from '../drift-detector.js';

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

    it('returns no drift for unknown component', () => {
      const detector = createDriftDetector();
      const report = detector.check('unknown', { a: 1 });
      expect(report.driftDetected).toBe(false);
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
});
