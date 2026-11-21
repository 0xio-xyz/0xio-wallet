import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('src/i18n/react', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) =>
      String(o?.defaultValue ?? key).replace(/{{(\w+)}}/g, (_m, k: string) => String(o?.[k])),
  }),
}));

import NetworkFeeRow from 'src/features/bridge/components/NetworkFeeRow';
import {
  applyFeeChoice,
  checkCustom,
  feePresets,
  stillCovers,
  toGwei,
} from 'src/services/evm/feeChoice';
import type { EvmFees, PreparedTransfer } from 'src/services/evm/send';

const GWEI = 1_000_000_000n;
const fees: EvmFees = {
  baseFeePerGas: 10n * GWEI,
  maxPriorityFeePerGas: GWEI,
  maxFeePerGas: 21n * GWEI,
};
const legacyFees: EvmFees = {
  baseFeePerGas: null,
  maxPriorityFeePerGas: 6n * GWEI,
  maxFeePerGas: 6n * GWEI,
  legacy: true,
};
const prepared = (f: EvmFees = fees): PreparedTransfer => ({
  tx: {
    chainId: 1,
    nonce: 4,
    maxPriorityFeePerGas: f.maxPriorityFeePerGas,
    maxFeePerGas: f.maxFeePerGas,
    gasLimit: 100_000n,
    to: '0x4647e1fE715c9e23959022C2416C71867F5a6E80',
    value: 5n,
    data: '0x',
    ...(f.legacy ? { legacy: true as const } : {}),
  },
  feeWei: 100_000n * f.maxFeePerGas,
  totalNative: 5n + 100_000n * f.maxFeePerGas,
  fees: f,
});

describe('fee presets', () => {
  it('Normal is the live estimate, Slow is lower and Fast higher', () => {
    const p = feePresets(fees);
    expect(p.normal).toEqual({ maxFeePerGas: 21n * GWEI, maxPriorityFeePerGas: GWEI });
    expect(p.slow).toEqual({ maxFeePerGas: 13n * GWEI, maxPriorityFeePerGas: GWEI / 2n });
    expect(p.fast).toEqual({ maxFeePerGas: 32n * GWEI, maxPriorityFeePerGas: 2n * GWEI });
  });

  it('Fast tips at least 0.1 gwei more when the tip is tiny or zero', () => {
    const p = feePresets({ ...fees, maxPriorityFeePerGas: 0n, maxFeePerGas: 20n * GWEI });
    expect(p.fast.maxPriorityFeePerGas).toBe(GWEI / 10n);
    expect(p.slow.maxPriorityFeePerGas).toBe(0n);
  });

  it('scales the gas price on a chain without a base fee', () => {
    const p = feePresets(legacyFees);
    expect(p.slow).toEqual({ maxFeePerGas: 5n * GWEI, maxPriorityFeePerGas: 5n * GWEI });
    expect(p.normal.maxFeePerGas).toBe(6n * GWEI);
    expect(p.fast).toEqual({ maxFeePerGas: 9n * GWEI, maxPriorityFeePerGas: 9n * GWEI });
  });

  it('applies a choice to the same nonce, gas limit and call, with the fee and total following', () => {
    const base = prepared();
    expect(applyFeeChoice(base, undefined).tx).toEqual(base.tx);
    const fast = applyFeeChoice(base, { speed: 'fast' });
    expect(fast.tx).toMatchObject({ nonce: 4, gasLimit: 100_000n, data: '0x', value: 5n });
    expect(fast.feeWei).toBe(100_000n * 32n * GWEI);
    expect(fast.totalNative).toBe(5n + fast.feeWei);
    const custom = applyFeeChoice(prepared(legacyFees), {
      custom: { maxFeePerGas: 7n * GWEI, maxPriorityFeePerGas: GWEI },
    });
    expect(custom.tx.maxPriorityFeePerGas).toBe(7n * GWEI);
  });

  it('leaves a tx alone when the live estimate is not known', () => {
    const { fees: _drop, ...bare } = prepared();
    expect(applyFeeChoice(bare, { speed: 'fast' })).toBe(bare);
  });
});

