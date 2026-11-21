import { describe, expect, it } from 'vitest';
import {
  NO_AMOUNTS,
  amountNote,
  drivenAmount,
  fieldValues,
  freshQuoteProblem,
  receiveMaxPay,
  type Amounts,
  type Order,
} from 'src/features/bridge/anyChainAmounts';

const pay = (text: string): Amounts => ({ driver: 'pay', text });
const receive = (text: string): Amounts => ({ driver: 'receive', text });
const quote = { outRaw: '12345678', payRaw: '1500000000000000' };

describe('two amount fields', () => {
  it('the typed field drives the quote mode and amount', () => {
    expect(drivenAmount(pay('0.0015'), 18)).toEqual({ mode: 'spend', raw: 1_500_000_000_000_000n });
    expect(drivenAmount(receive('12.5'), 18)).toEqual({ mode: 'receive', raw: 12_500_000n });
    expect(drivenAmount(NO_AMOUNTS, 18)).toEqual({ mode: 'spend', raw: 0n });
    expect(drivenAmount(pay('1.0000001'), 6).raw).toBe(0n);
  });

  it('the other field shows the quoted counterpart', () => {
    expect(fieldValues(pay('0.0015'), quote, 18)).toEqual({ pay: '0.0015', receive: '12.345678' });
    expect(fieldValues(receive('12.345678'), quote, 18)).toEqual({
      pay: '0.0015',
      receive: '12.345678',
    });
    expect(fieldValues(receive('3'), { outRaw: null, payRaw: null }, 18)).toEqual({
      pay: '',
      receive: '3',
    });
  });

  it('clearing the driver clears both', () => {
    expect(fieldValues(receive(''), quote, 18)).toEqual({ pay: '', receive: '' });
    expect(fieldValues(pay(''), quote, 18)).toEqual({ pay: '', receive: '' });
  });

  it('cuts a long counterpart without grouping so it stays editable', () => {
    expect(
      fieldValues(receive('1'), { outRaw: null, payRaw: '1234567891234567891234' }, 18)
    ).toEqual({ pay: '1234.56789123', receive: '1' });
  });
});

describe('note under the fields', () => {
  const base = {
    balance: 1_000_000_000_000_000n,
    quoting: true,
    outRaw: null as string | null,
    payRaw: null as string | null,
    loading: false,
    failed: false,
  };

  it('shows the balance when nothing is typed', () => {
    expect(amountNote({ ...base, amounts: NO_AMOUNTS, raw: 0n, quoting: false })).toBe('balance');
    expect(
      amountNote({ ...base, amounts: NO_AMOUNTS, raw: 0n, quoting: false, balance: null })
    ).toBe('none');
  });

  it('flags over balance on the quoted pay when receive drives', () => {
    const amounts = receive('20');
    expect(
      amountNote({
        ...base,
        amounts,
        raw: 20_000_000n,
        outRaw: '20000000',
        payRaw: '1500000000000000',
      })
    ).toBe('over');
    expect(
      amountNote({
        ...base,
        amounts,
        raw: 20_000_000n,
        outRaw: '20000000',
        payRaw: '900000000000000',
      })
    ).toBe('fees');
  });

  it('flags over balance on the typed pay when pay drives', () => {
    expect(amountNote({ ...base, amounts: pay('0.002'), raw: 2_000_000_000_000_000n })).toBe(
      'over'
    );
  });

  it('asks for at least 1 OCT before any quote when receive drives', () => {
    expect(amountNote({ ...base, amounts: receive('0.5'), raw: 500_000n, quoting: false })).toBe(
      'min'
    );
  });

  it('says when there is no price, and while the first price loads', () => {
    expect(
      amountNote({ ...base, amounts: pay('0.0001'), raw: 100_000_000_000_000n, failed: true })
    ).toBe('noPrice');
    expect(
      amountNote({ ...base, amounts: pay('0.0001'), raw: 100_000_000_000_000n, loading: true })
    ).toBe('pricing');
  });
});

describe('receive-mode review', () => {
  it('tolerates 1% over the shown pay, never above the balance', () => {
    expect(receiveMaxPay(1_000_000n, null)).toBe(1_010_000n);
    expect(receiveMaxPay(1_000_001n, null)).toBe(1_010_002n);
    expect(receiveMaxPay(1_000_000n, 1_005_000n)).toBe(1_005_000n);
  });

  const order: Order = { mode: 'receive', amountRaw: 10_000_000n, maxPayRaw: 1_010_000n };

  it('stops when the fresh quote charges more than that', () => {
    expect(freshQuoteProblem(order, 10_000_000n, 1_010_000n)).toBeNull();
    expect(freshQuoteProblem(order, 10_000_000n, 1_010_001n)).toBe('moved');
    expect(freshQuoteProblem(order, 9_999_999n, 1_000_000n)).toBe('moved');
    expect(freshQuoteProblem(order, 10_000_000n, null)).toBe('moved');
  });

  it('keeps the spend checks: 1 OCT minimum and the 1% drop', () => {
    const spend: Order = {
      mode: 'spend',
      amountRaw: 1_000_000n,
      shownOutRaw: '10000000',
      maxPayRaw: 1_000_000n,
    };
    expect(freshQuoteProblem(spend, 999_999n, 1_000_000n)).toBe('min');
    expect(freshQuoteProblem(spend, 9_800_000n, 1_000_000n)).toBe('dropped');
    expect(freshQuoteProblem(spend, 9_900_000n, 1_000_000n)).toBeNull();
  });
});
