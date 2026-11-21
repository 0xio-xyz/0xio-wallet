import { describe, it, expect } from 'vitest';
import {
  classifyTx,
  transferFromEvent,
  transferArgs,
  enrichTokenTransfers,
  type TransferDeps,
} from 'src/services/tokens/tokenTransfers';
import { txAsset, transferTitle, formatRawUnits, amountSign } from 'src/utils/txDisplay';
import type { TransactionHistoryItem } from 'src/types/transaction';

const ME = 'octMe00000000000000000000000000000000000000000';
const SENDER = 'octSender000000000000000000000000000000000000';
const NFT = 'octNftContract000000000000000000000000000000000';
const TOKEN = 'octTokenContract0000000000000000000000000000000';

const tx = (over: Partial<TransactionHistoryItem>): TransactionHistoryItem => ({
  hash: 'h1',
  timestamp: 1,
  type: 'outgoing',
  amount: 0,
  from: ME,
  to: NFT,
  address: NFT,
  nonce: 1,
  confirmed: true,
  status: 'success',
  network: 'mainnet',
  ...over,
});

const memoryStore = () => {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (k: string) => data[k],
    set: async (k: string, v: unknown) => {
      data[k] = JSON.parse(JSON.stringify(v));
    },
  };
};

const deps = (over: Partial<TransferDeps> = {}): TransferDeps => ({
  networkId: 'mainnet',
  rpc: async (method, params) => {
    const hash = params[0];
    if (method === 'contract_receipt') {
      if (hash === 'nftIn')
        return {
          method: 'transfer',
          events: [{ event: 'Transferred', values: [SENDER, ME, '5'] }],
        };
      if (hash === 'nftOut') return { method: 'transfer', events: [] };
      if (hash === 'tokOut')
        return { method: 'transfer', events: [{ event: 'Transfer', values: [SENDER, '1500000'] }] };
      if (hash === 'approve') return { method: 'approve', events: [] };
      if (hash === 'unlock')
        return {
          method: 'unlock_trusted',
          events: [{ event: 'Unlocked', values: [ME, '32988664', '0x030cfc90'] }],
        };
      if (hash === 'otherCall') return { method: 'set_price', events: [] };
    }
    if (method === 'octra_transaction' && hash === 'nftOut')
      return { parsed_tx: { message: `["${SENDER}","7"]` } };
    throw new Error('not found');
  },
  abiMethods: async (c) =>
    c === NFT ? ['transfer', 'owner_of', 'token_uri'] : ['transfer', 'balance_of'],
  held: async () => [],
  nftInfo: async () => ({ name: 'Geodesics', symbol: 'GDSC' }),
  tokenInfo: async () => ({ symbol: 'USDX', decimals: 6 }),
  store: memoryStore(),
  ...over,
});

describe('classifying history rows', () => {
  it('reads a row listed under this wallet by someone else as received', () => {
    expect(classifyTx({ from: SENDER, to: NFT, opType: 'call' }, ME)).toMatchObject({
      notParty: true,
      isIncoming: true,
      ownCall: false,
    });
  });

  it('reads this wallet calling a contract as its own call', () => {
    expect(classifyTx({ from: ME, to: NFT, opType: 'call' }, ME)).toMatchObject({
      ownCall: true,
      isIncoming: false,
    });
  });

  it('leaves plain transfers and stealth alone', () => {
    expect(classifyTx({ from: SENDER, to: ME }, ME)).toMatchObject({
      notParty: false,
      isIncoming: true,
    });
    expect(classifyTx({ from: ME, to: 'stealth' }, ME)).toMatchObject({
      notParty: false,
      isStealth: true,
    });
  });
});

describe('reading a transfer', () => {
  it('takes both sides from the event, old and new shapes', () => {
    expect(
      transferFromEvent({ events: [{ event: 'Transferred', values: ['a', 'b', '5'] }] })
    ).toEqual({
      recipient: 'b',
      raw_amount: '5',
    });
    expect(transferFromEvent({ events: [{ event: 'Transfer', values: ['b', '9'] }] })).toEqual({
      recipient: 'b',
      raw_amount: '9',
    });
    expect(transferFromEvent({ events: [{ event: 'Approval', values: ['b', '9'] }] })).toBeNull();
  });

  it('falls back to the call arguments', () => {
    expect(transferArgs({ message: '["x","3"]' })).toEqual({ recipient: 'x', raw_amount: '3' });
    expect(transferArgs({ message: 'hello' })).toBeNull();
  });
});

