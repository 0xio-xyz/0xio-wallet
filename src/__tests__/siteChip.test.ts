import { describe, expect, it } from 'vitest';
import { siteChipState } from 'src/features/dapp/siteWallets';
import { readSite } from 'src/services/evm/siteModel';

const EVM_A = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const EVM_B = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';
const SITE = 'https://app.example';

const wallet = (id: string, address: string, evm?: string) =>
  ({
    id,
    name: id,
    address,
    type: 'standard',
    mnemonic: evm ? ['a'] : undefined,
    privateKey: evm ? undefined : 'k',
    metadata: evm ? { evm: { enabled: true, address: evm, index: 0 } } : {},
  }) as any;

const wallets = [wallet('a', 'octA', EVM_A), wallet('b', 'octB', EVM_B), wallet('k', 'octK')];

const site = (inUse: string, seenOpen: string) =>
  readSite(SITE, {
    chains: {},
    accounts: {
      a: { address: EVM_A, connectedAt: 1 },
      b: { address: EVM_B, connectedAt: 2 },
    },
    inUse,
    seenOpen,
  })!;

describe('the footer site chip', () => {
  it('shows the host when the site uses the open wallet', () => {
    const s = siteChipState(SITE, { evm: { [SITE]: site('a', 'a') }, octra: [] }, 'a', wallets);
    expect(s).toMatchObject({ kind: 'evm', host: 'app.example' });
    expect(s.kind === 'evm' && s.wallets.map((c) => c.wallet.id)).toEqual(['a', 'b']);
  });

  it("shows the site's own wallet when it uses another connected one", () => {
    const s = siteChipState(SITE, { evm: { [SITE]: site('b', 'a') }, octra: [] }, 'a', wallets);
    expect(s.kind === 'evm' && s.wallets[0].wallet.id).toBe('b');
  });

  it('is the plain Not connected chip when the open wallet is not one of its wallets', () => {
    expect(
      siteChipState(SITE, { evm: { [SITE]: site('a', 'a') }, octra: [] }, 'k', wallets)
    ).toEqual({ kind: 'join', origin: SITE });
    expect(siteChipState(SITE, { evm: {}, octra: [] }, 'a', wallets)).toEqual({ kind: 'none' });
    expect(siteChipState(null, { evm: {}, octra: [] }, 'a', wallets)).toEqual({ kind: 'none' });
  });

  it('shows an Octra site with the wallet it is on', () => {
    const octra = [{ key: 'dapp_connection_x', origin: SITE, address: 'octB', connectedAt: 1 }];
    expect(siteChipState(SITE, { evm: {}, octra }, 'a', wallets)).toMatchObject({
      kind: 'octra',
      wallet: { id: 'b' },
    });
  });
});

describe('stored sites', () => {
  it('give a site stored before several wallets the wallet connected last', () => {
    const s = readSite(SITE, {
      chains: { mainnet: 10, testnet: 'x' },
      accounts: {
        a: { address: EVM_A, connectedAt: 5 },
        b: { address: EVM_B, connectedAt: 9 },
        bad: { address: 'oct' },
      },
    })!;
    expect(s.inUse).toBe('b');
    expect(Object.keys(s.accounts)).toEqual(['a', 'b']);
    expect(s.chains).toEqual({ mainnet: 10 });
    expect(readSite(SITE, 'nope')).toBeNull();
  });
});
