import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { logger } from '../../utils/logger';
import { waitForWalletUnlock } from '../services/wallet';
import {
  accountsFor,
  connectEvmSite,
  currentSide,
  disconnectEvmSite,
  evmVault,
  loadEvmSites,
  markEvmOrigin,
  pushEvmState,
  recentEvmWallet,
  setSiteChain,
  siteAccounts,
  siteChainId,
  siteNetwork,
  toHexChain,
  setEvmSiteWallet,
  type EvmSide,
  type EvmWalletRef,
  type OpenVault,
} from '../services/evmSites';
import { ZeroXIOConfig } from '../../utils/config';
import {
  hasPendingEvmApproval,
  requestEvmApproval,
  type EvmApprovalAnswer,
} from '../services/evmApprovals';
import { applyApproveEdit } from '../../services/evm/approveEdit';
import { toChecksumAddress } from '../../services/evm/accounts';
import { decodeKnownCall, selectorOf } from '../../services/evm/calldata';
import {
  EvmTokenError,
  addCustomEvmToken,
  readErc20Metadata,
  resolveCustomEvmToken,
} from '../../services/evm/customTokens';
import type { EvmApprovalChain, EvmApprovalData } from '../../services/evm/dappTypes';
import { readableMessage, signPersonalMessage } from '../../services/evm/messages';
import type { EvmNetwork } from '../../services/evm/networks';
import {
  addCustomNetwork,
  allNetworksFor,
  enableNetwork,
  findNetwork,
} from '../../services/evm/registry';
import { isOrigin } from '../../services/evm/networkPrefs';
import { estimateFees, estimateGas, getNonce, type EvmFees } from '../../services/evm/send';
import { signAndBroadcast, withEvmKey } from '../../services/evm/signer';
import { contractAddressFor, isEvmAddress } from '../../services/evm/tx';
import {
  parseTypedData,
  signTypedData,
  typedDataChainId,
  typedDataHash,
} from '../../services/evm/typedData';

export class EvmRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
    this.name = 'EvmRpcError';
  }
}

const rejected = () => new EvmRpcError(4001, 'User rejected the request.');
const invalid = (why: string) => new EvmRpcError(-32602, why);
const unauthorized = (why: string) => new EvmRpcError(4100, why);

const PREFIXES = ['eth_', 'net_', 'wallet_', 'personal_', 'web3_'];

export const isEvmMethod = (method: unknown): method is string =>
  typeof method === 'string' &&
  method !== 'wallet_hello' &&
  PREFIXES.some((p) => method.startsWith(p));

export const EVM_READ_METHODS = new Set([
  'eth_call',
  'eth_getBalance',
  'eth_blockNumber',
  'eth_estimateGas',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getCode',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
  'eth_getTransactionCount',
  'eth_getLogs',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getStorageAt',
  'eth_syncing',
  'eth_getBlockReceipts',
  'eth_getBlockTransactionCountByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionByBlockNumberAndIndex',
  'eth_getUncleCountByBlockHash',
  'eth_getUncleCountByBlockNumber',
  'eth_getProof',
  'eth_createAccessList',
  'eth_blobBaseFee',
  'eth_simulateV1',
  'eth_newFilter',
  'eth_newBlockFilter',
  'eth_getFilterChanges',
  'eth_getFilterLogs',
  'eth_uninstallFilter',
]);

const LOCAL_METHODS = new Set([
  'eth_chainId',
  'net_version',
  'eth_accounts',
  'eth_coinbase',
  'wallet_getProviderState',
  'wallet_getPermissions',
  'wallet_getCapabilities',
  'web3_clientVersion',
  'web3_sha3',
  'net_listening',
]);

const REFUSED: Record<string, string> = {
  eth_sign: 'eth_sign signs a raw hash and is not supported. Use personal_sign.',
  eth_signTransaction: 'Signing without sending is not supported.',
  eth_signTypedData: 'Use eth_signTypedData_v4.',
  eth_signTypedData_v1: 'Use eth_signTypedData_v4.',
  eth_sendRawTransaction: 'Sending a transaction signed elsewhere is not supported.',
};

const BURST = 200;
const REFILL_PER_SEC = 50;
const budgets = new Map<string, { tokens: number; at: number }>();

