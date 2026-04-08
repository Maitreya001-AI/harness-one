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

  describe('international phone numbers', () => {
    it('detects UK phone numbers with +44 prefix via custom pattern', () => {
      // Disable built-in phone detection so only the custom pattern fires
      const { guard } = createPIIDetector({
        detect: { email: false, phone: false, ssn: false, creditCard: false },
        customPatterns: [
          { name: 'international-phone', pattern: /\+\d{1,3}\s?\d{4,14}/ },
        ],
      });
      const result = guard({ content: 'Call me at +44 7911123456' });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('international-phone');
      }
    });

    it('detects Japanese phone numbers with +81 prefix via custom pattern', () => {
      const { guard } = createPIIDetector({
        detect: { email: false, phone: false, ssn: false, creditCard: false },
        customPatterns: [
          { name: 'international-phone', pattern: /\+\d{1,3}\s?\d{4,14}/ },
        ],
      });
      const result = guard({ content: 'Contact: +81 3012345678' });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('international-phone');
      }
    });
  });

  describe('partial PII', () => {
    it('does not detect last 4 digits of SSN as a full SSN', () => {
      const { guard } = createPIIDetector();
      // Only last 4 digits, not a full SSN pattern (XXX-XX-XXXX)
      const result = guard({ content: 'Last 4 of SSN: 6789' });
      // The built-in SSN pattern requires full XXX-XX-XXXX, so partial should be allowed
      expect(result.action).toBe('allow');
    });
  });

  describe('custom patterns for employee IDs', () => {
    it('detects custom employee ID pattern', () => {
      const { guard } = createPIIDetector({
        customPatterns: [
          { name: 'employee-id', pattern: /EMP-\d{6}/i },
        ],
      });
      expect(guard({ content: 'Employee EMP-654321 filed a report' }).action).toBe('block');
    });

    it('allows content without employee ID pattern', () => {
      const { guard } = createPIIDetector({
        customPatterns: [
          { name: 'employee-id', pattern: /EMP-\d{6}/i },
        ],
      });
      expect(guard({ content: 'No employee data here' }).action).toBe('allow');
    });

    it('detects custom patterns alongside built-in patterns', () => {
      const { guard } = createPIIDetector({
        customPatterns: [
          { name: 'badge-number', pattern: /BADGE-\d{4}/ },
        ],
      });
      // Should detect built-in email
      expect(guard({ content: 'user@example.com' }).action).toBe('block');
      // Should also detect custom badge
      expect(guard({ content: 'Badge: BADGE-1234' }).action).toBe('block');
    });
  });

  describe('multiple PII types in same content', () => {
    it('detects the first matching PII type when multiple are present', () => {
      const { guard } = createPIIDetector();
      // Content with email AND phone AND SSN
      const result = guard({
        content: 'Contact user@example.com or call 555-123-4567, SSN: 123-45-6789',
      });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        // The first detector in order is email
        expect(result.reason).toContain('email');
      }
    });

    it('detects phone when email detection is disabled but phone is present', () => {
      const { guard } = createPIIDetector({
        detect: {
          email: false,
          phone: true,
          ssn: true,
          creditCard: true,
        },
      });
      const result = guard({
        content: 'Email user@example.com or call 555-123-4567',
      });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        // Email detection is disabled, so phone should be the match
        expect(result.reason).toContain('phone');
      }
    });
  });

  describe('PII in tool arguments vs plain text', () => {
    it('detects PII embedded in JSON-like tool arguments', () => {
      const { guard } = createPIIDetector();
      const toolArgs = JSON.stringify({
        to: 'user@example.com',
        subject: 'Meeting',
      });
      const result = guard({ content: toolArgs });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('email');
      }
    });

    it('detects credit card in tool argument content', () => {
      const { guard } = createPIIDetector();
      const toolArgs = JSON.stringify({
        payment: { cardNumber: '4111 1111 1111 1111' },
      });
      const result = guard({ content: toolArgs });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('credit card');
      }
    });

    it('allows tool arguments without PII', () => {
      const { guard } = createPIIDetector();
      const toolArgs = JSON.stringify({
        action: 'search',
        query: 'best restaurants nearby',
      });
      const result = guard({ content: toolArgs });
      expect(result.action).toBe('allow');
    });
  });

  describe('IPv4 address detection (opt-in)', () => {
    it('does not detect IP addresses by default', () => {
      const { guard } = createPIIDetector();
      const result = guard({ content: 'Server at 192.168.1.1 is down' });
      // IP detection is off by default
      expect(result.action).toBe('allow');
    });

    it('blocks content with IPv4 addresses when enabled', () => {
      const { guard } = createPIIDetector({
        detect: { email: false, phone: false, ssn: false, creditCard: false, ipAddress: true },
      });
      const result = guard({ content: 'Server at 192.168.1.1 is down' });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('IP address');
      }
    });

    it('detects various IPv4 formats', () => {
      const { guard } = createPIIDetector({
        detect: { email: false, phone: false, ssn: false, creditCard: false, ipAddress: true },
      });
      expect(guard({ content: 'Address: 10.0.0.1' }).action).toBe('block');
      expect(guard({ content: 'External: 203.0.113.42' }).action).toBe('block');
    });
  });

  describe('API key detection (opt-in)', () => {
    it('does not detect API keys by default', () => {
      const { guard } = createPIIDetector();
      const result = guard({ content: 'Key: sk-abcDefGhiJklmnOpQrsTuv' });
      expect(result.action).toBe('allow');
    });

    it('blocks content with OpenAI-style API keys when enabled', () => {
      const { guard } = createPIIDetector({
        detect: { email: false, phone: false, ssn: false, creditCard: false, apiKey: true },
      });
      const result = guard({ content: 'Key: sk-abcDefGhiJklmnOpQrsTuv' });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('API key');
      }
    });

    it('blocks content with AWS access keys when enabled', () => {
      const { guard } = createPIIDetector({
        detect: { email: false, phone: false, ssn: false, creditCard: false, apiKey: true },
      });
      const result = guard({ content: 'AWS key: AKIAIOSFODNN7EXAMPLE' });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('API key');
      }
    });
  });

  describe('PEM private key detection (opt-in)', () => {
    it('does not detect private keys by default', () => {
      const { guard } = createPIIDetector();
      const result = guard({ content: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...' });
      expect(result.action).toBe('allow');
    });

    it('blocks content with RSA private key headers when enabled', () => {
      const { guard } = createPIIDetector({
        detect: { email: false, phone: false, ssn: false, creditCard: false, privateKey: true },
      });
      const result = guard({ content: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...' });
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('private key');
      }
    });

    it('blocks content with EC private key headers when enabled', () => {
      const { guard } = createPIIDetector({
        detect: { email: false, phone: false, ssn: false, creditCard: false, privateKey: true },
      });
      const result = guard({ content: '-----BEGIN EC PRIVATE KEY-----\nMHQ...' });
      expect(result.action).toBe('block');
    });

    it('blocks content with generic private key headers when enabled', () => {
      const { guard } = createPIIDetector({
        detect: { email: false, phone: false, ssn: false, creditCard: false, privateKey: true },
      });
      const result = guard({ content: '-----BEGIN PRIVATE KEY-----\nMIIE...' });
      expect(result.action).toBe('block');
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
