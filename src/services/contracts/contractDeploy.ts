import { logger } from 'src/utils/logger';
import { DEPLOY_MAX_OU, deployBaseOu } from 'src/utils/octra/deployTx';
import { FEE_CHANGED, FEE_UNAVAILABLE, feeFloor } from 'src/utils/octra/dappTx';
import { networkService } from '../network/NetworkService';
import { isSubmitVerdict } from '../network/txOutcome';
import { localTxHash } from 'src/utils/octra/txHash';
import {
  TxScopeError,
  assertTxScope,
  isTxScope,
  type NetworkPin,
  type TxScope,
} from '../network/txScope';

export interface DeployPreview {
  nonce: number;
  contractAddress: string;
}

export interface DeployResult {
  txHash: string;
  contractAddress: string;
  outcomeUnknown?: boolean;
}

export class DeployChangedError extends Error {
  readonly code = 'DEPLOY_CHANGED';
  constructor(message: string) {
    super(message);
    this.name = 'DeployChangedError';
  }
}

/** Never below webcli's size-based base; null when the node gave no quote. */
export async function liveDeployFee(
  bytecodeB64: string,
  at: NetworkPin
): Promise<{ floor: bigint; recommended: bigint } | null> {
  const quote = await networkService.getRecommendedFeeStrict('deploy', at);
  const floor = quote ? feeFloor(quote) : null;
  if (!quote || floor == null) return null;
  const base = deployBaseOu(bytecodeB64.length);
  const priced = (ou: bigint) => (ou < base ? base : ou > DEPLOY_MAX_OU ? DEPLOY_MAX_OU : ou);
  return { floor: priced(floor), recommended: priced(BigInt(quote.recommended)) };
}

export async function liveDeployOu(
  bytecodeB64: string,
  at: NetworkPin,
  requested: bigint | null = null
): Promise<bigint | null> {
  const fee = await liveDeployFee(bytecodeB64, at);
  if (!fee) return null;
  return requested != null && requested >= fee.floor ? requested : fee.recommended;
}

export async function deployFeeError(
  bytecodeB64: string,
  reviewedOu: bigint,
  at: NetworkPin
): Promise<string | null> {
  const fee = await liveDeployFee(bytecodeB64, at);
  if (!fee) return FEE_UNAVAILABLE;
  return reviewedOu >= fee.floor ? null : FEE_CHANGED;
}

/** Nothing is reserved: the submit re-reads the nonce and refuses when the address moved. */
export async function previewDeploy(bytecodeB64: string, scope: TxScope): Promise<DeployPreview> {
  const nonce = await networkService.getNextNonce(scope.address, scope);
  networkService.releaseNonce(scope.address, nonce, scope.networkId);
  const contractAddress = await networkService.predictContractAddress(
    bytecodeB64,
    scope.address,
    nonce,
    scope
  );
  return { nonce, contractAddress };
}

export async function submitDeploy(params: {
  scope: TxScope;
  privateKey: string;
  publicKey?: string;
  bytecodeB64: string;
  constructorParams: string;
  ou: bigint;
  reviewed: DeployPreview;
}): Promise<DeployResult> {
  const { scope, reviewed } = params;
  if (!isTxScope(scope)) throw new Error('This transaction has no network attached');
  await assertTxScope(scope);
  const from = scope.address;

  const nonce = await networkService.getNextNonce(from, scope);
  let contractAddress = reviewed.contractAddress;
  if (nonce !== reviewed.nonce) {
    try {
      contractAddress = await networkService.predictContractAddress(
        params.bytecodeB64,
        from,
        nonce,
        scope
      );
    } catch (e) {
      networkService.releaseNonce(from, nonce, scope.networkId);
      throw e;
    }
    if (contractAddress !== reviewed.contractAddress) {
      networkService.releaseNonce(from, nonce, scope.networkId);
      throw new DeployChangedError(
        'Another transaction from this wallet went out during the review, so the contract address changed. Nothing was sent. Deploy again.'
      );
    }
  }

  const signedTx = await networkService.buildDeployTransaction({
    from,
    bytecodeB64: params.bytecodeB64,
    constructorParams: params.constructorParams || undefined,
    nonce,
    ou: params.ou.toString(),
    toAddress: contractAddress,
    privateKey: params.privateKey,
    publicKey: params.publicKey,
  });

  const pendingTx = await networkService.storePendingTransaction({
    from,
    to: contractAddress,
    amount: 0,
    nonce,
    message: '',
    timestamp: Date.now(),
    type: 'outgoing',
    opType: 'deploy',
    confirmed: false,
    pending: true,
    network: scope.networkId,
  });
  const dropPending = async () => {
    if (pendingTx) await networkService.removePendingTransaction(pendingTx.txId);
  };

  let result: any;
  try {
    result = await networkService.jsonRpcCall('octra_submit', [signedTx], undefined, scope);
  } catch (err) {
    if (err instanceof TxScopeError) {
      await dropPending();
      networkService.releaseNonce(from, nonce, scope.networkId);
      throw err;
    }
    const local = localTxHash(signedTx);
    if (!isSubmitVerdict(err) && local) {
      logger.warn(`[deploy] no verdict from the node; tracking ${local.slice(0, 16)}…`);
      return { txHash: local, contractAddress, outcomeUnknown: true };
    }
    await dropPending();
    networkService.releaseNonce(from, nonce, scope.networkId);
    throw err;
  }

  const txHash: string | undefined = result?.tx_hash || result?.hash;
  if (txHash) {
    if (pendingTx) {
      await networkService.updatePendingTransaction(txHash, {
        txId: pendingTx.txId,
        hash: txHash,
        status: 'success',
      });
    }
    logger.info(`[deploy] ${contractAddress.slice(0, 12)}… tx ${txHash.slice(0, 16)}…`);
    return { txHash, contractAddress };
  }
  if (result?.status === 'rejected') {
    await dropPending();
    networkService.releaseNonce(from, nonce, scope.networkId);
    throw new Error(result.error?.reason || result.error?.message || 'Deploy rejected');
  }
  const local = localTxHash(signedTx);
  if (local) return { txHash: local, contractAddress, outcomeUnknown: true };
  await dropPending();
  throw new Error('Deploy failed. The node returned no transaction hash.');
}