export function takeEvmBudget(origin: string, now = Date.now()): boolean {
  const b = budgets.get(origin) ?? { tokens: BURST, at: now };
  b.tokens = Math.min(BURST, b.tokens + ((now - b.at) / 1000) * REFILL_PER_SEC);
  b.at = now;
  budgets.set(origin, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

const unlockPromptAt = new Map<string, number>();

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function originOf(sender: chrome.runtime.MessageSender): string | null {
  if (sender.id !== chrome.runtime.id || !sender.tab) return null;
  let origin = sender.origin || '';
  if (!origin && sender.url) {
    try {
      origin = new URL(sender.url).origin;
    } catch {
      return null;
    }
  }
  return /^https?:\/\/[^/]+$/.test(origin) ? origin : null;
}

async function siteInfo(
  sender: chrome.runtime.MessageSender,
  origin: string
): Promise<{ title: string; favicon: string }> {
  try {
    const tab = await chrome.tabs.get(sender.tab!.id!);
    if (tab?.title) return { title: tab.title, favicon: tab.favIconUrl || `${origin}/favicon.ico` };
  } catch {}
  return { title: new URL(origin).hostname, favicon: `${origin}/favicon.ico` };
}

const chainOf = (n: EvmNetwork): EvmApprovalChain => ({
  chainId: n.chainId,
  name: n.name,
  nativeSymbol: n.nativeSymbol,
  testnet: n.testnet,
  logoChainId: n.logoChainId,
});

function quantity(value: unknown, label: string): bigint {
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw invalid(`Invalid ${label}`);
}

function parseChainId(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,13}$/.test(value)) {
    throw invalid('chainId must be a 0x hex string');
  }
  const n = parseInt(value, 16);
  if (!Number.isSafeInteger(n) || n <= 0) throw invalid('Invalid chainId');
  return n;
}

const paramList = (params: unknown): unknown[] =>
  params === undefined || params === null ? [] : Array.isArray(params) ? params : [params];

async function forward(network: EvmNetwork, method: string, params: unknown[]): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(network.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new EvmRpcError(-32603, `Could not reach ${network.name}`);
  }
  if (res.status === 429) throw new EvmRpcError(-32005, 'The network is rate limiting requests');
  if (!res.ok) throw new EvmRpcError(-32603, `${network.name} answered HTTP ${res.status}`);
  let body: { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
  try {
    body = await res.json();
  } catch {
    throw new EvmRpcError(-32603, `${network.name} sent an unreadable answer`);
  }
  if (body?.error) {
    const code = Number.isInteger(body.error.code) ? (body.error.code as number) : -32603;
    throw new EvmRpcError(code, String(body.error.message ?? 'RPC error'), body.error.data);
  }
  if (!body || !('result' in body)) throw new EvmRpcError(-32603, 'The RPC sent no result');
  return body.result;
}

async function unlocked(origin: string): Promise<OpenVault> {
  const vault = await evmVault();
  if (vault.status === 'ok') return vault;
  if (Date.now() - (unlockPromptAt.get(origin) ?? 0) < 60_000) {
    throw unauthorized('Unlock 0xio, then try again.');
  }
  unlockPromptAt.set(origin, Date.now());
  try {
    await chrome.action.openPopup();
  } catch {
    await chrome.windows
      .create({ url: 'index.html', type: 'popup', width: 400, height: 600, focused: true })
      .catch(() => {});
  }
  if (!(await waitForWalletUnlock(60_000))) throw unauthorized('Unlock 0xio, then try again.');
  const after = await evmVault();
  if (after.status !== 'ok') throw unauthorized('Unlock 0xio, then try again.');
  return after;
}

const walletChanged = () => unauthorized('The open wallet changed. Send the request again.');

async function signerFor(
  origin: string,
  address?: unknown
): Promise<{ vault: OpenVault; signer: EvmWalletRef }> {
  // A stranger is refused before any unlock prompt, which alone would reveal the lock.
  if (!Object.keys((await loadEvmSites())[origin]?.accounts ?? {}).length) {
    throw unauthorized('Connect this site to 0xio first.');
  }
  const vault = await unlocked(origin);
  const accounts = siteAccounts(origin, await loadEvmSites(), vault).slice(0, 1);
  if (!accounts.length) throw unauthorized('Connect this site to 0xio first.');
  if (address === undefined) return { vault, signer: accounts[0] };
  const signer =
    typeof address === 'string'
      ? accounts.find((a) => a.address.toLowerCase() === address.toLowerCase())
      : undefined;
  if (!signer) throw unauthorized('This address is not connected to this site.');
  return { vault, signer };
}

