import { describe, it, expect } from 'vitest';
import { categorizeAdapterError } from '../error-classifier.js';

describe('categorizeAdapterError', () => {
  describe('ADAPTER_RATE_LIMIT', () => {
    it('classifies errors containing "rate"', () => {
      expect(categorizeAdapterError(new Error('Rate limit exceeded'))).toBe('ADAPTER_RATE_LIMIT');
    });

    it('classifies errors containing "429"', () => {
      expect(categorizeAdapterError(new Error('HTTP 429 response'))).toBe('ADAPTER_RATE_LIMIT');
    });

    it('classifies errors containing "too many"', () => {
      expect(categorizeAdapterError(new Error('Too many requests'))).toBe('ADAPTER_RATE_LIMIT');
    });
  });

  describe('ADAPTER_AUTH', () => {
    it('classifies errors containing "auth"', () => {
      expect(categorizeAdapterError(new Error('Authentication failed'))).toBe('ADAPTER_AUTH');
    });

    it('classifies errors containing "401"', () => {
      expect(categorizeAdapterError(new Error('HTTP 401 Unauthorized'))).toBe('ADAPTER_AUTH');
    });

    it('classifies errors containing "api key"', () => {
      expect(categorizeAdapterError(new Error('Invalid API key'))).toBe('ADAPTER_AUTH');
    });

    it('classifies errors containing "unauthorized"', () => {
      expect(categorizeAdapterError(new Error('Unauthorized access'))).toBe('ADAPTER_AUTH');
    });
  });

  describe('ADAPTER_NETWORK', () => {
    it('classifies errors containing "timeout"', () => {
      expect(categorizeAdapterError(new Error('Connection timeout'))).toBe('ADAPTER_NETWORK');
    });

    it('classifies errors containing "econnrefused"', () => {
      expect(categorizeAdapterError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe('ADAPTER_NETWORK');
    });

    it('classifies errors containing "network"', () => {
      expect(categorizeAdapterError(new Error('Network error'))).toBe('ADAPTER_NETWORK');
    });

    it('classifies errors containing "fetch"', () => {
      expect(categorizeAdapterError(new Error('fetch failed'))).toBe('ADAPTER_NETWORK');
    });
  });

  describe('ADAPTER_PARSE', () => {
    it('classifies errors containing "parse"', () => {
      expect(categorizeAdapterError(new Error('Failed to parse response'))).toBe('ADAPTER_PARSE');
    });

    it('classifies errors containing "json"', () => {
      expect(categorizeAdapterError(new Error('Invalid JSON in response'))).toBe('ADAPTER_PARSE');
    });

    it('classifies errors containing "malformed"', () => {
      expect(categorizeAdapterError(new Error('Malformed response body'))).toBe('ADAPTER_PARSE');
    });
  });

  describe('ADAPTER_UNAVAILABLE', () => {
    it('classifies 502 status', () => {
      expect(categorizeAdapterError(new Error('HTTP 502 upstream'))).toBe('ADAPTER_UNAVAILABLE');
    });

    it('classifies 503 status', () => {
      expect(categorizeAdapterError(new Error('HTTP 503 response'))).toBe('ADAPTER_UNAVAILABLE');
    });

    it('classifies 504 status', () => {
      expect(categorizeAdapterError(new Error('HTTP 504 from provider'))).toBe('ADAPTER_UNAVAILABLE');
    });

    it('classifies "Bad Gateway"', () => {
      expect(categorizeAdapterError(new Error('Bad Gateway'))).toBe('ADAPTER_UNAVAILABLE');
    });

    it('classifies "bad_gateway" (underscore)', () => {
      expect(categorizeAdapterError(new Error('upstream bad_gateway'))).toBe('ADAPTER_UNAVAILABLE');
    });

    it('classifies "Service Unavailable"', () => {
      expect(categorizeAdapterError(new Error('Service Unavailable'))).toBe('ADAPTER_UNAVAILABLE');
    });

    it('classifies "Gateway Timeout"', () => {
      expect(categorizeAdapterError(new Error('Gateway Timeout'))).toBe('ADAPTER_UNAVAILABLE');
    });

    it('classifies "gateway-timeout" (hyphen)', () => {
      expect(categorizeAdapterError(new Error('got gateway-timeout'))).toBe('ADAPTER_UNAVAILABLE');
    });

    it('does NOT match 5xx hidden inside a longer number (belt-and-braces)', () => {
      // "15000" should NOT match because the 5xx must be bounded.
      expect(categorizeAdapterError(new Error('cost=15000'))).toBe('ADAPTER_ERROR');
    });

    it('matches 500 status at end of message', () => {
      expect(categorizeAdapterError(new Error('upstream returned 500'))).toBe('ADAPTER_UNAVAILABLE');
    });
  });

  describe('ADAPTER_ERROR (default fallback)', () => {
    it('returns ADAPTER_ERROR for unrecognized error messages', () => {
      expect(categorizeAdapterError(new Error('Something went wrong'))).toBe('ADAPTER_ERROR');
    });

    it('returns ADAPTER_ERROR for non-Error values', () => {
      expect(categorizeAdapterError('string error')).toBe('ADAPTER_ERROR');
      expect(categorizeAdapterError(42)).toBe('ADAPTER_ERROR');
      expect(categorizeAdapterError(null)).toBe('ADAPTER_ERROR');
      expect(categorizeAdapterError(undefined)).toBe('ADAPTER_ERROR');
    });

    it('returns ADAPTER_ERROR for errors with empty messages', () => {
      expect(categorizeAdapterError(new Error(''))).toBe('ADAPTER_ERROR');
    });
  });

  describe('case insensitivity', () => {
    it('matches regardless of case', () => {
      expect(categorizeAdapterError(new Error('RATE LIMIT'))).toBe('ADAPTER_RATE_LIMIT');
      expect(categorizeAdapterError(new Error('UNAUTHORIZED'))).toBe('ADAPTER_AUTH');
      expect(categorizeAdapterError(new Error('TIMEOUT'))).toBe('ADAPTER_NETWORK');
      expect(categorizeAdapterError(new Error('JSON parse error'))).toBe('ADAPTER_PARSE');
    });
  });
});
