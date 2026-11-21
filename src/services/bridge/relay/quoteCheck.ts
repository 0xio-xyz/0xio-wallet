/**
 * Checks a Relay quote before the wallet signs it, so a tampered or wrong quote (from the 0xio proxy or anywhere
 * in between) cannot move funds anywhere but where the user confirmed. Relay's own chain list is the reference
 * for depositories, routers and solvers; nothing from the quote vouches for itself.
 *
 * Port of 0xio-bridge src/services/quoteCheck.ts without ethers; keep the two in step.
 */

import {
  abiFunction,
  decodeAbi,
  encodeCall,
  hexBytes,
  parseCall,
  parseParams,
  type AbiResult,
} from './abiDecode';
import { hashStruct } from './eip712';

export interface AnyToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logo: string | null;
  verified?: boolean;
}

export interface RelayTxData {
  to: string;
  data: string;
  value?: string;
  chainId: number;
  gas?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

export interface RelayItem {
  status?: string;
  data?: RelayTxData;
}

export interface RelayStep {
  id: string;
  kind: string;
  action?: string;
  requestId?: string;
  items?: RelayItem[];
}

export interface RelayCurrency {
  chainId?: number;
  address?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  metadata?: { logoURI?: string };
}

export interface RelayAmount {
  amount?: string;
  amountUsd?: string;
  currency?: RelayCurrency;
}

export interface RelayRouteLeg {
  inputCurrency?: RelayAmount;
  outputCurrency?: RelayAmount;
  router?: string;
}

export interface RelayQuote {
  steps?: RelayStep[];
  details?: {
    currencyIn?: RelayAmount;
    currencyOut?: RelayAmount;
    timeEstimate?: number;
    rate?: number | string;
    totalImpact?: { usd?: string; percent?: string };
    route?: { origin?: RelayRouteLeg; destination?: RelayRouteLeg };
  };
  fees?: Record<string, RelayAmount | undefined>;
  protocol?: { v2?: { orderId?: string; orderData?: RelayOrderData } };
}

export interface RelayChainInfo {
  id: number;
  evm: boolean;
  protocolChainId: string | null;
  depository: string | null;
  erc20Router: string | null;
  approvalProxy: string | null;
  solvers: string[];
}

export interface RelayOrderData {
  version: string;
  solverChainId: string;
  solver: string;
  salt: string;
  inputs: Array<{
    payment: { chainId: string; currency: string; amount: string; weight: string };
    refunds: Array<{
      chainId: string;
      recipient: string;
      currency: string;
      minimumAmount: string;
      deadline: number;
      extraData: string;
    }>;
  }>;
  output: {
    chainId: string;
    payments: Array<{
      recipient: string;
      currency: string;
      minimumAmount: string;
      expectedAmount: string;
    }>;
    deadline: number;
    calls: string[];
    extraData: string;
  };
  fees?: Array<{
    recipientChainId: string;
    recipient: string;
    currencyChainId: string;
    currency: string;
    amount: string;
  }>;
}

export interface QuoteCheckInput {
  quote: RelayQuote;
  outRaw: string;
  user: string;
  octraRecipient: string;
  chainId: number;
  token: AnyToken;
  maxPayRaw: string;
  woct: string;
  octraBridge: string;
  nowSec?: number;
}

export class QuoteCheckError extends Error {}

interface RelayChainRaw {
  id?: number;
  vmType?: string;
  protocol?: { v2?: { chainId?: string; depository?: string } };
  contracts?: { erc20Router?: string; approvalProxy?: string };
  solverAddresses?: unknown[];
}

const ETHEREUM = 1;
const NATIVE = '0x0000000000000000000000000000000000000000';
const CALLS = '(address target, bool allowFailure, uint256 value, bytes callData)[] calls';

const routerAbi = [
  abiFunction(`multicall(${CALLS}, address refundTo, address nftRecipient, bytes metadata)`),
  abiFunction(
    `transferAndMulticall(address[] tokens, uint256[] amounts, ${CALLS}, address refundTo, address nftRecipient, bytes metadata)`
  ),
  abiFunction(
    'cleanupErc20s(address[] tokens, address[] recipients, uint256[] amounts, bytes metadata)'
  ),
  abiFunction('cleanupNative(uint256 amount, address recipient, bytes metadata)'),
];
const depositoryAbi = [
  abiFunction('depositNative(address depositor, bytes32 id)'),
  abiFunction('depositErc20(address depositor, address token, uint256 amount, bytes32 id)'),
];
const transferFn = abiFunction('transfer(address to, uint256 amount)');
const transferFromFn = abiFunction('transferFrom(address from, address to, uint256 amount)');
const erc20Abi = [
  abiFunction('approve(address spender, uint256 amount)'),
  transferFn,
  transferFromFn,
];
const burnFn = abiFunction('burnToOctra(string octraRecipient, uint256 amount)');
const orderCallParams = parseParams('(address), (bytes), (uint256)');

// Relay settlement SDK ORDER_EIP712_TYPES; the order id is hashStruct over them.
const ORDER_TYPES = {
  Order: [
    { name: 'version', type: 'string' },
    { name: 'solverChainId', type: 'string' },
    { name: 'solver', type: 'address' },
    { name: 'salt', type: 'uint256' },
    { name: 'inputs', type: 'Input[]' },
    { name: 'output', type: 'Output' },
    { name: 'fees', type: 'Fee[]' },
  ],
  Input: [
    { name: 'payment', type: 'InputPayment' },
    { name: 'refunds', type: 'InputRefund[]' },
  ],
  InputPayment: [
    { name: 'chainId', type: 'string' },
    { name: 'currency', type: 'bytes' },
    { name: 'amount', type: 'uint256' },
    { name: 'weight', type: 'uint256' },
  ],
  InputRefund: [
    { name: 'chainId', type: 'string' },
    { name: 'recipient', type: 'bytes' },
    { name: 'currency', type: 'bytes' },
    { name: 'minimumAmount', type: 'uint256' },
    { name: 'deadline', type: 'uint32' },
    { name: 'extraData', type: 'bytes' },
  ],
  Output: [
    { name: 'chainId', type: 'string' },
    { name: 'payments', type: 'OutputPayment[]' },
    { name: 'deadline', type: 'uint32' },
    { name: 'calls', type: 'bytes[]' },
    { name: 'extraData', type: 'bytes' },
  ],
  OutputPayment: [
    { name: 'recipient', type: 'bytes' },
    { name: 'currency', type: 'bytes' },
    { name: 'minimumAmount', type: 'uint256' },
    { name: 'expectedAmount', type: 'uint256' },
  ],
  Fee: [
    { name: 'recipientChainId', type: 'string' },
    { name: 'recipient', type: 'bytes' },
    { name: 'currencyChainId', type: 'string' },
    { name: 'currency', type: 'bytes' },
    { name: 'amount', type: 'uint256' },
  ],
};

const lower = (value: unknown) => String(value ?? '').toLowerCase();
const same = (a: unknown, b: unknown) => lower(a) === lower(b);

function fail(reason: string): never {
  throw new QuoteCheckError(reason);
}

function bigint(value: unknown, what: string): bigint {
  try {
    return BigInt(value as string);
  } catch {
    return fail(`unreadable ${what}`);
  }
}

export function parseRelayChains(list: unknown): Map<number, RelayChainInfo> {
  const chains = new Map<number, RelayChainInfo>();
  if (!Array.isArray(list)) return chains;
  for (const raw of list as RelayChainRaw[]) {
    if (!raw || typeof raw.id !== 'number') continue;
    chains.set(raw.id, {
      id: raw.id,
      evm: raw.vmType === 'evm',
      protocolChainId: raw.protocol?.v2?.chainId ?? null,
      depository: raw.protocol?.v2?.depository ?? null,
      erc20Router: raw.contracts?.erc20Router ?? null,
      approvalProxy: raw.contracts?.approvalProxy ?? null,
      solvers: Array.isArray(raw.solverAddresses)
        ? raw.solverAddresses.filter((s): s is string => typeof s === 'string')
        : [],
    });
  }
  return chains;
}

export function relayOrderId(order: RelayOrderData): string {
  return hashStruct('Order', ORDER_TYPES, {
    version: order.version,
    solverChainId: order.solverChainId,
    solver: order.solver,
    salt: order.salt,
    inputs: order.inputs.map((input) => ({
      payment: { ...input.payment, currency: lower(input.payment.currency) },
      refunds: input.refunds.map((r) => ({
        ...r,
        recipient: lower(r.recipient),
        currency: lower(r.currency),
        extraData: lower(r.extraData),
      })),
    })),
    output: {
      chainId: order.output.chainId,
      payments: order.output.payments.map((p) => ({
        ...p,
        recipient: lower(p.recipient),
        currency: lower(p.currency),
      })),
      deadline: order.output.deadline,
      calls: order.output.calls.map(lower),
      extraData: lower(order.output.extraData),
    },
    fees: (order.fees ?? []).map((f) => ({
      ...f,
      recipient: lower(f.recipient),
      currency: lower(f.currency),
    })),
  });
}

interface TxData {
  to: string;
  data: string;
  value?: string;
  chainId: number;
}

export function verifyQuote(input: QuoteCheckInput, chains: Map<number, RelayChainInfo>): void {
  const { quote, user, octraRecipient, chainId, token, woct, octraBridge } = input;
  const outRaw = bigint(input.outRaw, 'amount');
  const maxPay = bigint(input.maxPayRaw, 'amount');
  if (outRaw <= 0n) fail('nothing to burn');
  const source = chains.get(chainId);
  const ethereum = chains.get(ETHEREUM);
  if (!source?.evm || !ethereum?.erc20Router) fail('Relay does not list this chain');
  const burnData = encodeCall(burnFn, [octraRecipient, outRaw]);

  const payments: TxData[] = [];
  for (const step of quote.steps ?? []) {
    if (step.kind !== 'transaction') fail(`unsupported ${step.id} step`);
    for (const item of step.items ?? []) {
      if (!item.data) fail('empty transaction');
      if (item.data.chainId !== chainId) fail('a transaction on another chain');
      if (step.id === 'approve') checkApproval(item.data, token, source, maxPay);
      else payments.push(item.data);
    }
  }
  if (payments.length !== 1) fail('not exactly one payment transaction');

  const v2 = quote.protocol?.v2;
  if (v2) {
    checkOrder({
      ...input,
      orderId: v2.orderId,
      order: v2.orderData,
      tx: payments[0],
      source,
      ethereum,
      chains,
      outRaw,
      maxPay,
      burnData,
    });
  } else if (chainId === ETHEREUM) {
    checkSameChain({ tx: payments[0], ethereum, user, token, woct, octraBridge, maxPay, burnData });
  } else fail('the order data is missing');
}

function checkApproval(tx: TxData, token: AnyToken, source: RelayChainInfo, maxPay: bigint) {
  if (same(token.address, NATIVE) || !same(tx.to, token.address)) {
    fail('an approval for another token');
  }
  const parsed = parseCall(erc20Abi, tx.data);
  if (parsed?.name !== 'approve') fail('an unexpected token call');
  const spender = lower(parsed.args.spender);
  if (spender !== lower(source.depository) && spender !== lower(source.approvalProxy)) {
    fail("an approval for a contract that is not Relay's");
  }
  if (bigint(parsed.args.amount, 'approval') > maxPay) fail('an approval above what you entered');
  if (bigint(tx.value ?? '0', 'value') !== 0n) fail('an approval that sends coins');
}

function checkOrder(ctx: {
  orderId?: string;
  order?: RelayOrderData;
  tx: TxData;
  source: RelayChainInfo;
  ethereum: RelayChainInfo;
  chains: Map<number, RelayChainInfo>;
  outRaw: bigint;
  maxPay: bigint;
  burnData: string;
  user: string;
  token: AnyToken;
  woct: string;
  octraBridge: string;
  nowSec?: number;
}) {
  const { orderId, order, tx, source, ethereum, outRaw, maxPay, burnData } = ctx;
  const { user, token, woct, octraBridge } = ctx;
  if (!order || !orderId) fail('the order data is missing');

  const evmChains = new Set(
    [...ctx.chains.values()].filter((c) => c.evm && c.protocolChainId).map((c) => c.protocolChainId)
  );
  const orderChains = [
    order.output.chainId,
    ...order.inputs.flatMap((i) => [i.payment.chainId, ...i.refunds.map((r) => r.chainId)]),
    ...(order.fees ?? []).flatMap((f) => [f.recipientChainId, f.currencyChainId]),
  ];
  if (orderChains.some((c) => !evmChains.has(c))) {
    fail('the order involves a chain the bridge cannot check');
  }
  if (!same(relayOrderId(order), orderId)) fail('the order id does not match the order');

  const now = ctx.nowSec ?? Math.floor(Date.now() / 1000);
  if (order.output.chainId !== ethereum.protocolChainId)
    fail('the order does not pay out on Ethereum');
  if (order.output.deadline <= now) fail('the order has expired');
  if (order.output.payments.length !== 1) fail('the order pays out more than once');
  const [payout] = order.output.payments;
  if (
    !same(payout.currency, woct) ||
    !same(payout.recipient, ethereum.erc20Router) ||
    bigint(payout.minimumAmount, 'payout') !== outRaw
  ) {
    fail("the payout is not the shown wOCT to Relay's router");
  }
  if (order.output.calls.length !== 1) fail('the order makes more than the burn call');
  let call: AbiResult;
  try {
    call = decodeAbi(orderCallParams, hexBytes(order.output.calls[0]));
  } catch {
    return fail('an unreadable order call');
  }
  const [[callTo], [callData], [callValue]] = call;
  if (!same(callTo, octraBridge) || callValue !== 0n || !same(callData, burnData)) {
    fail('the burn does not go to your Octra address');
  }

  if (order.inputs.length !== 1) fail('the order takes more than one payment');
  const [{ payment, refunds }] = order.inputs;
  if (payment.chainId !== source.protocolChainId || !same(payment.currency, token.address)) {
    fail('the order takes another token or chain');
  }
  const amount = bigint(payment.amount, 'payment');
  if (amount <= 0n || amount > maxPay) fail('the order takes more than you entered');
  if (refunds.length === 0 || refunds.some((r) => !same(r.recipient, user))) {
    fail('refunds go to another address');
  }

  if (!source.depository || !same(tx.to, source.depository)) {
    fail("the payment does not go to Relay's depository");
  }
  const value = bigint(tx.value ?? '0', 'value');
  const deposit = parseCall(depositoryAbi, tx.data);
  if (!deposit) fail('an unknown deposit call');
  const { args } = deposit;
  if (!same(args[args.length - 1], orderId) || !same(args.depositor, user)) {
    fail('the deposit is not tied to this order');
  }
  if (same(token.address, NATIVE)) {
    if (deposit.name !== 'depositNative' || value !== amount) {
      fail('the deposit amount differs from the order');
    }
  } else if (
    deposit.name !== 'depositErc20' ||
    !same(args.token, token.address) ||
    args.amount !== amount ||
    value !== 0n
  ) {
    fail('the deposit amount differs from the order');
  }
}

function checkSameChain(ctx: {
  tx: TxData;
  ethereum: RelayChainInfo;
  user: string;
  token: AnyToken;
  woct: string;
  octraBridge: string;
  maxPay: bigint;
  burnData: string;
}) {
  const { tx, ethereum, user, token, woct, octraBridge, maxPay, burnData } = ctx;
  const native = same(token.address, NATIVE);
  const value = bigint(tx.value ?? '0', 'value');
  let calls: AbiResult;

  if (same(tx.to, ethereum.erc20Router)) {
    const parsed = parseCall(routerAbi, tx.data);
    if (parsed?.name !== 'multicall' || !native) fail("an unexpected call to Relay's router");
    if (value <= 0n || value > maxPay) fail('the transaction pays more than you entered');
    // A zero refundTo refunds the sender, which is the user.
    if (!same(parsed.args.refundTo, NATIVE) && !same(parsed.args.refundTo, user)) {
      fail('refunds go to another address');
    }
    calls = parsed.args.calls;
  } else if (same(tx.to, ethereum.approvalProxy)) {
    const parsed = parseCall(routerAbi, tx.data);
    if (parsed?.name !== 'transferAndMulticall' || native || value !== 0n) {
      fail("an unexpected call to Relay's approval proxy");
    }
    const { tokens, amounts } = parsed.args;
    if (tokens.length !== 1 || !same(tokens[0], token.address)) {
      fail('the transaction takes another token');
    }
    const amount = bigint(amounts[0], 'payment');
    if (amount <= 0n || amount > maxPay) fail('the transaction takes more than you entered');
    if (!same(parsed.args.refundTo, user)) fail('refunds go to another address');
    calls = parsed.args.calls;
  } else {
    return fail("the payment does not go to Relay's router");
  }

  // Leftovers may go to the user; Relay's solvers take their fee in the input token or native coin, never wOCT.
  const payees = new Set([lower(user), ...ethereum.solvers.map(lower)]);
  let burns = 0;
  for (const call of calls) {
    // Every call must succeed, so a failing burn reverts the whole transaction instead of keeping the funds.
    if (call.allowFailure) fail('a call is allowed to fail');
    const target = lower(call.target);
    const callData = lower(call.callData);
    if (target === lower(octraBridge)) {
      if (call.value !== 0n || callData !== lower(burnData)) {
        fail('the burn does not go to your Octra address');
      }
      burns++;
    } else if (target === lower(ethereum.erc20Router)) {
      const inner = parseCall(routerAbi, callData);
      if (inner?.name === 'cleanupNative') {
        if (!payees.has(lower(inner.args.recipient))) fail('leftovers go to another address');
      } else if (inner?.name === 'cleanupErc20s') {
        const { tokens, recipients } = inner.args;
        for (let i = 0; i < tokens.length; i++) {
          const to = lower(recipients[i]);
          if (same(tokens[i], woct) ? to !== lower(user) : !payees.has(to)) {
            fail('leftovers go to another address');
          }
        }
      } else {
        fail("an unexpected call to Relay's router");
      }
    } else if (target === lower(woct) || target === lower(ethereum.approvalProxy)) {
      fail('an unexpected wOCT movement');
    } else if (callData.startsWith(transferFromFn.selector)) {
      fail('an unexpected token transfer');
    } else if (callData.startsWith(transferFn.selector)) {
      const inner = parseCall(erc20Abi, callData);
      if (!inner || !payees.has(lower(inner.args.to))) fail('an unexpected token transfer');
    }
  }
  if (burns !== 1) fail('the transaction does not burn exactly once to your Octra address');
}
