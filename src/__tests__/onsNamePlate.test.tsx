import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import 'src/i18n';

const rpc = vi.hoisted(() => vi.fn());
const view = vi.hoisted(() => vi.fn());
const WALLET = 'oct7xKq3mVbT9fWc2ZnHs5RdYgPj8LuAe4GtNwB6CrXhEaS';
const OTHER = 'oct2Zd8FhWq5TnYc9RmJv4KsXb7PgLe3AuNtC6GwHyBiQo1';

vi.mock('src/services/network/NetworkService', () => ({
  networkService: {
    jsonRpcCall: rpc,
    contractCallView: view,
    getCurrentNetworkId: async () => 'devnet',
  },
  privacyNetworkService: {},
}));
vi.mock('src/services/network/txScope', async (original) => ({
  ...(await original<typeof import('src/services/network/txScope')>()),
  resolveNetworkPin: async (networkId = 'devnet') => ({
    networkId,
    rpcUrl: `https://${networkId}.example`,
  }),
}));
vi.mock('src/contexts/WalletContext', () => ({
  useWallet: () => ({
    networkId: 'devnet',
    activeWallet: {
      address: 'oct7xKq3mVbT9fWc2ZnHs5RdYgPj8LuAe4GtNwB6CrXhEaS',
      name: 'Spending',
      privateKey: 'key',
    },
  }),
}));
const list = vi.hoisted(() => vi.fn());
vi.mock('src/features/wallet/nft/knownCollections', async (original) => ({
  ...(await original<typeof import('src/features/wallet/nft/knownCollections')>()),
  fetchJson: list,
}));
vi.mock('src/shared/ui/WalletAvatar', () => ({ default: (): null => null }));
vi.mock('src/shared/ui/Header', () => ({
  default: ({ title, rightAction }: { title: string; rightAction?: React.ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {rightAction}
    </header>
  ),
}));
vi.mock('src/features/wallet/nft/piece/format', async (original) => ({
  ...(await original<typeof import('src/features/wallet/nft/piece/format')>()),
  readOctUsd: async (): Promise<null> => null,
}));
vi.mock('src/features/wallet/nft/piece/NftFlowSheet', () => ({
  NftFlowSheet: ({ mode, name }: { mode: string; name: string }) => (
    <div data-testid="flow">{`${mode} ${name}`}</div>
  ),
}));
vi.mock('src/features/wallet/nft/piece/pieceData', async (original) => ({
  ...(await original<typeof import('src/features/wallet/nft/piece/pieceData')>()),
  readListing: async (): Promise<null> => null,
}));

import {
  clearOnsCache,
  forgetOnsContracts,
  loadOnsContract,
  onsBusyRetry,
} from 'src/services/names/ons';
import { RpcResponseError } from 'src/services/network/txOutcome';
import { cardDetailCache } from 'src/features/wallet/nft/nftData';
import { clearOnsNames } from 'src/features/wallet/nft/onsNames';
import { busyRetry } from 'src/features/wallet/nft/euint/chainState';
import { pieceCacheKey } from 'src/features/wallet/nft/piece/pieceData';
import { fmtDay } from 'src/features/wallet/nft/piece/format';
import { NamePlate } from 'src/features/wallet/nft/gallery/NamePlate';
import { NftTile } from 'src/features/wallet/nft/gallery/NftTile';
import { NftPiecePage } from 'src/features/wallet/nft/piece/NftPiecePage';
import vectors from './fixtures/ons-vectors.json';

const CONTRACT = vectors.contracts.devnet;
const EXPIRES = 1825920325;
const info = (name: string, expires = EXPIRES) => `4|${name}|${WALLET}|${expires}|2||${WALLET}|0`;

const META = 'https://names.example/meta/4.json';
const ART = 'https://names.example/art/4.svg';
const host = { meta: true, image: ART, uri: META as string | Error };

function holds(name: string, status: string, expires = EXPIRES): void {
  const replies: Record<string, string> = {
    balance_of: '1',
    names_of: name,
    get_name_info: info(name, expires),
    status_of: status,
  };
  rpc.mockImplementation(async (_rpc: string, params: [string, string]) => ({
    result: replies[params[1]],
  }));
}

const fetched = vi.fn();
let made = 0;
const savedOns = onsBusyRetry.delaysMs;
const savedNft = busyRetry.delaysMs;

beforeEach(async () => {
  rpc.mockReset();
  view.mockReset();
  list.mockReset().mockResolvedValue({
    services: [{ network: 'devnet', address: CONTRACT, suffix: '.oct' }],
  });
  rpc.mockResolvedValue({ result: vectors.parse.nameService[0].raw });
  forgetOnsContracts();
  await loadOnsContract({ networkId: 'devnet', rpcUrl: 'https://devnet.example' });
  rpc.mockReset();
  fetched.mockReset();
  vi.stubGlobal('fetch', fetched);
  fetched.mockImplementation(async (url: string) => {
    if (url === META && host.meta)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: '0xio.oct',
          description: 'A name',
          image: host.image,
          attributes: [
            { trait_type: 'Length', value: 4 },
            { trait_type: 'Points to', value: OTHER },
            { trait_type: 'Expires', value: EXPIRES, display_type: 'date' },
          ],
        }),
      };
    if (url === ART) return { ok: true, status: 200, blob: async () => new Blob(['a']) };
    return { ok: false, status: 500 };
  });
  host.meta = true;
  host.image = ART;
  host.uri = META;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:art-${++made}`);
  view.mockImplementation(async (_contract: string, method: string) => {
    if (method !== 'token_uri') return WALLET;
    if (host.uri instanceof Error) throw host.uri;
    return host.uri;
  });
  clearOnsCache();
  clearOnsNames();
  cardDetailCache.clear();
  onsBusyRetry.delaysMs = savedOns.map(() => 0);
  busyRetry.delaysMs = savedNft.map(() => 0);
});

afterEach(() => {
  onsBusyRetry.delaysMs = savedOns;
  busyRetry.delaysMs = savedNft;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const plateOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-name-plate]');

describe('the name plate', () => {
  const names = ['0xio', 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6', 'my-very-long-shop-name'];

  it.each(names)('draws the whole name, never cut: %s', (name) => {
    const title = `${name}.oct`;
    const { container } = render(<NamePlate title={title} off={false} />);
    const plate = plateOf(container)!;
    expect(plate.dataset.namePlate).toBe('on');
    expect(plate.textContent).toBe(title);
    expect(plate.textContent).not.toContain('…');
    expect(plate.querySelector('.truncate, [class*="truncate"]')).toBeNull();
    const kept = [...plate.querySelectorAll('span')].find(
      (el) => el.style.whiteSpace === 'nowrap'
    )!;
    expect(kept.textContent).toBe(`${name.slice(-1)}.oct`);
    expect((kept.parentElement as HTMLElement).style.overflowWrap).toBe('anywhere');
  });

  it('holds its place with dots while the name is read, and dims when it is not active', () => {
    const loading = render(<NamePlate title={null} off={false} />);
    expect(plateOf(loading.container)!.dataset.namePlate).toBe('loading');
    expect(loading.container.querySelectorAll('.name-dots i')).toHaveLength(3);
    const off = render(<NamePlate title="0xio.oct" off />);
    expect(plateOf(off.container)!.dataset.namePlate).toBe('off');
    expect(off.container.textContent).toBe('0xio.oct');
  });
});

describe('a name in the NFT section', () => {
  const tile = (contract: string, tokenId: string) =>
    render(<NftTile contract={contract} tokenId={tokenId} onOpen={() => {}} onGone={() => {}} />);
  const page = (onGone = () => {}) =>
    render(
      <NftPiecePage
        contract={CONTRACT}
        tokenId="4"
        collection="Octra names"
        onClose={() => {}}
        onHidePiece={() => {}}
        onHideCollection={() => {}}
        onGone={onGone}
      />
    );
  const art = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('.nft-tile-art, [aria-busy]')!;
  const urls = () => fetched.mock.calls.map(([url]) => url);

  it('shows the artwork named by token_uri on the tile, under the name', async () => {
    holds('0xio', '1');
    const { container } = tile(CONTRACT, '4');
    expect(plateOf(container)).toBeNull();
    const img = await screen.findByRole('img', { name: '0xio.oct' });
    expect(img).toHaveAttribute('src', 'blob:art-1');
    expect(plateOf(container)).toBeNull();
    expect(urls()).toEqual([META, ART]);
    expect(view.mock.calls.filter(([, method]) => method === 'token_uri')).toEqual([
      [CONTRACT, 'token_uri', [4], WALLET],
    ]);
    expect(container.querySelector('.nft-tile > .truncate\\!')).toHaveTextContent('0xio.oct');
    expect(art(container).textContent).toBe('');
  });

  it('shows the artwork on the page with the chain facts and Transfer for an active name', async () => {
    holds('0xio', '1');
    const { container } = page();
    expect(screen.queryByRole('button', { name: 'Transfer' })).toBeNull();
    const transfer = await screen.findByRole('button', { name: 'Transfer' });
    expect(await screen.findByRole('img', { name: '0xio.oct' })).toHaveAttribute(
      'src',
      'blob:art-1'
    );
    expect(plateOf(container)).toBeNull();
    expect(art(container).textContent).toBe('');
    for (const text of ['Collection', 'Octra names', 'Owner', 'Spending', 'Status', 'Active'])
      expect(container).toHaveTextContent(text);
    expect(container).toHaveTextContent(`Expires${fmtDay(EXPIRES, 'en')}`);
    expect(container).toHaveTextContent('Length4');
    expect(container).not.toHaveTextContent('Points to');
    expect(container).not.toHaveTextContent(OTHER);
    expect(container).not.toHaveTextContent(String(EXPIRES));
    fireEvent.click(transfer);
    expect(screen.getByTestId('flow')).toHaveTextContent('send 0xio.oct');
  });

  it('falls back to the plate when the metadata cannot be read', async () => {
    holds('0xio', '1');
    host.meta = false;
    const { container } = tile(CONTRACT, '4');
    await waitFor(() => expect(plateOf(container)?.dataset.namePlate).toBe('on'));
    expect(plateOf(container)!.textContent).toBe('0xio.oct');
    expect(container.querySelector('img')).toBeNull();
    expect(art(container)).not.toHaveTextContent('#4');
  });

  it('falls back to the plate when the image cannot be read or drawn', async () => {
    holds('0xio', '1');
    host.image = 'https://names.example/art/gone.svg';
    const failed = tile(CONTRACT, '4');
    await waitFor(() => expect(plateOf(failed.container)?.dataset.namePlate).toBe('on'));
    expect(failed.container.querySelector('img')).toBeNull();
    failed.unmount();

    host.image = ART;
    cardDetailCache.clear();
    const { container } = page();
    fireEvent.error(await screen.findByRole('img', { name: '0xio.oct' }));
    expect(plateOf(container)!.textContent).toBe('0xio.oct');
    expect(container.querySelector('img')).toBeNull();
  });

  it('keeps a name whose token_uri reverts, on its plate', async () => {
    holds('0xio', '2');
    host.uri = new Error('execution reverted [ons: name lapsed]');
    const onGone = vi.fn();
    const { container } = page(onGone);
    await waitFor(() => expect(plateOf(container)?.dataset.namePlate).toBe('off'));
    expect(onGone).not.toHaveBeenCalled();
  });

  it('marks a name in grace Expired over the artwork, with no actions', async () => {
    holds('0xio', '2');
    const onTile = tile(CONTRACT, '4');
    await screen.findByRole('img', { name: '0xio.oct' });
    await waitFor(() => expect(art(onTile.container).textContent).toBe('Expired'));
    onTile.unmount();
    const { container } = page();
    await waitFor(() => expect(art(container).textContent).toBe('Expired'));
    expect(screen.getByRole('img', { name: '0xio.oct' })).toBeInTheDocument();
    expect(container).toHaveTextContent('StatusExpired');
    expect(container).toHaveTextContent(`Expired${fmtDay(EXPIRES, 'en')}`);
    expect(screen.queryByRole('button', { name: 'Transfer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('marks a lapsed name Expired, with no actions', async () => {
    holds('0xio', '1');
    view.mockImplementation(async (_contract: string, method: string) => {
      if (method === 'token_uri') return META;
      throw new RpcResponseError('execution reverted [ons: name lapsed]', {});
    });
    const { container } = page();
    await waitFor(() => expect(art(container).textContent).toBe('Expired'));
    expect(container).toHaveTextContent('StatusExpired');
    expect(screen.queryByRole('button', { name: 'Transfer' })).toBeNull();
  });

  it('marks the tile Expired when token_uri reverts or the expiry has passed', async () => {
    holds('0xio', '1');
    host.uri = new Error('execution reverted [ons: name lapsed]');
    const lapsed = tile(CONTRACT, '4');
    await waitFor(() => expect(art(lapsed.container)).toHaveTextContent('Expired'));
    expect(plateOf(lapsed.container)!.dataset.namePlate).toBe('off');
    lapsed.unmount();

    host.uri = META;
    clearOnsNames();
    cardDetailCache.clear();
    holds('0xio', '3', 1700000000);
    const past = tile(CONTRACT, '4');
    await waitFor(() => expect(art(past.container).textContent).toBe('Expired'));
    past.unmount();

    clearOnsNames();
    holds('0xio', '3');
    const { container } = page();
    await waitFor(() => expect(plateOf(container) ?? screen.queryByRole('img')).not.toBeNull());
    await waitFor(() => expect(container.querySelectorAll('.name-dots')).toHaveLength(0));
    expect(container).not.toHaveTextContent('Status');
    expect(art(container).textContent).toBe('');
    expect(container).not.toHaveTextContent('Not active');
    expect(screen.queryByRole('button', { name: 'Transfer' })).toBeNull();
  });

  it('keeps the artwork already shown when a later read finds none', async () => {
    holds('0xio', '1');
    const first = tile(CONTRACT, '4');
    await screen.findByRole('img', { name: '0xio.oct' });
    first.unmount();
    const key = pieceCacheKey('devnet', CONTRACT, '4', WALLET);
    cardDetailCache.set(key, { ...cardDetailCache.get(key)!, ts: 0 });
    host.meta = false;
    const reads = fetched.mock.calls.length;
    const { container } = page();
    await waitFor(() => expect(fetched.mock.calls.length).toBeGreaterThan(reads));
    await act(async () => {});
    expect(screen.getByRole('img', { name: '0xio.oct' })).toBeInTheDocument();
    expect(plateOf(container)).toBeNull();
    expect(cardDetailCache.get(key)!.detail.image).toBe(ART);
  });

  it('marks nothing on a token the wallet no longer holds as a name', async () => {
    rpc.mockImplementation(async (_rpc: string, params: [string, string]) => ({
      result: params[1] === 'balance_of' ? '0' : '',
    }));
    const { container } = page();
    await screen.findByRole('img', { name: '0xio.oct' });
    await waitFor(() => expect(container.querySelectorAll('.name-dots')).toHaveLength(0));
    expect(container).not.toHaveTextContent('Status');
    expect(art(container).textContent).toBe('');
    expect(container).not.toHaveTextContent('Not active');
    expect(screen.queryByRole('button', { name: 'Transfer' })).toBeNull();
  });

  it('marks nothing while the status is not known', async () => {
    rpc.mockImplementation(() => new Promise(() => {}));
    const { container } = tile(CONTRACT, '4');
    await screen.findByRole('img', { name: '0xio.oct' });
    expect(art(container).textContent).toBe('');
    expect(plateOf(container)).toBeNull();
  });

  it('offers Refresh metadata on a name and reads the artwork again past the cache', async () => {
    holds('0xio', '1');
    view.mockImplementation(async (_contract: string, method: string) =>
      method === 'token_uri' ? META : WALLET
    );
    const { container } = page();
    const shown = (await screen.findByRole('img', { name: '0xio.oct' })).getAttribute('src');
    const reads = () => view.mock.calls.filter(([, method]) => method === 'token_uri').length;
    const before = reads();
    fetched.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh metadata' }));
    });
    await waitFor(() =>
      expect(screen.getByRole('img', { name: '0xio.oct' })).not.toHaveAttribute('src', shown)
    );
    expect(reads()).toBe(before + 1);
    expect(fetched.mock.calls.map(([url, init]) => [url, init?.cache])).toEqual([
      [META, 'reload'],
      [ART, 'reload'],
    ]);
    expect(art(container)).toHaveAttribute('aria-busy', 'false');
  });

  it('writes no metadata host in the source', async () => {
    const files = import.meta.glob('/src/**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const source = Object.entries(files).filter(([path]) => !path.includes('__tests__'));
    expect(source.length).toBeGreaterThan(100);
    for (const [path, text] of source) expect(/workers\.dev|ons-site/.test(text), path).toBe(false);
  });

  it('leaves the tile of another collection as it was', async () => {
    host.meta = false;
    const { container } = tile(OTHER, '7');
    await waitFor(() => expect(container.querySelector('.nft-tile-art')).toHaveTextContent('#7'));
    expect(plateOf(container)).toBeNull();
    expect(container.querySelector('.nft-tile > .truncate\\!')).toHaveTextContent('#7');
  });
});