const reviewWallet = (w: EvmWalletRef) => ({
  walletId: w.walletId,
  name: w.walletName,
  address: toChecksumAddress(w.address),
  octra: w.octraAddress,
});

const signing = (vault: OpenVault, signer: EvmWalletRef) => ({
  signer: reviewWallet(signer),
  openWallet:
    vault.open.walletId === signer.walletId
      ? null
      : {
          walletId: vault.open.walletId,
          name: vault.open.walletName,
          octra: vault.open.octraAddress,
        },
});

async function stillSame(origin: string, signer: EvmWalletRef, before: OpenVault) {
  const now = await evmVault();
  if (now.status !== 'ok') throw walletChanged();
  if (now.evm.get(signer.walletId)?.address.toLowerCase() !== signer.address.toLowerCase()) {
    throw walletChanged();
  }
  if (signer.walletId === before.open.walletId && now.open.walletId !== before.open.walletId) {
    throw walletChanged();
  }
  if (!(await loadEvmSites())[origin]?.accounts[signer.walletId]) {
    throw unauthorized('This site was disconnected.');
  }
}

async function approve(data: EvmApprovalData): Promise<EvmApprovalAnswer> {
  if (hasPendingEvmApproval(data.origin)) {
    throw new EvmRpcError(-32002, 'A request from this site is already waiting in 0xio.');
  }
  const answer = await requestEvmApproval(data);
  if (!answer.approved) throw rejected();
  return answer;
}

const inFlight = new Map<string, Promise<unknown>>();