describe('custom fee', () => {
  it('takes gwei with decimals', () => {
    expect(checkCustom({ maxGwei: '15.5', priorityGwei: '1.25' }, fees, 1)).toEqual({
      gas: { maxFeePerGas: 15_500_000_000n, maxPriorityFeePerGas: 1_250_000_000n },
      problem: null,
    });
  });

  it('needs a priority fee above 0', () => {
    expect(checkCustom({ maxGwei: '30', priorityGwei: '0' }, fees, 1).problem).toBe('priority');
  });

  it('needs the max fee to cover the base fee plus the priority fee', () => {
    expect(checkCustom({ maxGwei: '10.5', priorityGwei: '1' }, fees, 1).problem).toBe('belowBase');
    expect(checkCustom({ maxGwei: '11', priorityGwei: '1' }, fees, 1).problem).toBeNull();
  });

  it('refuses text, empty fields and a fee far above normal', () => {
    expect(checkCustom({ maxGwei: 'abc', priorityGwei: '1' }, fees, 1).problem).toBe('format');
    expect(checkCustom({ maxGwei: '', priorityGwei: '' }, fees, 1).problem).toBe('format');
    expect(checkCustom({ maxGwei: '5000', priorityGwei: '1' }, fees, 1).problem).toBe('ceiling');
  });

  it('on a chain without a base fee checks the gas price alone', () => {
    expect(checkCustom({ maxGwei: '4', priorityGwei: '' }, legacyFees, 56).problem).toBe(
      'belowBase'
    );
    expect(checkCustom({ maxGwei: '5', priorityGwei: '' }, legacyFees, 56)).toEqual({
      gas: { maxFeePerGas: 5n * GWEI, maxPriorityFeePerGas: 5n * GWEI },
      problem: null,
    });
  });

  it('shows gwei trimmed', () => {
    expect(toGwei(21n * GWEI)).toBe('21');
    expect(toGwei(1_234_567_890n)).toBe('1.2345');
    expect(toGwei(12n)).toBe('0.000000012');
  });
});

describe('fee re-check before signing', () => {
  it('passes while the max fee covers the new base fee plus the tip', () => {
    const gas = { maxFeePerGas: 13n * GWEI, maxPriorityFeePerGas: GWEI / 2n };
    expect(stillCovers(gas, { ...fees, baseFeePerGas: 12n * GWEI })).toBe(true);
    expect(stillCovers(gas, { ...fees, baseFeePerGas: 13n * GWEI })).toBe(false);
  });

  it('on a legacy chain compares with the node gas price', () => {
    const gas = { maxFeePerGas: 5n * GWEI, maxPriorityFeePerGas: 5n * GWEI };
    expect(stillCovers(gas, legacyFees)).toBe(true);
    expect(stillCovers(gas, { ...legacyFees, maxFeePerGas: 7_200_000_000n })).toBe(false);
  });
});

describe('Network fee row', () => {
  const row = (onChoice = vi.fn(), choice?: Parameters<typeof applyFeeChoice>[1]) =>
    render(
      <NetworkFeeRow
        label="Network fee"
        prepared={prepared()}
        choice={choice}
        onChoice={onChoice}
        chainId={1}
        nativeSymbol="ETH"
        nativePrice={2000}
      />
    );

  it('says Network fee with USD first and the native amount dimmed', () => {
    row();
    expect(screen.getByText('Network fee')).toBeTruthy();
    const usd = screen.getByText('$4.20');
    const native = screen.getByText('0.0021 ETH');
    expect(usd.compareDocumentPosition(native) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(native.getAttribute('style')).toContain('var(--fg-3)');
    expect(screen.queryByText('Max fee')).toBeNull();
  });

  it('opens the presets and applies one at once', () => {
    const onChoice = vi.fn();
    row(onChoice);
    fireEvent.click(screen.getByLabelText('Edit network fee'));
    expect(screen.getByText('Slow')).toBeTruthy();
    expect(screen.getByText('Custom')).toBeTruthy();
    expect(screen.getByText('Normal').closest('button')?.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByText('Fast'));
    expect(onChoice).toHaveBeenCalledWith({ speed: 'fast' });
  });

  it('keeps Use custom fee off and explains in a card when below the base fee', () => {
    const onChoice = vi.fn();
    row(onChoice);
    fireEvent.click(screen.getByLabelText('Edit network fee'));
    fireEvent.click(screen.getByText('Custom'));
    fireEvent.change(screen.getByLabelText('Max fee (gwei)'), { target: { value: '9' } });
    expect(screen.getByText(/Below the current base fee of 10 gwei/)).toBeTruthy();
    const use = screen.getByText('Use custom fee').closest('button') as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Max fee (gwei)'), { target: { value: '14' } });
    fireEvent.change(screen.getByLabelText('Priority fee (gwei)'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Use custom fee'));
    expect(onChoice).toHaveBeenCalledWith({
      custom: { maxFeePerGas: 14n * GWEI, maxPriorityFeePerGas: 2n * GWEI },
    });
  });
});