describe('filling in history', () => {
  it('turns a received NFT into "Received NFT #5 GDSC", never 0 OCT', async () => {
    const [row] = await enrichTokenTransfers(
      [tx({ hash: 'nftIn', from: SENDER, to: NFT, type: 'outgoing', opType: 'call', amount: 0 })],
      ME,
      deps()
    );
    expect(row.type).toBe('incoming');
    expect(row.token_transfer).toMatchObject({ kind: 'nft', raw_amount: '5', symbol: 'GDSC' });
    expect(row.insideCall).toBeUndefined();
    expect(row.address).toBe(SENDER);
    expect(txAsset(row)).toMatchObject({ value: '#5', unit: 'GDSC', isNft: true });
    expect(transferTitle(row, true)).toBe('Received NFT');
  });

  it('turns an NFT this wallet sent into "Transferred NFT", to the recipient from the arguments', async () => {
    const [row] = await enrichTokenTransfers([tx({ hash: 'nftOut', opType: 'call' })], ME, deps());
    expect(row.token_transfer).toMatchObject({ kind: 'nft', recipient: SENDER, raw_amount: '7' });
    expect(row.address).toBe(SENDER);
    expect(transferTitle(row, false)).toBe('Transferred NFT');
  });

  it('shows a sent token in its own units', async () => {
    const [row] = await enrichTokenTransfers(
      [tx({ hash: 'tokOut', to: TOKEN, opType: 'call' })],
      ME,
      deps()
    );
    expect(txAsset(row)).toMatchObject({ value: '1.5', unit: 'USDX', isNft: false });
    expect(transferTitle(row, false)).toBe('Sent');
  });

  it('marks an unreadable receipt as pending, not 0 OCT, and retries it later', async () => {
    const d = deps();
    const [row] = await enrichTokenTransfers(
      [tx({ hash: 'missing', from: SENDER, to: NFT, opType: 'call', amount: 2 })],
      ME,
      d
    );
    expect(row.insideCall).toBe(true);
    expect(row.amount).toBe(0);
    expect(txAsset(row)).toMatchObject({ pending: true, value: '...' });
    expect((d.store as ReturnType<typeof memoryStore>).data.token_calls_v1).toBeUndefined();
  });

  it('does not treat another method as a transfer', async () => {
    const [row] = await enrichTokenTransfers([tx({ hash: 'approve', opType: 'call' })], ME, deps());
    expect(row.token_transfer).toBeUndefined();
    expect(transferTitle(row, false)).toBeNull();
  });

  it('reads each transaction and contract once', async () => {
    let reads = 0;
    const base = deps();
    const counting = deps({
      store: base.store,
      rpc: async (m, p) => {
        reads++;
        return base.rpc(m, p);
      },
    });
    await enrichTokenTransfers([tx({ hash: 'nftOut', opType: 'call' })], ME, counting);
    const first = reads;
    await enrichTokenTransfers([tx({ hash: 'nftOut', opType: 'call' })], ME, counting);
    expect(reads).toBe(first);
  });

  it('leaves another network alone but still never shows 0 OCT', async () => {
    const [row] = await enrichTokenTransfers(
      [tx({ hash: 'nftIn', from: SENDER, to: NFT, opType: 'call', network: 'devnet' })],
      ME,
      deps()
    );
    expect(row.token_transfer).toBeUndefined();
    expect(row.insideCall).toBe(true);
  });
});

describe('payouts and other calls', () => {
  it('reads a bridge unlock as received OCT', async () => {
    const [row] = await enrichTokenTransfers(
      [tx({ hash: 'unlock', from: SENDER, to: NFT, opType: 'call', amount: 0 })],
      ME,
      deps()
    );
    expect(row.type).toBe('incoming');
    expect(row.amount).toBeCloseTo(32.988664, 6);
    expect(row.callLabel).toBe('Bridge unlock');
    expect(row.insideCall).toBeUndefined();
    expect(transferTitle(row, true)).toBe('Bridge unlock');
    expect(txAsset(row)).toMatchObject({ value: '32.988664', unit: 'OCT', pending: false });
  });

  it('stops waiting once a call that reached the wallet is read and names nothing', async () => {
    const [row] = await enrichTokenTransfers(
      [tx({ hash: 'otherCall', from: SENDER, to: NFT, opType: 'call', amount: 0 })],
      ME,
      deps()
    );
    expect(row.insideCall).toBeUndefined();
    expect(row.amountUnknown).toBe(true);
    expect(txAsset(row)).toMatchObject({ value: '', pending: true });
  });
});

describe('zero and hidden amounts', () => {
  it('gives a zero-OCT call no sign and a private send "Hidden"', () => {
    const zero = txAsset({ amount: 0 });
    expect(zero).toMatchObject({ value: '0', isZero: true });
    expect(amountSign(zero, '-')).toBe('');
    const priv = txAsset({ amount: 0, opType: 'private_transfer' });
    expect(priv).toMatchObject({ value: 'Hidden', hidden: true });
    expect(amountSign(txAsset({ amount: 2 }), '-')).toBe('-');
  });
});

describe('raw token units', () => {
  it('shifts by decimals without losing digits', () => {
    expect(formatRawUnits('1500000', 6)).toBe('1.5');
    expect(formatRawUnits('123456789012345678901234', 18)).toBe('123456.789012345678901234');
    expect(formatRawUnits('0', 6)).toBe('0');
    expect(formatRawUnits('5', 0)).toBe('5');
  });
});