function joined<T>(key: string, run: () => Promise<T>): Promise<T> {
  const open = inFlight.get(key);
  if (open) return open as Promise<T>;
  const p = run().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

const connectOnce = (origin: string, sender: chrome.runtime.MessageSender, ask: boolean) =>
  joined(`${origin}\nconnect`, () => requestAccounts(origin, sender, ask));

function permissionsOf(origin: string, accounts: string[]) {
  return accounts.length
    ? [
        {
          parentCapability: 'eth_accounts',
          invoker: origin,
          caveats: [{ type: 'restrictReturnedAccounts', value: accounts }],
          date: Date.now(),
        },
      ]
    : [];
}

async function requestAccounts(
  origin: string,
  sender: chrome.runtime.MessageSender,
  ask: boolean
): Promise<string[]> {
  const vault = await unlocked(origin);
  const sites = await loadEvmSites();
  const existing = accountsFor(origin, sites, vault);
  const open = vault.open;
  const openHere = !!open.evm && !!sites[origin]?.accounts[open.walletId];
  if (existing.length && (!ask || !open.evm || openHere)) return existing;
  const network = await siteNetwork(origin);
  const answer = await approve({
    kind: 'connect',
    origin,
    ...(await siteInfo(sender, origin)),
    chain: chainOf(network),
    open: {
      walletId: open.walletId,
      name: open.walletName,
      octra: open.octraAddress,
      address: open.evm ? toChecksumAddress(open.evm.address) : null,
    },
    wallets: open.evm ? [] : [...vault.evm.values()].map(reviewWallet),
    preselect: open.evm ? null : (recentEvmWallet(sites, vault)?.walletId ?? null),
  });
  const now = await evmVault();
  if (now.status !== 'ok') throw walletChanged();
  let chosen: EvmWalletRef | undefined;
  if (open.evm) {
    if (
      now.open.walletId !== open.walletId ||
      now.open.evm?.address.toLowerCase() !== open.evm.address.toLowerCase()
    ) {
      throw walletChanged();
    }
    chosen = now.open.evm;
  } else {
    chosen = answer.walletId ? now.evm.get(answer.walletId) : undefined;
    if (!chosen) throw rejected();
  }
  await connectEvmSite(origin, chosen.walletId, chosen.address, now.open.walletId);
  void pushEvmState([origin]);
  return accountsFor(origin, await loadEvmSites(), now);
}

async function switchChain(
  origin: string,
  sender: chrome.runtime.MessageSender,
  target: EvmNetwork
): Promise<null> {
  if ((await siteChainId(origin)) === target.chainId) return null;
  await unlocked(origin);
  const from = await siteNetwork(origin);
  const side: EvmSide = target.testnet ? 'testnet' : 'mainnet';
  if (side !== (await currentSide())) return switchSide(origin, sender, from, target, side);
  await approve({
    kind: 'switchChain',
    origin,
    ...(await siteInfo(sender, origin)),
    from: chainOf(from),
    to: chainOf(target),
  });
  await moveSiteChain(origin, target.chainId);
  return null;
}

async function switchSide(
  origin: string,
  sender: chrome.runtime.MessageSender,
  from: EvmNetwork,
  target: EvmNetwork,
  side: EvmSide
): Promise<null> {
  await approve({
    kind: 'switchSide',
    origin,
    ...(await siteInfo(sender, origin)),
    from: chainOf(from),
    to: chainOf(target),
    side,
  });
  if ((await currentSide()) !== side) {
    await chrome.storage.local.set({
      [ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK]: side === 'testnet' ? 'devnet' : 'mainnet',
    });
  }
  await moveSiteChain(origin, target.chainId);
  return null;
}

export async function moveSiteChain(origin: string, chainId: number): Promise<void> {
  await enableNetwork(chainId).catch(() => false);
  await setSiteChain(origin, chainId);
  void pushEvmState([origin]);
}

const TESTNET_NAME = /test|sepolia|goerli|holesky|hoodi|devnet|amoy|fuji/i;

async function addChain(
  origin: string,
  sender: chrome.runtime.MessageSender,
  params: unknown[]
): Promise<null> {
  const p = params[0];
  if (!isRecord(p)) throw invalid('Expected a chain object');
  const chainId = parseChainId(p.chainId);
  const known = await findNetwork(chainId);
  if (known) return switchChain(origin, sender, known);

  const name = typeof p.chainName === 'string' ? p.chainName.trim() : '';
  if (!name || name.length > 40) throw invalid('chainName must be 1 to 40 characters');
  const rpcUrl = (Array.isArray(p.rpcUrls) ? p.rpcUrls : []).find(
    (u: unknown): u is string => typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u)
  );
  if (!rpcUrl) throw invalid('rpcUrls needs an https URL');
  const currency = isRecord(p.nativeCurrency) ? p.nativeCurrency : null;
  const symbol = typeof currency?.symbol === 'string' ? currency.symbol.trim() : '';
  if (!symbol || symbol.length > 11)
    throw invalid('nativeCurrency.symbol must be 1 to 11 characters');
  if (currency?.decimals !== undefined && currency.decimals !== 18) {
    throw invalid('Only 18 decimal native currencies are supported');
  }
  const explorerUrl =
    (Array.isArray(p.blockExplorerUrls) ? p.blockExplorerUrls : []).find(
      (u: unknown): u is string => typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u)
    ) ?? null;

  await unlocked(origin);
  await approve({
    kind: 'addChain',
    origin,
    ...(await siteInfo(sender, origin)),
    chainId,
    name,
    rpcUrl,
    symbol,
    explorerUrl,
  });
  try {
    await addCustomNetwork({
      chainId,
      name,
      rpcUrl,
      nativeSymbol: symbol,
      nativeName: typeof currency?.name === 'string' ? currency.name : symbol,
      testnet: TESTNET_NAME.test(name) || (await currentSide()) === 'testnet',
      ...(explorerUrl ? { explorerUrl } : {}),
      addedBy: origin,
    });
  } catch (e) {
    throw new EvmRpcError(-32603, e instanceof Error ? e.message : 'Could not add this network');
  }
  await setSiteChain(origin, chainId);
  void pushEvmState([origin]);
  return null;
}

