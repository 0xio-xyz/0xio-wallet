import { describe, expect, it } from 'vitest';
import {
  amountUnits,
  assetForMode,
  bulkIssues,
  bulkPollStage,
  bulkTotalUnits,
  displayAmount,
  feeOpType,
  feePresets,
  isSelfSend,
  maxSendable,
  resolveSendOu,
  sendIssues,
  stageAfterError,
  tokenBalanceFromRaw,
  tokenDecimals,
} from 'src/features/transactions/sendStage';
import {
  mayHaveBroadcast,
  RpcResponseError,
  TxOutcomeUnknownError,
} from 'src/services/network/txOutcome';

const ME = 'octMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEME';
const BOB = 'octBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBB';

describe('stage after a send error', () => {
  it('stays on the result once the tx may have reached the node', () => {
    const unknown = new TxOutcomeUnknownError('no receipt');
    expect(stageAfterError(mayHaveBroadcast(unknown), 'sending')).toBe('pending');
  });

  it('returns to the form on a node verdict or a local failure', () => {
    expect(
      stageAfterError(mayHaveBroadcast(new RpcResponseError('bad nonce', {})), 'sending')
    ).toBe('form');
    expect(stageAfterError(mayHaveBroadcast(new Error('offline')), 'sending')).toBe('form');
  });

  it('reads the node error type off a JSON-RPC error', () => {
    expect(new RpcResponseError('x', { data: { type: 'nonce_too_low' } }).errorType).toBe(
      'nonce_too_low'
    );
    expect(new RpcResponseError('x', { message: 'x' }).errorType).toBeUndefined();
  });
});

describe('one fee per send', () => {
  it('picks the op type the node quotes', () => {
    expect(feeOpType(false, false)).toBe('transfer');
    expect(feeOpType(false, true)).toBe('call');
    expect(feeOpType(true, false)).toBe('stealth');
  });

  it("uses the person's pick, else the live quote, else nothing", () => {
    expect(resolveSendOu('2500', '1000')).toBe('2500');
    expect(resolveSendOu('', '1000')).toBe('1000');
    expect(resolveSendOu('', null)).toBeNull();
    expect(resolveSendOu('', undefined)).toBeNull();
    expect(resolveSendOu('0', null)).toBeNull();
    expect(resolveSendOu('abc', '1000')).toBe('1000');
  });

  it('the same OU drives Max, the balance check and the review total', () => {
    const ou = resolveSendOu('', '3000')!;
    const max = maxSendable('public', '1', 6, ou);
    expect(max).toBe('0.997');
    const atMax = sendIssues({
      kind: 'public',
      to: BOB,
      own: ME,
      amount: max,
      decimals: 6,
      spendable: '1',
      publicOct: '1',
      ou,
    });
    expect(atMax.overBalance).toBe(false);
    const overMax = sendIssues({
      kind: 'public',
      to: BOB,
      own: ME,
      amount: '0.997001',
      decimals: 6,
      spendable: '1',
      publicOct: '1',
      ou,
    });
    expect(overMax.overBalance).toBe(true);
  });

  it('builds picker tiers from the quote and never below the recommendation', () => {
    expect(
      feePresets({ minimum: '5000', recommended: '27057', fast: '54114' }).map((p) => p.ou)
    ).toEqual(['5000', '27057', '54114']);
    expect(
      feePresets({ minimum: '1000', recommended: '1000', fast: '2000' }).map((p) => p.ou)
    ).toEqual(['1000', '1500', '2000']);
    expect(feePresets(null)).toEqual([]);
    expect(feePresets(undefined)).toEqual([]);
  });

  it('hides only Fast when the quote has no fast', () => {
    expect(
      feePresets({ minimum: '5000', recommended: '27057' }).map((p) => [p.label, p.ou])
    ).toEqual([
      ['Slow', '5000'],
      ['Normal', '27057'],
    ]);
  });

  it('flags a missing fee', () => {
    const issues = sendIssues({
      kind: 'public',
      to: BOB,
      own: ME,
      amount: '1',
      decimals: 6,
      spendable: '5',
      publicOct: '5',
      ou: null,
    });
    expect(issues.noFee).toBe(true);
  });
});

