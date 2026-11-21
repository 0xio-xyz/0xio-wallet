import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import 'src/i18n';

const rpc = vi.hoisted(() => vi.fn());
const view = vi.hoisted(() => vi.fn());
vi.mock('src/services/network/NetworkService', () => ({
  networkService: { jsonRpcCall: rpc, contractCallView: view },
  privacyNetworkService: {},
}));
const list = vi.hoisted(() => vi.fn());
vi.mock('src/features/wallet/nft/knownCollections', async (original) => ({
  ...(await original<typeof import('src/features/wallet/nft/knownCollections')>()),
  fetchJson: list,
}));
vi.mock('src/shared/ui/WalletAvatar', () => ({ default: (): null => null }));
vi.mock('src/services/network/txScope', async (original) => ({
  ...(await original<typeof import('src/services/network/txScope')>()),
  resolveNetworkPin: async (networkId = 'devnet') => ({
    networkId,
    rpcUrl: `https://${networkId}.example`,
  }),
}));

import {
  clearOnsCache,
  forgetOnsContracts,
  loadOnsContract,
  onsBusyRetry,
  onsContract,
} from 'src/services/names/ons';
import { RpcResponseError } from 'src/services/network/txOutcome';
import type { NetworkPin } from 'src/services/network/txScope';
import { ONS_BUSY_CODE, type OnsFailure } from 'src/utils/octra/ons';
import { PlainError } from 'src/utils/plainError';
import {
  assertNamedSend,
  checkNamedRecipient,
  isNameEntry,
} from 'src/features/transactions/onsRecipient';
import {
  NAME_CARD_HEIGHT,
  NAME_ROW_HEIGHT,
  NameRow,
  NameToCard,
} from 'src/features/transactions/components/NameRecipient';
import { NAME_LOOKUP_DELAY_MS, useNameLookup } from 'src/hooks/wallet/useNameLookup';
import { clearPrimaryNames, usePrimaryName } from 'src/hooks/wallet/usePrimaryName';
import {
  clearOnsNames,
  onsKnownCollections,
  onsOwnedIds,
  onsOwnerState,
} from 'src/features/wallet/nft/onsNames';
import { useOnsPiece } from 'src/features/wallet/nft/useOnsPiece';
import { busyRetry } from 'src/features/wallet/nft/euint/chainState';
import vectors from './fixtures/ons-vectors.json';

const DEVNET: NetworkPin = { networkId: 'devnet', rpcUrl: 'https://devnet.example' };
const CONTRACT = vectors.contracts.devnet;
const WALLET = 'oct7xKq3mVbT9fWc2ZnHs5RdYgPj8LuAe4GtNwB6CrXhEaS';
const MOVED = 'oct2Zd8FhWq5TnYc9RmJv4KsXb7PgLe3AuNtC6GwHyBiQo1';
const BUSY = { code: ONS_BUSY_CODE, message: 'Program view busy' };
const PAYS = `2|${WALLET}`;
const PAYS_MOVED = `2|${MOVED}`;

type Answer = string | { code?: number; message: string };
type Script = Record<string, Answer | Answer[]>;

