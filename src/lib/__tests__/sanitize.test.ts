import { describe, expect, it } from 'vitest';
import { sanitizeText } from '../sanitize';

describe('sanitizeText', () => {
  it('returns plain text untouched', () => {
    expect(sanitizeText('0xio DEX')).toBe('0xio DEX');
    expect(sanitizeText('Tom & Jerry')).toBe('Tom & Jerry');
    expect(sanitizeText('1 < 2 and 3 > 2')).toBe('1 < 2 and 3 > 2');
  });

  it('is empty for nothing', () => {
    expect(sanitizeText(undefined)).toBe('');
    expect(sanitizeText(null)).toBe('');
    expect(sanitizeText('')).toBe('');
  });

  it('strips tags', () => {
    expect(sanitizeText('<b>Bold</b> site')).toBe('Bold site');
    expect(sanitizeText('<img src=x onerror=alert(1)>Shop')).toBe('Shop');
    expect(sanitizeText('a<script>alert(1)</script>b')).toBe('ab');
    expect(sanitizeText('a<STYLE>b{}</style >c<script>open')).toBe('ac');
    expect(sanitizeText('<!-- note -->Shop<?x?>')).toBe('Shop');
  });

  it('strips tags that only appear after a first pass', () => {
    expect(sanitizeText('<scr<script>ipt>x')).toBe('');
    expect(sanitizeText('<<b>img src=x>y')).toBe('y');
  });

  it('strips a tag left open', () => {
    expect(sanitizeText('Shop<img src=x onerror=alert(1)')).toBe('Shop');
  });

  it('never leaves a tag opener behind', () => {
    const inputs = ['<a', '<<<a>>>', '</x', '<a<a<a>', '<svg/onload=1>', '<\u0000b>x', '<‮b>x'];
    for (const input of inputs) expect(sanitizeText(input)).not.toMatch(/<\/?[a-zA-Z!?]/);
  });

  it('drops invisible direction and control characters', () => {
    expect(sanitizeText('pay‮gro.oix0')).toBe('paygro.oix0');
    expect(sanitizeText('a​b\u0000c﻿')).toBe('abc');
    expect(sanitizeText('line\nnext\ttab')).toBe('line\nnext\ttab');
  });
});
