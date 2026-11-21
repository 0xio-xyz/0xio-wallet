import type { KnownCall } from './calldata';

export interface EvmApprovalChain {
  chainId: number;
  name: string;
  nativeSymbol: string;
  testnet: boolean;
  logoChainId?: number;
}

export interface EvmReviewWallet {
  walletId: string;
  name: string;
  address: string;
  octra: string;
}

interface Signing {
  signer: EvmReviewWallet;
  openWallet: { walletId: string; name: string; octra: string } | null;
}

interface Base {
  origin: string;
  title?: string;
  favicon?: string;
}

export type EvmApprovalData =
  | (Base & {
      kind: 'connect';
      chain: EvmApprovalChain;
      open: { walletId: string; name: string; octra: string; address: string | null };
      wallets: EvmReviewWallet[];
      preselect: string | null;
    })
  | (Base & { kind: 'switchChain'; from: EvmApprovalChain; to: EvmApprovalChain })
  | (Base & {
      kind: 'switchSide';
      from: EvmApprovalChain;
      to: EvmApprovalChain;
      side: 'mainnet' | 'testnet';
    })
  | (Base & {
      kind: 'addChain';
      chainId: number;
      name: string;
      rpcUrl: string;
      symbol: string;
      explorerUrl: string | null;
    })
  | (Base & {
      kind: 'watchAsset';
      chain: EvmApprovalChain;
      address: string;
      symbol: string;
      name: string;
      decimals: number;
    })
  | (Base &
      Signing & {
        kind: 'personalSign';
        address: string;
        chain: EvmApprovalChain;
        text: string | null;
        hex: string;
      })
  | (Base &
      Signing & {
        kind: 'typedData';
        address: string;
        chain: EvmApprovalChain;
        primaryType: string;
        domain: Record<string, unknown>;
        message: Record<string, unknown>;
        permit: boolean;
      })
  | (Base &
      Signing & {
        kind: 'sendTx';
        from: string;
        to: string;
        deploy?: { codeSize: number };
        chain: EvmApprovalChain;
        value: string;
        data: string;
        selector: string | null;
        call: KnownCall | null;
        token: { symbol: string; decimals: number } | null;
        contract: boolean;
        gasLimit: string;
        maxFeePerGas: string;
        feeFromSite?: boolean;
        fee: string;
        total: string;
        balance: string | null;
      });

export type EvmApprovalWithId = EvmApprovalData & { approvalId: string };