async function watchAsset(
  origin: string,
  sender: chrome.runtime.MessageSender,
  params: unknown
): Promise<boolean> {
  const p = Array.isArray(params) ? params[0] : params;
  if (!isRecord(p) || String(p.type).toUpperCase() !== 'ERC20' || !isRecord(p.options)) {
    throw invalid('Only ERC20 tokens can be added');
  }
  const o = p.options;
  if (!isEvmAddress(o.address)) throw invalid('Invalid token address');
  const decimals = o.decimals === undefined ? undefined : Number(o.decimals);
  const network = await siteNetwork(origin);
  const input = {
    chainId: network.chainId,
    address: o.address,
    ...(typeof o.symbol === 'string' ? { symbol: o.symbol } : {}),
    ...(decimals !== undefined ? { decimals } : {}),
    ...(typeof o.image === 'string' ? { logo: o.image } : {}),
  };
  let token;
  try {
    token = await resolveCustomEvmToken(input);
  } catch (e) {
    if (e instanceof EvmTokenError && e.problem === 'listed') return true;
    throw invalid(e instanceof Error ? e.message : 'Could not read this token');
  }
  await unlocked(origin);
  await approve({
    kind: 'watchAsset',
    origin,
    ...(await siteInfo(sender, origin)),
    chain: chainOf(network),
    address: token.address!,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
  });
  try {
    await addCustomEvmToken(input);
  } catch (e) {
    throw new EvmRpcError(-32603, e instanceof Error ? e.message : 'Could not add this token');
  }
  return true;
}

async function personalSign(
  origin: string,
  sender: chrome.runtime.MessageSender,
  params: unknown[]
): Promise<string> {
  let [message, address] = params;
  if (isEvmAddress(message) && !isEvmAddress(address)) [message, address] = [address, message];
  if (typeof message !== 'string') throw invalid('The message must be a string');
  if (message.length > 100_000) throw invalid('The message is too long');
  const { vault, signer } = await signerFor(origin, address);
  const network = await siteNetwork(origin);
  const shown = readableMessage(message);
  await approve({
    kind: 'personalSign',
    origin,
    ...(await siteInfo(sender, origin)),
    ...signing(vault, signer),
    address: toChecksumAddress(signer.address),
    chain: chainOf(network),
    text: shown.text,
    hex: shown.hex,
  });
  await stillSame(origin, signer, vault);
  return withEvmKey(signer.source.walletId, signer.source.index, signer.address, (key) =>
    signPersonalMessage(message as string, key)
  );
}

const PERMIT = /permit/i;

async function signTyped(
  origin: string,
  sender: chrome.runtime.MessageSender,
  params: unknown[]
): Promise<string> {
  const [address, raw] = params;
  let typed;
  try {
    typed = parseTypedData(raw);
    typedDataHash(typed);
  } catch (e) {
    throw invalid(e instanceof Error ? e.message : 'Invalid typed data');
  }
  const { vault, signer } = await signerFor(origin, address);
  const network = await siteNetwork(origin);
  let domainChain: number | null;
  try {
    domainChain = typedDataChainId(typed);
  } catch (e) {
    throw invalid(e instanceof Error ? e.message : 'Invalid chainId');
  }
  if (domainChain !== null && domainChain !== network.chainId) {
    throw invalid(`This data is for chain ${domainChain}, the site is on ${network.chainId}`);
  }
  await approve({
    kind: 'typedData',
    origin,
    ...(await siteInfo(sender, origin)),
    ...signing(vault, signer),
    address: toChecksumAddress(signer.address),
    chain: chainOf(network),
    primaryType: typed.primaryType,
    domain: typed.domain,
    message: typed.message,
    permit: PERMIT.test(typed.primaryType),
  });
  await stillSame(origin, signer, vault);
  return withEvmKey(signer.source.walletId, signer.source.index, signer.address, (key) =>
    signTypedData(typed, key)
  );
}

/** EIP-3860: the most init code a contract creation may carry. */
const MAX_INIT_CODE = 49_152;

/** 10,000 gwei: above this a site's fee is treated as a mistake, not a fallback. */
const MAX_SITE_FEE = 10_000_000_000_000n;

