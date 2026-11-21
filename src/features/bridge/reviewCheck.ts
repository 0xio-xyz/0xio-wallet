import { burnToOctraData } from 'src/services/bridge/abi';
import {
  cachedBridgeHealth,
  cachedLockFee,
  ethereumMainnet,
  wOctAllowance,
} from 'src/services/bridge/bridge';
import { BRIDGE } from 'src/services/bridge/constants';
import type { BridgeDirection } from 'src/services/bridge/transfers';
import type { FeeChoice } from 'src/services/evm/feeChoice';
import type { PreparedTransfer } from 'src/services/evm/send';
import { prepareCall } from 'src/services/evm/signer';
import { erc20ApproveData } from 'src/services/evm/tx';

export type BridgeAction = 'lock' | 'approve' | 'burn' | 'claim';

export interface BridgePending {
  action: BridgeAction;
  transferId?: string;
  step?: 1 | 2;
  prepared?: PreparedTransfer;
  fee?: FeeChoice;
  ouRaw?: bigint;
  feeRaised?: boolean;
  amountRaw: bigint;
  recipient: string;
}

export type ReviewCheck =
  | { pending: BridgePending }
  | { problem: 'paused' | 'noEth' | 'noOct' | 'feeUnavailable' }
  | { problem: 'cap'; maxRaw: bigint };

const ahead = <T>(p: Promise<T>): Promise<T> => {
  p.catch(() => {});
  return p;
};

export async function checkNewTransfer(args: {
  direction: BridgeDirection;
  amountRaw: bigint;
  recipient: string;
  evmAddress?: string | null;
  ethRaw: bigint;
  octRaw: bigint;
}): Promise<ReviewCheck> {
  const { direction, amountRaw, recipient, evmAddress, ethRaw, octRaw } = args;
  const health = ahead(cachedBridgeHealth());

  if (direction === 'o2e') {
    const fee = ahead(cachedLockFee());
    const h = await health;
    if (h.ethPaused || h.octraPaused) return { problem: 'paused' };
    if (amountRaw > h.mintCapPerTx || amountRaw > h.mintLeftToday) {
      const maxRaw = h.mintCapPerTx < h.mintLeftToday ? h.mintCapPerTx : h.mintLeftToday;
      return { problem: 'cap', maxRaw };
    }
    const ou = await fee;
    if (!ou) return { problem: 'feeUnavailable' };
    if (amountRaw + ou.recommended > octRaw) return { problem: 'noOct' };
    return { pending: { action: 'lock', amountRaw, recipient, ouRaw: ou.recommended } };
  }

  if (!evmAddress) throw new Error('No Ethereum address');
  const net = ahead(ethereumMainnet());
  const allowance = ahead(wOctAllowance(evmAddress));
  const burn = ahead(
    net.then((n) =>
      prepareCall(n, {
        from: evmAddress,
        to: BRIDGE.ethBridge,
        data: burnToOctraData(recipient, amountRaw),
      })
    )
  );

  const h = await health;
  if (h.ethPaused || h.octraPaused) return { problem: 'paused' };
  const action = (await allowance) < amountRaw ? 'approve' : 'burn';
  const prepared =
    action === 'approve'
      ? await prepareCall(await net, {
          from: evmAddress,
          to: BRIDGE.wOCT,
          data: erc20ApproveData(BRIDGE.ethBridge, amountRaw),
        })
      : await burn;
  if (prepared.totalNative > ethRaw) return { problem: 'noEth' };
  return {
    pending: {
      action,
      prepared,
      amountRaw,
      recipient,
      ...(action === 'approve' ? { step: 1 } : {}),
    },
  };
}
