import { describe, it, expect } from 'vitest';
import {
  claimCap,
  compactTier,
  REQUIRED_COMPACT_LAYERS,
  KEY_SWITCH_MAX_LAYERS,
} from '../pvacPolicy';

describe('claimCap', () => {
  it('allows two claims on a fresh balance', () => expect(claimCap(2)).toBe(2));
  it('allows one claim at four layers', () => expect(claimCap(4)).toBe(1));
  it('blocks claiming at the key-switch limit', () => expect(claimCap(6)).toBe(0));
  it('blocks claiming past the limit', () => expect(claimCap(8)).toBe(0));
  it('never goes negative', () => expect(claimCap(100)).toBe(0));
});

describe('compactTier', () => {
  it('is silent on a healthy balance', () => expect(compactTier(2)).toBe('none'));
  it('requires compact at four layers', () => expect(compactTier(4)).toBe('compact'));
  it('is critical at the last compactable state', () => expect(compactTier(6)).toBe('critical'));
  it('constants match the verified ladder', () => {
    expect(REQUIRED_COMPACT_LAYERS).toBe(4);
    expect(KEY_SWITCH_MAX_LAYERS).toBe(6);
  });
});

describe('claimCap edge inputs', () => {
  it('claimCap(0) is permissive by raw math - callers MUST gate with plausibleLayers first', () => {
    expect(claimCap(0)).toBe(3);
  });
  it('claimCap(NaN) is NaN by raw math - callers MUST gate with plausibleLayers first', () => {
    expect(Number.isNaN(claimCap(NaN))).toBe(true);
  });
});