function siteFeeFields(
  req: Record<string, unknown>
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null {
  const read = (v: unknown) => {
    if (v === undefined || v === null) return null;
    try {
      const n = quantity(v, 'fee');
      return n > 0n && n <= MAX_SITE_FEE ? n : null;
    } catch {
      return null;
    }
  };
  const max = read(req.maxFeePerGas);
  if (max !== null) {
    const tip = read(req.maxPriorityFeePerGas);
    return { maxFeePerGas: max, maxPriorityFeePerGas: tip !== null && tip <= max ? tip : max };
  }
  const price = read(req.gasPrice);
  return price !== null ? { maxFeePerGas: price, maxPriorityFeePerGas: price } : null;
}

async function sendTransaction(
  origin: string,
  sender: chrome.runtime.MessageSender,
  params: unknown[]
): Promise<string> {
  const req = params[0];
  if (!isRecord(req)) throw invalid('Expected a transaction object');
  const { vault, signer } = await signerFor(origin, req.from ?? undefined);
  const network = await siteNetwork(origin);
  if (req.chainId !== undefined && req.chainId !== null) {
    if (quantity(req.chainId, 'chainId') !== BigInt(network.chainId)) {
      throw invalid(`This transaction is for another chain than ${network.name}`);
    }
  }
  const creating = req.to === undefined || req.to === null || req.to === '';
  if (!creating && !isEvmAddress(req.to)) throw invalid('Invalid to address');
  const value = req.value === undefined || req.value === null ? 0n : quantity(req.value, 'value');
  const rawData = req.data ?? req.input ?? '0x';
  if (req.data !== undefined && req.input !== undefined && req.data !== req.input) {
    throw invalid('data and input differ');
  }
  if (typeof rawData !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(rawData)) {
    throw invalid('Invalid data');
  }
  const data = rawData.toLowerCase();
  if (creating && data === '0x') throw invalid('A contract creation needs code');
  if (creating && (data.length - 2) / 2 > MAX_INIT_CODE) {
    throw invalid('The contract code is larger than the network allows');
  }
  const gasGiven = req.gas ?? req.gasLimit;
  let gasLimit: bigint | undefined;
  if (gasGiven !== undefined && gasGiven !== null) {
    gasLimit = quantity(gasGiven, 'gas');
    if (gasLimit < 21_000n || gasLimit > 30_000_000n) throw invalid('Gas limit out of range');
  }

  const from = toChecksumAddress(signer.address);
  const reviewNonce = creating ? await getNonce(network, from) : null;
  const to =
    reviewNonce !== null
      ? contractAddressFor(from, reviewNonce)
      : toChecksumAddress(req.to as string);
  const siteFees = siteFeeFields(req);
  let gas: bigint;
  try {
    gas = gasLimit ?? (await estimateGas(network, { from, to: creating ? null : to, value, data }));
  } catch (e) {
    const why = e instanceof Error ? e.message.replace(/^RPC eth_estimateGas: /, '') : '';
    throw new EvmRpcError(-32603, `This transaction would fail${why ? `: ${why}` : ''}`);
  }
  // The wallet's own live fee first; the fee the site suggested only when the network gives none.
  let fees: EvmFees;
  let feeFromSite = false;
  try {
    fees = await estimateFees(network);
  } catch {
    if (!siteFees) throw new EvmRpcError(-32603, 'Network fee unavailable. Try again.');
    fees = { baseFeePerGas: null, ...siteFees };
    feeFromSite = true;
  }
  const feeWei = gas * fees.maxFeePerGas;
  const prepared = {
    tx: {
      chainId: network.chainId,
      nonce: 0,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      gasLimit: gas,
      to: creating ? null : to,
      value,
      data,
    },
    feeWei,
    totalNative: value + feeWei,
  };
  const call = creating ? null : decodeKnownCall(data);
  const [balance, code, meta] = await Promise.all([
    forward(network, 'eth_getBalance', [from, 'latest']).catch((): null => null),
    creating
      ? Promise.resolve(null)
      : forward(network, 'eth_getCode', [to, 'latest']).catch((): null => null),
    call && call.kind !== 'setApprovalForAll'
      ? readErc20Metadata(network, to).catch((): null => null)
      : Promise.resolve(null),
  ]);
  const answer = await approve({
    kind: 'sendTx',
    origin,
    ...(await siteInfo(sender, origin)),
    ...signing(vault, signer),
    from,
    to,
    chain: chainOf(network),
    value: value.toString(),
    data,
    selector: creating ? null : selectorOf(data),
    ...(creating ? { deploy: { codeSize: (data.length - 2) / 2 } } : {}),
    call,
    token:
      meta && meta.symbol && meta.decimals !== null
        ? { symbol: meta.symbol, decimals: meta.decimals }
        : null,
    contract: typeof code === 'string' ? !/^0x0*$/.test(code) : data !== '0x',
    gasLimit: prepared.tx.gasLimit.toString(),
    maxFeePerGas: prepared.tx.maxFeePerGas.toString(),
    feeFromSite,
    fee: prepared.feeWei.toString(),
    total: prepared.totalNative.toString(),
    balance:
      typeof balance === 'string' && /^0x[0-9a-fA-F]+$/.test(balance)
        ? BigInt(balance).toString()
        : null,
  });
  await stillSame(origin, signer, vault);
  if ((await siteChainId(origin)) !== network.chainId) {
    throw new EvmRpcError(-32603, 'The site moved to another network. Send it again.');
  }
  let signedData = data;
  if (answer.edit) {
    try {
      signedData = applyApproveEdit(data, answer.edit);
    } catch (e) {
      throw new EvmRpcError(-32603, e instanceof Error ? e.message : 'Invalid approval amount');
    }
  }
  try {
    const nonce = await getNonce(network, from);
    if (reviewNonce !== null && nonce !== reviewNonce) {
      throw new Error(
        'Another transaction was sent from this address meanwhile. Review the deployment again.'
      );
    }
    return await signAndBroadcast(
      network,
      { ...prepared.tx, nonce, data: signedData },
      { id: signer.source.walletId, evmIndex: signer.source.index, evmAddress: signer.address }
    );
  } catch (e) {
    throw new EvmRpcError(-32603, e instanceof Error ? e.message : 'The transaction was not sent');
  }
}

export async function pickSiteChain(message: {
  origin?: unknown;
  chainId?: unknown;
  walletId?: unknown;
  side?: unknown;
}): Promise<boolean> {
  const { origin, chainId, walletId, side } = message;
  if (!isOrigin(origin) || typeof walletId !== 'string' || !Number.isSafeInteger(chainId)) {
    return false;
  }
  const current = await currentSide();
  if (side !== current) return false;
  if (!(await loadEvmSites())[origin]?.accounts[walletId]) return false;
  const enabled = await allNetworksFor(current === 'testnet' ? 'devnet' : 'mainnet');
  if (!enabled.some((n) => n.chainId === chainId)) return false;
  if ((await siteChainId(origin)) !== chainId) await moveSiteChain(origin, chainId as number);
  return true;
}

export async function connectSiteWallet(message: {
  origin?: unknown;
  walletId?: unknown;
}): Promise<boolean> {
  const { origin, walletId } = message;
  if (!isOrigin(origin) || typeof walletId !== 'string') return false;
  const vault = await evmVault();
  const wallet = vault.status === 'ok' ? vault.evm.get(walletId) : undefined;
  if (vault.status !== 'ok' || !wallet) return false;
  await connectEvmSite(origin, wallet.walletId, wallet.address, vault.open.walletId);
  void pushEvmState([origin]);
  return true;
}

export async function setSiteWallet(message: {
  origin?: unknown;
  walletId?: unknown;
}): Promise<boolean> {
  const { origin, walletId } = message;
  if (!isOrigin(origin) || typeof walletId !== 'string') return false;
  const vault = await evmVault();
  if (vault.status !== 'ok') return false;
  const site = (await loadEvmSites())[origin];
  const account = site?.accounts[walletId];
  if (!account || vault.evm.get(walletId)?.address.toLowerCase() !== account.address.toLowerCase())
    return false;
  if (!(await setEvmSiteWallet(origin, walletId, vault.open.walletId))) return false;
  void pushEvmState([origin]);
  return true;
}

async function dispatch(
  method: string,
  params: unknown,
  origin: string,
  sender: chrome.runtime.MessageSender
): Promise<unknown> {
  const list = paramList(params);
  switch (method) {
    case 'eth_chainId':
      return toHexChain(await siteChainId(origin));
    case 'net_version':
      return String(await siteChainId(origin));
    case 'eth_accounts':
      return accountsFor(origin, await loadEvmSites(), await evmVault());
    case 'eth_coinbase':
      return accountsFor(origin, await loadEvmSites(), await evmVault())[0] ?? null;
    case 'wallet_getProviderState': {
      const vault = await evmVault();
      const sites = await loadEvmSites();
      const chainId = await siteChainId(origin, sites);
      return {
        chainId: toHexChain(chainId),
        networkVersion: String(chainId),
        accounts: accountsFor(origin, sites, vault),
        isUnlocked: !Object.keys(sites[origin]?.accounts ?? {}).length || vault.status !== 'locked',
      };
    }
    case 'web3_clientVersion':
      return `0xio/${chrome.runtime.getManifest().version}`;
    case 'web3_sha3': {
      const data = list[0];
      if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) {
        throw invalid('Expected 0x hex data');
      }
      return '0x' + bytesToHex(keccak_256(hexToBytes(data.slice(2))));
    }
    case 'net_listening':
      return true;
    case 'wallet_getCapabilities': {
      const accounts = accountsFor(origin, await loadEvmSites(), await evmVault());
      const address = list[0];
      if (
        !accounts.length ||
        (address !== undefined &&
          (typeof address !== 'string' || !accounts.includes(address.toLowerCase())))
      ) {
        throw unauthorized('This address is not connected to this site.');
      }
      return {};
    }
    case 'eth_requestAccounts':
      return connectOnce(origin, sender, false);
    case 'wallet_requestPermissions': {
      const asked = list[0];
      if (!isRecord(asked) || Object.keys(asked).some((k) => k !== 'eth_accounts')) {
        throw invalid('Only the eth_accounts permission is supported');
      }
      return permissionsOf(origin, await connectOnce(origin, sender, true));
    }
    case 'wallet_getPermissions':
      return permissionsOf(origin, accountsFor(origin, await loadEvmSites(), await evmVault()));
    case 'wallet_revokePermissions':
      await disconnectEvmSite(origin);
      void pushEvmState([origin]);
      return null;
    case 'wallet_switchEthereumChain': {
      const target = await findNetwork(parseChainId(isRecord(list[0]) ? list[0].chainId : null));
      if (!target) {
        throw new EvmRpcError(
          4902,
          'Unrecognized chain. Add it with wallet_addEthereumChain first.'
        );
      }
      return joined(`${origin}\nswitch\n${target.chainId}`, () =>
        switchChain(origin, sender, target)
      );
    }
    case 'wallet_addEthereumChain':
      return joined(`${origin}\nadd\n${JSON.stringify(list[0] ?? null)}`, () =>
        addChain(origin, sender, list)
      );
    case 'wallet_watchAsset':
      return watchAsset(origin, sender, params);
    case 'personal_sign':
      return personalSign(origin, sender, list);
    case 'eth_signTypedData_v4':
    case 'eth_signTypedData_v3':
      return signTyped(origin, sender, list);
    case 'eth_sendTransaction':
      return sendTransaction(origin, sender, list);
  }
  if (REFUSED[method]) throw new EvmRpcError(4200, REFUSED[method]);
  if (EVM_READ_METHODS.has(method)) {
    if (params !== undefined && params !== null && !Array.isArray(params)) {
      throw invalid('params must be a list');
    }
    return forward(await siteNetwork(origin), method, list);
  }
  throw new EvmRpcError(4200, `The method ${method} is not supported.`);
}

export async function handleEvmRequest(
  message: { method?: unknown; params?: unknown },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
): Promise<void> {
  const method = message.method as string;
  try {
    const origin = originOf(sender);
    if (!origin) throw unauthorized('Requests must come from a web page.');
    if (!LOCAL_METHODS.has(method) && !takeEvmBudget(origin)) {
      throw new EvmRpcError(-32005, 'Too many requests from this site. Retry shortly.');
    }
    void markEvmOrigin(origin, sender.tab?.id, sender.frameId);
    const result = await dispatch(method, message.params, origin, sender);
    sendResponse({ success: true, data: result === undefined ? null : result });
  } catch (e) {
    if (e instanceof EvmRpcError) {
      sendResponse({
        success: false,
        error: {
          code: e.code,
          message: e.message,
          ...(e.data !== undefined ? { data: e.data } : {}),
        },
      });
      return;
    }
    logger.warn(`[EVM] ${method} failed`, e);
    sendResponse({
      success: false,
      error: { code: -32603, message: e instanceof Error ? e.message : 'Internal error' },
    });
  }
}