function script(replies: Script): void {
  const left: Record<string, Answer[]> = {};
  for (const [method, answer] of Object.entries(replies))
    left[method] = Array.isArray(answer) ? [...answer] : [answer];
  rpc.mockImplementation(async (_rpc: string, params: [string, string, string[]]) => {
    const queue = left[params[1]];
    if (!queue?.length) throw new Error(`no reply scripted for ${params[1]}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (typeof next !== 'string') throw new RpcResponseError(next.message, next);
    return { result: next };
  });
}

const methods = () => rpc.mock.calls.map(([, params]) => params[1]);

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
  clearOnsCache();
  clearPrimaryNames();
  clearOnsNames();
  onsBusyRetry.delaysMs = savedOns.map(() => 0);
  busyRetry.delaysMs = savedNft.map(() => 0);
});

afterEach(() => {
  onsBusyRetry.delaysMs = savedOns;
  busyRetry.delaysMs = savedNft;
  vi.useRealTimers();
});

const lookupOf = (text: string, networkId: 'devnet' | 'mainnet' = 'devnet') =>
  renderHook(() => useNameLookup(text, networkId));

describe('the name row of the recipient picker', () => {
  it('is offered only for text ending in .oct on a network with a contract', () => {
    expect(isNameEntry('0xio.oct', 'devnet')).toBe(true);
    expect(isNameEntry('0xio', 'devnet')).toBe(false);
    expect(isNameEntry(WALLET, 'devnet')).toBe(false);
    expect(isNameEntry('0xio.oct', 'mainnet')).toBe(false);
    const { result } = lookupOf('0xio.oct', 'mainnet');
    expect(result.current.lookup).toEqual({ state: 'off' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('shows the name resolving, then the whole address', async () => {
    script({ resolve: PAYS });
    const { result } = lookupOf('0xIO.oct');
    expect(result.current.lookup).toEqual({ state: 'resolving', label: '0xio.oct' });
    await waitFor(() =>
      expect(result.current.lookup).toEqual({
        state: 'resolved',
        label: '0xio.oct',
        name: '0xio',
        address: WALLET,
      })
    );
    expect(rpc.mock.calls[0][1][0]).toBe(CONTRACT);
  });

  it('drops a name that resolved when the text changes inside the pause', async () => {
    const onResolved = vi.fn();
    script({ resolve: PAYS });
    const { result, rerender } = renderHook(
      ({ text }) => useNameLookup(text, 'devnet', true, onResolved),
      { initialProps: { text: '0xio.oct' } }
    );
    await waitFor(() => expect(result.current.lookup.state).toBe('resolved'));
    script({ resolve: '0|', status_of: '0' });
    rerender({ text: '0xio-labs.oct' });
    await waitFor(() => expect(result.current.lookup.state).toBe('failed'));
    await new Promise((r) => setTimeout(r, 1100));
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('hands a typed name over after a pause in typing, and nothing for one that cannot be paid', async () => {
    const onResolved = vi.fn();
    script({ resolve: PAYS });
    const first = renderHook(() => useNameLookup('0xio.oct', 'devnet', true, onResolved));
    await waitFor(() => expect(first.result.current.lookup.state).toBe('resolved'));
    expect(onResolved).not.toHaveBeenCalled();
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1), { timeout: 2500 });
    expect(onResolved).toHaveBeenCalledWith('0xio', WALLET);
    first.rerender();
    expect(onResolved).toHaveBeenCalledTimes(1);
    first.unmount();
    script({ resolve: '0|', status_of: '0' });
    const second = renderHook(() => useNameLookup('nobody.oct', 'devnet', true, onResolved));
    await waitFor(() => expect(second.result.current.lookup.state).toBe('failed'));
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it('waits for a pause in typing before asking the node', () => {
    vi.useFakeTimers();
    script({ resolve: PAYS });
    const { rerender } = renderHook(({ text }) => useNameLookup(text, 'devnet'), {
      initialProps: { text: 'a.oct' },
    });
    rerender({ text: 'al.oct' });
    vi.advanceTimersByTime(NAME_LOOKUP_DELAY_MS - 1);
    expect(rpc).not.toHaveBeenCalled();
  });

  const reasons: Array<[string, Script, OnsFailure, string]> = [
    ['not registered', { resolve: '0|', status_of: '0' }, 'not_registered', 'not registered'],
    ['no wallet set', { resolve: '0|', status_of: '1' }, 'not_set', 'no wallet set'],
    [
      'points to a Circle',
      { resolve: `1|${MOVED}`, status_of: '1' },
      'points_to_circle',
      'points to a Circle',
    ],
    ['expired', { resolve: '0|', status_of: '2' }, 'expired', 'has expired'],
    ['expired with its kind kept', { resolve: '2|', status_of: '2' }, 'expired', 'has expired'],
    ['reserved', { resolve: '0|', status_of: '3' }, 'reserved', 'is reserved'],
    ['invalid', { resolve: '0|', status_of: '4' }, 'invalid', 'Not a valid name'],
  ];

  it.each(reasons)('says why a name cannot be paid: %s', async (_n, replies, reason, words) => {
    script(replies);
    const { result } = lookupOf('0xio-labs.oct');
    await waitFor(() => expect(result.current.lookup.state).toBe('failed'));
    const lookup = result.current.lookup;
    expect(lookup).toEqual({ state: 'failed', label: '0xio-labs.oct', reason });
    if (lookup.state !== 'failed') return;
    const onPick = vi.fn();
    render(<NameRow lookup={lookup} selected={false} onPick={onPick} onRetry={vi.fn()} />);
    expect(screen.getByText(new RegExp(words))).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    fireEvent.click(screen.getByText('0xio-labs.oct'));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('refuses a name that is not valid without a call', async () => {
    const { result } = lookupOf('al_ice.oct');
    await waitFor(() =>
      expect(result.current.lookup).toEqual({
        state: 'failed',
        label: 'al_ice.oct',
        reason: 'invalid',
      })
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reads a busy node as busy, never as not registered, and asks again on retry', async () => {
    script({ resolve: [BUSY, BUSY, BUSY, PAYS] });
    const { result } = lookupOf('0xio.oct');
    await waitFor(() => expect(result.current.lookup.state).toBe('failed'));
    expect(result.current.lookup).toMatchObject({ reason: 'busy' });
    expect(methods()).not.toContain('status_of');
    act(() => result.current.retry());
    expect(result.current.lookup.state).toBe('resolving');
    await waitFor(() => expect(result.current.lookup).toMatchObject({ address: WALLET }));
  });

  it('reads a node that does not answer as unreachable, with a retry in the row', async () => {
    script({ resolve: { message: 'RPC HTTP error: 502' } });
    const { result } = lookupOf('0xio.oct');
    await waitFor(() => expect(result.current.lookup.state).toBe('failed'));
    const lookup = result.current.lookup;
    if (lookup.state !== 'failed') throw new Error('expected a failed lookup');
    expect(lookup.reason).toBe('unavailable');
    const onRetry = vi.fn();
    render(<NameRow lookup={lookup} selected={false} onPick={vi.fn()} onRetry={onRetry} />);
    expect(screen.getByText('Could not reach the node')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Try again'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps one row height in every state and hands the address over only on a pick', () => {
    const onPick = vi.fn();
    const states = [
      { state: 'resolving', label: '0xio.oct' },
      { state: 'failed', label: '0xio.oct', reason: 'not_registered' },
      { state: 'failed', label: '0xio.oct', reason: 'busy' },
      { state: 'resolved', label: '0xio.oct', name: '0xio', address: WALLET },
    ] as const;
    for (const lookup of states) {
      const { container, unmount } = render(
        <NameRow lookup={lookup} selected={false} onPick={onPick} onRetry={vi.fn()} />
      );
      expect((container.firstChild as HTMLElement).style.height).toBe(`${NAME_ROW_HEIGHT}px`);
      if (lookup.state === 'resolved') {
        expect(container.textContent).toContain(`${WALLET.slice(0, 14)}...${WALLET.slice(-12)}`);
        expect(container.textContent).not.toContain(WALLET);
        expect(onPick).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button'));
        expect(onPick).toHaveBeenCalledWith('0xio', WALLET);
      }
      unmount();
    }
  });
});

describe('the read made again at confirm', () => {
  const picked = { name: '0xio', address: WALLET };

  it('passes when the name still points at the address on screen', async () => {
    script({ resolve: PAYS });
    expect(await checkNamedRecipient(picked, { at: DEVNET, fresh: true })).toEqual({
      kind: 'same',
      address: WALLET,
    });
  });

  it('asks the node past the cache', async () => {
    script({ resolve: [PAYS, PAYS_MOVED] });
    expect((await checkNamedRecipient(picked, { at: DEVNET, fresh: false })).kind).toBe('same');
    expect((await checkNamedRecipient(picked, { at: DEVNET, fresh: false })).kind).toBe('same');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(await checkNamedRecipient(picked, { at: DEVNET, fresh: true })).toEqual({
      kind: 'changed',
      was: WALLET,
      now: MOVED,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('stops when the fresh read fails, whatever an earlier read said', async () => {
    script({ resolve: [PAYS, { message: 'RPC HTTP error: 502' }] });
    expect((await checkNamedRecipient(picked, { at: DEVNET, fresh: false })).kind).toBe('same');
    expect(await checkNamedRecipient(picked, { at: DEVNET, fresh: true })).toEqual({
      kind: 'stopped',
      reason: 'unavailable',
    });
  });

  it('stops when the node stays busy or the name no longer resolves', async () => {
    script({ resolve: BUSY });
    expect(await checkNamedRecipient(picked, { at: DEVNET, fresh: true })).toEqual({
      kind: 'stopped',
      reason: 'busy',
    });
    script({ resolve: '0|', status_of: '2' });
    expect(await checkNamedRecipient(picked, { at: DEVNET, fresh: true })).toEqual({
      kind: 'stopped',
      reason: 'expired',
    });
  });

  it('signs only the address the confirm read returned', () => {
    expect(() => assertNamedSend(WALLET, WALLET)).not.toThrow();
    expect(() => assertNamedSend(WALLET, MOVED)).toThrow(PlainError);
    expect(() => assertNamedSend(WALLET, null)).toThrow(PlainError);
  });
});

describe('the To card of a send to a name', () => {
  const heightOf = (el: HTMLElement) => (el.firstChild as HTMLElement).style.height;

  it('shows the name over the whole address', () => {
    const { container } = render(
      <NameToCard name="0xio" address={WALLET} check={null} onUseNew={vi.fn()} onRetry={vi.fn()} />
    );
    expect(screen.getByText('0xio.oct')).toBeInTheDocument();
    expect(container.textContent).toContain(WALLET);
    expect(heightOf(container)).toBe(`${NAME_CARD_HEIGHT}px`);
  });

  it('swaps in place to was and now without changing height', () => {
    const onUseNew = vi.fn();
    const { container } = render(
      <NameToCard
        name="0xio"
        address={WALLET}
        check={{ kind: 'changed', was: WALLET, now: MOVED }}
        onUseNew={onUseNew}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('0xio.oct');
    expect(screen.getByRole('alert')).toHaveTextContent('points to a new address');
    expect(container.textContent).toContain(WALLET);
    expect(container.textContent).toContain(MOVED);
    expect(heightOf(container)).toBe(`${NAME_CARD_HEIGHT}px`);
    fireEvent.click(screen.getByText('Use new address'));
    expect(onUseNew).toHaveBeenCalledTimes(1);
  });

  it('shows the reason in place of the address when the read fails', () => {
    const onRetry = vi.fn();
    const { container, rerender } = render(
      <NameToCard
        name="0xio"
        address={WALLET}
        check={{ kind: 'stopped', reason: 'busy' }}
        onUseNew={vi.fn()}
        onRetry={onRetry}
      />
    );
    expect(screen.getByText('The node is busy')).toBeInTheDocument();
    expect(container.textContent).not.toContain(WALLET);
    expect(heightOf(container)).toBe(`${NAME_CARD_HEIGHT}px`);
    fireEvent.click(screen.getByText('Try again'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(
      <NameToCard
        name="0xio"
        address={WALLET}
        check={{ kind: 'stopped', reason: 'expired' }}
        onUseNew={vi.fn()}
        onRetry={onRetry}
      />
    );
    expect(screen.getByText('This name has expired')).toBeInTheDocument();
    expect(screen.queryByText('Try again')).toBeNull();
  });
});

describe('a primary name beside an address', () => {
  const Probe = ({ address, networkId }: { address: string; networkId: string }) => {
    const primary = usePrimaryName(address, networkId);
    return (
      <span ref={primary.ref} data-testid="name">
        {primary.name ?? ''}
      </span>
    );
  };
  const nameOf = (address: string, networkId = 'devnet') => {
    const { container } = render(<Probe address={address} networkId={networkId} />);
    return {
      result: {
        get current() {
          return container.querySelector('[data-testid="name"]')?.textContent || null;
        },
      },
    };
  };

  it('shows the name once the row is on screen', async () => {
    script({ primary_of: '0xio' });
    const { result } = nameOf(WALLET);
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe('0xio'));
    expect(nameOf(WALLET).result.current).toBe('0xio');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('shows the address alone when there is no primary name', async () => {
    script({ primary_of: '' });
    const { result } = nameOf(WALLET);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(result.current).toBeNull();
  });

  it('shows the address alone when the node is busy, and does not ask again at once', async () => {
    script({ primary_of: BUSY });
    const { result } = nameOf(WALLET);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(result.current).toBeNull();
    nameOf(WALLET);
    await act(async () => {});
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it('makes no call on a network without a contract or for text that is no address', async () => {
    nameOf(WALLET, 'mainnet');
    nameOf('0x52908400098527886E0F7030069857D2E4169EE7');
    await act(async () => {});
    expect(rpc).not.toHaveBeenCalled();
  });

  it('waits until the row has been on screen', async () => {
    const observed: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
          observed.push(cb);
        }
        observe() {}
        disconnect() {}
      }
    );
    script({ primary_of: '0xio' });
    const el = document.createElement('div');
    const { result } = renderHook(() => usePrimaryName(WALLET, 'devnet'));
    act(() => result.current.ref(el));
    await act(async () => {});
    expect(rpc).not.toHaveBeenCalled();
    act(() => observed[0]([{ isIntersecting: true }]));
    await waitFor(() => expect(result.current.name).toBe('0xio'));
    vi.unstubAllGlobals();
  });
});

describe('names in the NFT section', () => {
  const info = (tokenId: string, name: string) =>
    `${tokenId}|${name}|${WALLET}|1825920325|2||${WALLET}|0`;

  it('lists the checked ONS contract of the network', async () => {
    expect(await onsKnownCollections('devnet')).toEqual([
      { address: CONTRACT, name: 'ONS', symbol: 'ONS' },
    ]);
    expect(await onsKnownCollections('mainnet')).toEqual([]);
    expect(onsContract('devnet')).toBe(CONTRACT);
    expect(onsContract('mainnet')).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('takes the owned ids from the name info and titles a piece with its name', async () => {
    script({
      balance_of: '2',
      names_of: '0xio,old',
      get_name_info: [info('4', '0xio'), info('9', 'old')],
      status_of: ['1', '2'],
    });
    expect(await onsOwnedIds('devnet', WALLET)).toEqual({ ids: ['4', '9'], complete: true });
    const active = renderHook(() => useOnsPiece('devnet', CONTRACT, '4', WALLET));
    expect(active.result.current).toMatchObject({
      title: '0xio.oct',
      active: true,
      inactive: false,
      expires: 1825920325,
    });
    const grace = renderHook(() => useOnsPiece('devnet', CONTRACT, '9', WALLET));
    expect(grace.result.current).toMatchObject({ title: 'old.oct', active: false, inactive: true });
    expect(methods().filter((m) => m === 'balance_of')).toHaveLength(1);
  });

  it('is not an empty list when the node is busy', async () => {
    script({ balance_of: BUSY });
    await expect(onsOwnedIds('devnet', WALLET)).rejects.toThrow();
  });

  it('adds nothing to a piece of another collection', () => {
    const other = renderHook(() => useOnsPiece('devnet', MOVED, '4', WALLET));
    expect(other.result.current).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reads a lapsed owner_of as no longer active, a busy one as unknown', async () => {
    view.mockRejectedValueOnce(new RpcResponseError('execution reverted [ons: name lapsed]', {}));
    expect(await onsOwnerState('devnet', '4', WALLET)).toBe('lapsed');
    view.mockRejectedValueOnce(
      new RpcResponseError('execution reverted', { code: -32000, message: 'execution reverted' })
    );
    expect(await onsOwnerState('devnet', '4', WALLET)).toBe('lapsed');
    view.mockRejectedValue(new RpcResponseError(BUSY.message, BUSY));
    expect(await onsOwnerState('devnet', '4', WALLET)).toBe('unknown');
    view.mockReset();
    view.mockResolvedValue(WALLET);
    expect(await onsOwnerState('devnet', '4', WALLET)).toBe('held');
  });

  it('shows a lapsed name on its page as no longer active', async () => {
    script({
      balance_of: '1',
      names_of: '0xio',
      get_name_info: info('4', '0xio'),
      status_of: '1',
    });
    view.mockRejectedValue(new RpcResponseError('execution reverted [ons: name lapsed]', {}));
    const { result } = renderHook(() => useOnsPiece('devnet', CONTRACT, '4', WALLET, true));
    await waitFor(() =>
      expect(result.current).toMatchObject({ title: '0xio.oct', active: false, inactive: true })
    );
  });
});
