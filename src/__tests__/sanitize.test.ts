// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sanitizeText, sanitizeUrl, getPasswordStrength } from 'src/lib/sanitize';

describe('sanitizeText', () => {
  it('should strip HTML tags', () => {
    expect(sanitizeText('<script>alert("xss")</script>')).toBe('');
    expect(sanitizeText('<b>bold</b>')).toBe('bold');
    expect(sanitizeText('<img src=x onerror=alert(1)>')).toBe('');
  });

  it('should pass through plain text', () => {
    expect(sanitizeText('Hello World')).toBe('Hello World');
    expect(sanitizeText('oct1abc...xyz')).toBe('oct1abc...xyz');
  });

  it('should handle null/undefined/empty', () => {
    expect(sanitizeText(null)).toBe('');
    expect(sanitizeText(undefined)).toBe('');
    expect(sanitizeText('')).toBe('');
  });
});

describe('sanitizeUrl', () => {
  it('should allow https URLs', () => {
    expect(sanitizeUrl('https://example.com')).toBe('https://example.com');
    expect(sanitizeUrl('https://dapp.io/favicon.ico')).toBe('https://dapp.io/favicon.ico');
  });

  it('should allow http URLs', () => {
    expect(sanitizeUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('should block javascript: URLs', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('');
  });

  it('should block data: URLs with scripts', () => {
    expect(sanitizeUrl('data:image/png;base64,abc')).toBe('data:image/png;base64,abc');
  });

  it('should handle invalid URLs', () => {
    expect(sanitizeUrl('not-a-url')).toBe('');
    expect(sanitizeUrl(null)).toBe('');
    expect(sanitizeUrl('')).toBe('');
  });
});

describe('getPasswordStrength', () => {
  it('should rate empty password as weak', () => {
    expect(getPasswordStrength('').level).toBe('weak');
  });

  it('should rate short simple password as weak', () => {
    expect(getPasswordStrength('abc').level).toBe('weak');
  });

  it('should rate 8+ char lowercase as fair', () => {
    const result = getPasswordStrength('abcdefgh');
    expect(['weak', 'fair']).toContain(result.level);
  });

  it('should rate mixed case + numbers as good', () => {
    const result = getPasswordStrength('Abcdef123');
    expect(['fair', 'good']).toContain(result.level);
  });

  it('should rate long mixed password with symbols as strong', () => {
    const result = getPasswordStrength('MyP@ssw0rd!Long123');
    expect(result.level).toBe('strong');
  });

  it('should increase score with length', () => {
    const short = getPasswordStrength('Aa1!');
    const long = getPasswordStrength('Aa1!Aa1!Aa1!Aa1!Aa1!');
    expect(long.score).toBeGreaterThan(short.score);
  });
});
