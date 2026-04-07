import { describe, it, expect } from 'vitest';
import { createPIIDetector } from '../pii-detector.js';

describe('createPIIDetector', () => {
  it('has name "pii-detector"', () => {
    const detector = createPIIDetector();
    expect(detector.name).toBe('pii-detector');
  });

  describe('email detection', () => {
    it('blocks content with email addresses', () => {
      const { guard } = createPIIDetector();
      const result = guard({ content: 'Contact me at user@example.com for details' });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('email');
      }
    });

    it('allows content without email addresses', () => {
      const { guard } = createPIIDetector();
      const result = guard({ content: 'No personal info here' });
      expect(result.action).toBe('allow');
    });
  });

  describe('phone number detection', () => {
    it('blocks content with US phone numbers', () => {
      const { guard } = createPIIDetector();
      const result = guard({ content: 'Call me at 555-123-4567' });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('phone');
      }
    });

    it('blocks content with parenthesized phone numbers', () => {
      const { guard } = createPIIDetector();
      const result = guard({ content: 'My number is (555) 123-4567' });
      expect(result.action).toBe('block');
    });

    it('blocks content with dotted phone numbers', () => {
      const { guard } = createPIIDetector();
      const result = guard({ content: 'Reach me at 555.123.4567' });
      expect(result.action).toBe('block');
    });
  });

  describe('SSN detection', () => {
    it('blocks content with SSN patterns', () => {
      const { guard } = createPIIDetector();
      const result = guard({ content: 'My SSN is 123-45-6789' });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('SSN');
      }
    });
  });

  describe('credit card detection', () => {
    it('blocks content with credit card numbers (spaces)', () => {
      const { guard } = createPIIDetector();
      const result = guard({ content: 'Card: 4111 1111 1111 1111' });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('credit card');
      }
    });

    it('blocks content with credit card numbers (dashes)', () => {
      const { guard } = createPIIDetector();
      const result = guard({ content: 'Card: 4111-1111-1111-1111' });
      expect(result.action).toBe('block');
    });

    it('blocks content with credit card numbers (no separators)', () => {
      const { guard } = createPIIDetector();
      const result = guard({ content: 'Card: 4111111111111111' });
      expect(result.action).toBe('block');
    });
  });

  describe('custom patterns', () => {
    it('blocks content matching custom patterns', () => {
      const { guard } = createPIIDetector({
        customPatterns: [
          { name: 'employee-id', pattern: /EMP-\d{6}/i },
        ],
      });
      const result = guard({ content: 'Employee EMP-123456 reported in' });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('employee-id');
      }
    });

    it('allows content not matching custom patterns', () => {
      const { guard } = createPIIDetector({
        customPatterns: [
          { name: 'employee-id', pattern: /EMP-\d{6}/i },
        ],
      });
      const result = guard({ content: 'No employee info here' });
      expect(result.action).toBe('allow');
    });
  });

  describe('selective detection', () => {
    it('can disable specific detectors', () => {
      const { guard } = createPIIDetector({
        detect: {
          email: false,
          phone: true,
          ssn: true,
          creditCard: true,
        },
      });
      // Email should be allowed when detection is disabled
      const result = guard({ content: 'user@example.com' });
      expect(result.action).toBe('allow');
    });

    it('still detects enabled categories', () => {
      const { guard } = createPIIDetector({
        detect: {
          email: false,
          phone: true,
          ssn: true,
          creditCard: true,
        },
      });
      const result = guard({ content: 'Call 555-123-4567' });
      expect(result.action).toBe('block');
    });
  });
});