describe('token and private sends pay the fee from public OCT', () => {
  it('blocks a token send when OCT cannot cover the fee', () => {
    const issues = sendIssues({
      kind: 'token',
      to: BOB,
      own: ME,
      amount: '10',
      decimals: 0,
      spendable: '50',
      publicOct: '0.0009',
      ou: '1000',
    });
    expect(issues.overBalance).toBe(false);
    expect(issues.feeShort).toBe(true);
  });

  it('does not take the fee out of the token balance', () => {
    const issues = sendIssues({
      kind: 'token',
      to: BOB,
      own: ME,
      amount: '50',
      decimals: 0,
      spendable: '50',
      publicOct: '1',
      ou: '1000',
    });
    expect(issues).toEqual({ self: false, noFee: false, overBalance: false, feeShort: false });
    expect(maxSendable('token', '50', 0, '1000')).toBe('50');
  });

  it('checks the stealth fee against public OCT', () => {
    const issues = sendIssues({
      kind: 'private',
      to: BOB,
      own: ME,
      amount: '1',
      decimals: 6,
      spendable: '2',
      publicOct: '0.5',
      ou: '1000000',
    });
    expect(issues.feeShort).toBe(true);
  });
});

describe('self-send', () => {
  it('refuses the wallet address in single and bulk', () => {
    expect(isSelfSend(ME, ME)).toBe(true);
    expect(isSelfSend(` ${ME} `, ME)).toBe(true);
    expect(isSelfSend(BOB, ME)).toBe(false);
    expect(isSelfSend('', ME)).toBe(false);
    expect(
      bulkIssues({
        rows: [
          { address: BOB, amount: '1' },
          { address: ME, amount: '1' },
        ],
        own: ME,
        publicOct: '10',
        ou: '1000',
      }).self
    ).toBe(true);
  });
});

describe('bulk', () => {
  it('drops a contract token when entering bulk', () => {
    const oct: { contractAddress: string | null; symbol: string } = {
      contractAddress: null,
      symbol: 'OCT',
    };
    const token = { contractAddress: 'octTOKEN', symbol: 'TKN' };
    expect(assetForMode('bulk', token, oct)).toBe(oct);
    expect(assetForMode('single', token, oct)).toBe(token);
    expect(assetForMode('bulk', oct, oct)).toBe(oct);
  });

  it('charges one fee per transfer against the OCT balance', () => {
    const rows = [
      { address: BOB, amount: '0.5' },
      { address: BOB, amount: '0.498' },
    ];
    expect(bulkTotalUnits(rows)).toBe(998000n);
    expect(bulkIssues({ rows, own: ME, publicOct: '1', ou: '1000' }).overBalance).toBe(false);
    expect(bulkIssues({ rows, own: ME, publicOct: '1', ou: '1001' }).overBalance).toBe(true);
  });

  it('reads Sent only when every transfer confirmed', () => {
    expect(bulkPollStage(['done', 'done'], 2)).toEqual({ stage: 'done', sent: 2 });
    expect(bulkPollStage(['done', 'pending'], 2)).toEqual({ stage: 'pending', sent: 1 });
    expect(bulkPollStage(['done', 'failed'], 2)).toEqual({ stage: 'failed', sent: 1 });
    expect(bulkPollStage(['done', 'done'], 3)).toEqual({ stage: 'failed', sent: 2 });
  });
});

describe('token decimals and balances', () => {
  it('keeps a 0-decimal token at 0', () => {
    expect(tokenDecimals(0)).toBe(0);
    expect(tokenDecimals('0')).toBe(0);
    expect(tokenDecimals(18)).toBe(18);
    expect(tokenDecimals(undefined)).toBe(6);
    expect(tokenDecimals(null)).toBe(6);
    expect(tokenDecimals(-1)).toBe(6);
  });

  it('turns raw units into an exact decimal string', () => {
    expect(tokenBalanceFromRaw('123456789012345678901', 18)).toBe('123.456789012345678901');
    expect(tokenBalanceFromRaw('42', 0)).toBe('42');
    expect(tokenBalanceFromRaw('9007199254740993', 0)).toBe('9007199254740993');
    expect(tokenBalanceFromRaw('', 6)).toBe('0');
    expect(tokenBalanceFromRaw(undefined, 6)).toBe('0');
    expect(tokenBalanceFromRaw('1.5', 6)).toBe('0');
  });

  it('Max never exceeds the real balance', () => {
    const bal = tokenBalanceFromRaw('9007199254740993', 0);
    expect(maxSendable('token', bal, 0, '1000')).toBe('9007199254740993');
    expect(amountUnits(maxSendable('token', bal, 0, '1000'), 0)).toBe(9007199254740993n);
  });

  it('Max waits for the live fee', () => {
    expect(maxSendable('public', '5', 6, null)).toBeNull();
    expect(maxSendable('token', '5', 6, null)).toBeNull();
    expect(maxSendable('public', '5', 6, '1000000')).toBe('4');
  });

  it('formats a balance without a float', () => {
    expect(displayAmount('1234567.123456789', 9, 6)).toBe('1,234,567.123456');
    expect(displayAmount('0', 6)).toBe('0');
    expect(displayAmount(null, 6)).toBe('0');
  });
});
