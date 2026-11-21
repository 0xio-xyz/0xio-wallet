import { OXIO_ICON } from './evmIcon';

// MAIN world at document_start. Requests go through the private port; SDK answers on
// window.postMessage carry the session nonce so a page cannot forge them.

interface DeclareIntegrationOptions {
  name?: string;
  description?: string;
  version?: string;
}

interface WalletEventData {
  type: string;
  data: {
    address?: string | null;
    balance?: number | null;
    [key: string]: unknown;
  };
}

type EventCallback = (data: unknown) => void;

declare global {
  interface Window {
    wallet0xio: object;
    ZeroXIOWallet: object;
    wallet: object;
    octra: object;
    octraProviders: object[];
  }
}

class EvmProviderError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ProviderRpcError';
    this.code = code;
    this.data = data;
  }
}

class OctraProviderError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'OctraProviderError';
    this.code = code;
    this.data = data;
  }
}

(function () {
  'use strict';

  if (window.wallet0xio) return;

  const _evmPending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  let _port: MessagePort | null = null;
  let _sessionNonce: string | null = null;

  const _pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const _sdkPending = new Map<string, string>();

  let _sdkConnected = false;

  const _sdkRids = new Set<string>();
  const RID_LIMIT = 64;
  const FINAL_STATUSES = new Set(['confirmed', 'completed', 'failed', 'rejected', 'expired']);

  const _eventListeners = new Map<string, EventCallback[]>();

  const LONG_METHODS = new Set([
    'call_contract',
    'callContract',
    'deploy_contract',
    'deployContract',
    'send_transaction',
    'sendTransaction',
    'sign_transaction',
    'signTransaction',
    'broadcast_only',
    'encrypt_balance',
    'decrypt_balance',
    'send_private_transfer',
    'claim_private_transfer',
    'signMessage',
    'connect',
    'prepare_private_account_open',
    'make_range_proof',
    'make_zero_proof',
    'encrypt_value',
    'decrypt_value',
    'get_private_balance',
    'send_contract_transaction_sequence',
    'register_private_view_key',
  ]);

  function _onPortMessage(event: MessageEvent) {
    const { requestId, response, type, eventData } = event.data;

    if (requestId && _evmPending.has(requestId)) {
      _evmSettle(requestId, response);
      return;
    }
    if (type === 'evm_event') {
      _evmApplyState(event.data.evmData, true);
      return;
    }

    if (requestId) {
      if (_sdkPending.has(requestId)) {
        _noteSdkConnection(_sdkPending.get(requestId), response);
        _sdkPending.delete(requestId);
        if (typeof response?.rid === 'string' && FINAL_STATUSES.has(response?.status)) {
          _sdkRids.delete(response.rid);
        }
        window.postMessage(
          {
            source: '0xio-sdk-bridge',
            response: {
              id: requestId,
              success: response?.success,
              data: response?.data,
              error: response?.error,
              ...(typeof response?.rid === 'string'
                ? { rid: response.rid, status: response.status }
                : {}),
              timestamp: Date.now(),
            },
            sessionNonce: _sessionNonce,
          },
          window.location.origin
        );
      } else {
        const req = _pending.get(requestId);
        if (req) {
          _pending.delete(requestId);
          if (response?.success === true) {
            req.resolve(response.data);
          } else {
            const err = response?.error;
            const BACKGROUND_CODE_MAP: Record<string, number> = {
              USER_REJECTED: 4001,
              PERMISSION_DENIED: 4100,
              WATCH_ONLY: 4100,
              NOT_CONNECTED: 4100,
              WALLET_LOCKED: 4100,
              UNAUTHORIZED: 4100,
              NETWORK_ERROR: 4901,
              DISCONNECTED: 4900,
            };
            if (err && typeof err === 'object' && err.code) {
              const rfcCode = BACKGROUND_CODE_MAP[err.code] ?? 4200;
              req.reject(new OctraProviderError(rfcCode, err.message || 'Request failed', err));
            } else {
              req.reject(
                new OctraProviderError(4200, typeof err === 'string' ? err : 'Request failed', err)
              );
            }
          }
        }
      }
    } else if (type === 'event') {
      _handleWalletEvent(eventData);
    }
  }

  // Safe on window.postMessage: both content scripts run before any page script.
  const _portInitListener = (event: MessageEvent) => {
    if (event.data?.source !== '0xio-port-init' || !event.ports?.[0]) return;

    _port = event.ports[0];
    _sessionNonce = event.data.nonce ?? null;
    _port.start();
    _port.onmessage = _onPortMessage;
    window.removeEventListener('message', _portInitListener);

    if (_sessionNonce) {
      window.postMessage(
        { source: '0xio-sdk-nonce-init', nonce: _sessionNonce },
        window.location.origin
      );
    }
  };
  window.addEventListener('message', _portInitListener);

  (window as any).__0xioSdkBridgeLoaded = true;

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || !event.data || !_port) return;
    if (event.data.source !== '0xio-sdk-request' && event.data.type !== '0xio-sdk-request') return;

    const request = event.data.request || event.data;
    const requestId = request.id || event.data.id;
    const method = request.method || event.data.method;
    const params = request.params || event.data.params;
    const rid = request.v === 2 && typeof request.rid === 'string' ? request.rid : null;

    if (!requestId || !method) return;

    if (_sessionNonce) {
      window.postMessage(
        { source: '0xio-sdk-nonce-init', nonce: _sessionNonce },
        window.location.origin
      );
    }

    _sdkPending.set(requestId, String(method));
    if (rid) {
      _sdkRids.delete(rid);
      _sdkRids.add(rid);
      if (_sdkRids.size > RID_LIMIT) _sdkRids.delete(_sdkRids.values().next().value as string);
    }
    _port.postMessage({
      requestId,
      method,
      params,
      ...(rid ? { v: 2, rid, network: request.network } : {}),
    });
  });

  const _octraListeners = new Map<string, Set<(...args: any[]) => void>>();

  function _octraEmit(event: string, ...args: any[]) {
    (_octraListeners.get(event) ?? new Set()).forEach((fn) => {
      try {
        fn(...args);
      } catch {}
    });
  }

  const _canSignOf = (data: unknown): boolean | null => {
    const v = (data as { canSign?: unknown } | null)?.canSign;
    return typeof v === 'boolean' ? v : null;
  };

  function _noteSdkConnection(method: string | undefined, response: any) {
    if (response?.success !== true) return;
    if (method === 'connect' && response.data?.address) _sdkConnected = true;
    else if (method === 'getConnectionStatus')
      _sdkConnected = !!(response.data?.connected ?? response.data?.isConnected);
    else if (method === 'disconnect') _sdkConnected = false;
  }

  const _pageConnected = () => api.isConnected || _sdkConnected;

  // Wallet event handling. A page that is not connected hears nothing but its disconnect and the
  // updates of the requests it sent itself.
  function _handleWalletEvent(eventData: WalletEventData) {
    if (!eventData) return;
    const { type, data } = eventData;
    if (type === 'requestUpdate') {
      const rid = typeof data?.requestId === 'string' ? data.requestId : '';
      const own = _sdkRids.has(rid);
      if (!own && !_pageConnected()) return;
      if (own && FINAL_STATUSES.has(data?.status as string)) _sdkRids.delete(rid);
      _emit(type, data);
      _sdkEmit(type, data);
      return;
    }
    if (type !== 'disconnect' && !_pageConnected()) return;

    switch (type) {
      case 'connect':
        api.isConnected = true;
        api.address = (data.address as string) ?? null;
        api.balance = (data.balance as number) ?? null;
        api.canSign = _canSignOf(data);
        _octraEmit('connect', {
          chainId: (data as any).networkInfo?.id ?? (data as any).networkId ?? 'mainnet',
          canSign: api.canSign,
        });
        _octraEmit('accountsChanged', data.address ? [data.address] : []);
        _octraEmit('permissionsChanged', (data.permissions as string[]) ?? []);
        break;
      case 'disconnect':
        api.isConnected = false;
        _sdkConnected = false;
        api.address = null;
        api.balance = null;
        api.canSign = null;
        _octraEmit('disconnect', { code: 4900, message: 'Disconnected' });
        _octraEmit('accountsChanged', []);
        _octraEmit('permissionsChanged', []);
        break;
      case 'accountChanged':
        api.address = (data.address as string) ?? null;
        api.balance = (data.balance as number) ?? null;
        api.canSign = _canSignOf(data);
        _octraEmit('accountsChanged', data.address ? [data.address] : []);
        _octraEmit('balanceChanged', { balance: data.balance });
        break;
      case 'networkChanged':
        _octraEmit('networkChanged', data);
        break;
      case 'balanceChanged':
        _octraEmit('balanceChanged', data);
        break;
      case 'transactionConfirmed':
      case 'transactionComplete':
        _octraEmit('transactionChanged', data);
        break;
      case 'message':
        _octraEmit('message', data);
        break;
    }
    _emit(type, data);
    _sdkEmit(type, data);
  }

  function _sdkEmit(type: string, data: unknown) {
    window.postMessage(
      {
        source: '0xio-sdk-bridge',
        event: { type, data, timestamp: Date.now() },
        sessionNonce: _sessionNonce,
      },
      window.location.origin
    );
  }

  function _emit(event: string, data: unknown) {
    (_eventListeners.get(event) ?? []).forEach((cb) => {
      try {
        cb(data);
      } catch (err) {
        console.error('[0xio Wallet] Event listener error:', err);
      }
    });
  }

  function _sendMessage(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!_port) {
        reject(new Error('Wallet not ready - extension port not established'));
        return;
      }
      const requestId = crypto.randomUUID();
      const timeout =
        method === 'send_private_transfer' ? 600_000 : LONG_METHODS.has(method) ? 330_000 : 30_000;

      const timer = setTimeout(() => {
        if (_pending.has(requestId)) {
          _pending.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, timeout);

      _pending.set(requestId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      _port!.postMessage({ requestId, method, params });
    });
  }

  const api = {
    isConnected: false as boolean,
    address: null as string | null,
    balance: null as number | null,
    canSign: null as boolean | null,

    async isAvailable(): Promise<boolean> {
      try {
        const result = (await _sendMessage('ping')) as any;
        return result?.available || false;
      } catch {
        return false;
      }
    },

    async connect(): Promise<{
      address: string | null;
      balance: number | null;
      canSign: boolean | null;
    }> {
      const result = (await _sendMessage('connect')) as any;
      api.isConnected = true;
      api.address = result.address;
      api.balance = result.balance;
      api.canSign = _canSignOf(result);
      return { address: api.address, balance: api.balance, canSign: api.canSign };
    },

    async disconnect(): Promise<{ success: boolean }> {
      await _sendMessage('disconnect');
      api.isConnected = false;
      _sdkConnected = false;
      api.address = null;
      api.balance = null;
      api.canSign = null;
      return { success: true };
    },

    async getAddress(): Promise<string | null> {
      if (!api.isConnected) throw new Error('Wallet not connected');
      return api.address;
    },

    async getBalance(): Promise<number | null> {
      const result = (await _sendMessage('getBalance')) as any;
      api.balance = result.balance;
      return result.balance;
    },

    async getNetworkInfo(): Promise<unknown> {
      try {
        return await _sendMessage('get_network_info');
      } catch {
        return {
          id: 'mainnet',
          name: 'Mainnet',
          rpc_url: 'https://octra.network',
          color: '#6366f1',
        };
      }
    },

    async switchNetwork(networkId: string): Promise<unknown> {
      return await _sendMessage('switch_network', { networkId });
    },

    getConnectedSite(): object {
      const links = document.querySelectorAll('link[rel*="icon"]');
      const favicon =
        links.length > 0
          ? (links[links.length - 1] as HTMLLinkElement).href
          : `${window.location.origin}/favicon.ico`;
      return {
        hostname: window.location.hostname,
        origin: window.location.origin,
        url: window.location.href,
        title: document.title,
        favicon,
      };
    },

    async getSessionInfo(): Promise<{ hasActiveWallet: boolean; address: string | null }> {
      try {
        const result = (await _sendMessage('ping')) as any;
        if (result?.hasActiveWallet)
          return { hasActiveWallet: true, address: result.walletAddress };
        return { hasActiveWallet: false, address: null };
      } catch {
        return { hasActiveWallet: false, address: null };
      }
    },

    async getWalletInfo(): Promise<object> {
      if (!api.isConnected) throw new Error('Wallet not connected');
      const result = (await _sendMessage('getWalletInfo')) as any;
      api.address = result.address;
      api.balance = result.balance;
      if (typeof result.canSign === 'boolean') api.canSign = result.canSign;
      return {
        address: api.address,
        balance: api.balance,
        privateBalance: result.privateBalance || 0,
        canSign: api.canSign,
      };
    },

    async sendTransaction({
      to,
      amount,
      memo,
    }: {
      to: string;
      amount: number;
      memo?: string;
    }): Promise<unknown> {
      if (!api.isConnected) throw new Error('Wallet not connected');
      return await _sendMessage('sendTransaction', { to, amount, memo });
    },

    async callContract({
      contract,
      method,
      params,
      amount,
      ou,
    }: {
      contract: string;
      method: string;
      params: unknown;
      amount?: string | number;
      ou?: string | number;
    }): Promise<unknown> {
      if (!api.isConnected) throw new Error('Wallet not connected');
      const payload: Record<string, unknown> = {
        contract,
        method,
        params,
        amount: amount != null ? String(amount) : '0',
      };
      if (ou != null) payload.ou = String(ou);
      return await _sendMessage('call_contract', payload);
    },

    async deployContract({
      bytecode,
      params,
      ou,
    }: {
      bytecode: string;
      params?: string | unknown[];
      ou?: string | number;
    }): Promise<unknown> {
      if (!api.isConnected) throw new Error('Wallet not connected');
      const payload: Record<string, unknown> = { bytecode };
      if (params != null) payload.params = params;
      if (ou != null) payload.ou = String(ou);
      return await _sendMessage('deploy_contract', payload);
    },

    async contractCallView({
      contract,
      method,
      params,
      caller,
    }: {
      contract: string;
      method: string;
      params: unknown;
      caller?: string;
    }): Promise<unknown> {
      const payload: Record<string, unknown> = { contract, method, params };
      if (caller != null) payload.caller = caller;
      return await _sendMessage('contract_call_view', payload);
    },

    async getContractStorage(contract: string, key: string): Promise<unknown> {
      return await _sendMessage('get_contract_storage', { contract, key });
    },

    async signMessage(message: string): Promise<string> {
      if (!api.isConnected) throw new Error('Wallet not connected');
      const result = (await _sendMessage('signMessage', { message })) as any;
      return result.signature;
    },

    async getTransactionHistory(limit = 50): Promise<unknown> {
      return await _sendMessage('getTransactionHistory', { limit });
    },

    async getPublicKey(): Promise<string> {
      if (!api.isConnected) throw new Error('Wallet not connected');
      const result = (await _sendMessage('getPublicKey')) as any;
      return result.publicKey;
    },

    async getConnectionStatus(): Promise<unknown> {
      return await _sendMessage('getConnectionStatus');
    },

    async getPrivateBalanceInfo(): Promise<unknown> {
      return await _sendMessage('get_private_balance_info');
    },

    async encryptBalance(amount: number): Promise<unknown> {
      if (!api.isConnected) throw new Error('Wallet not connected');
      return await _sendMessage('encrypt_balance', { amount });
    },

    async decryptBalance(amount: number): Promise<unknown> {
      if (!api.isConnected) throw new Error('Wallet not connected');
      return await _sendMessage('decrypt_balance', { amount });
    },

    async sendPrivateTransfer({
      to,
      amount,
      message,
    }: {
      to: string;
      amount: number;
      message?: string;
    }): Promise<unknown> {
      if (!api.isConnected) throw new Error('Wallet not connected');
      return await _sendMessage('send_private_transfer', { to, amount, message });
    },

    async getPendingPrivateTransfers(): Promise<unknown> {
      return await _sendMessage('get_pending_private_transfers');
    },

    async claimPrivateTransfer(transferId: string): Promise<unknown> {
      if (!api.isConnected) throw new Error('Wallet not connected');
      return await _sendMessage('claim_private_transfer', { transferId });
    },

    on(event: string, callback: EventCallback): void {
      if (!_eventListeners.has(event)) _eventListeners.set(event, []);
      _eventListeners.get(event)!.push(callback);
    },

    off(event: string, callback: EventCallback): void {
      const listeners = _eventListeners.get(event);
      if (!listeners) return;
      const idx = listeners.indexOf(callback);
      if (idx > -1) listeners.splice(idx, 1);
    },

    declareIntegration(options: DeclareIntegrationOptions = {}): void {
      const meta = document.createElement('meta');
      meta.name = '0xio-dapp';
      meta.content = JSON.stringify({
        name: options.name || document.title,
        description: options.description || '0xio DApp',
        version: options.version || '1.0.0',
        integrated: true,
        timestamp: Date.now(),
      });
      document.head.appendChild(meta);
    },
  };

  interface OctraProvider {
    isOctra: true;
    isFhex: true;
    readonly canSign: boolean | null;
    request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
    on(event: string, listener: (...args: any[]) => void): OctraProvider;
    removeListener(event: string, listener: (...args: any[]) => void): OctraProvider;
  }

  const octraProvider: OctraProvider = {
    isOctra: true,
    isFhex: true,
    get canSign() {
      return api.isConnected ? api.canSign : null;
    },

    async request({
      method,
      params,
    }: {
      method: string;
      params?: readonly unknown[] | object;
    }): Promise<unknown> {
      const p0 = Array.isArray(params) ? params[0] : params;

      switch (method) {
        case 'octra_requestAccounts': {
          const result = (await _sendMessage(
            'connect',
            (p0 as Record<string, unknown>) || {}
          )) as any;
          if (result?.address) {
            api.isConnected = true;
            api.address = result.address;
            api.balance = result.balance ?? null;
            api.canSign = _canSignOf(result);
            const chainId = result?.networkInfo?.id ?? 'mainnet';
            const permissions = result?.permissions ?? [];
            _octraEmit('connect', { chainId, canSign: api.canSign });
            _octraEmit('accountsChanged', [result.address]);
            _octraEmit('permissionsChanged', permissions);
          }
          return [result.address].filter(Boolean);
        }
        case 'octra_accounts':
          return api.isConnected && api.address ? [api.address] : [];

        case 'octra_networkId': {
          const info = (await _sendMessage('get_network_info')) as any;
          return info?.id ?? null;
        }
        case 'octra_networkInfo':
          return _sendMessage('get_network_info');

        case 'octra_permissions': {
          const status = (await _sendMessage('getConnectionStatus')) as any;
          return status?.permissions ?? [];
        }
        case 'octra_switchNetwork': {
          const networkId = (p0 as any)?.networkId ?? (Array.isArray(params) ? params[0] : params);
          return _sendMessage('switch_network', { networkId });
        }
        case 'octra_signMessage': {
          const message = (p0 as any)?.message ?? p0;
          const result = (await _sendMessage('signMessage', { message })) as any;
          return result?.signature ?? result;
        }
        case 'octra_sendTransaction': {
          const txResult = (await _sendMessage(
            'sendTransaction',
            (p0 as Record<string, unknown>) || {}
          )) as any;
          const txHash = txResult?.txHash ?? txResult?.hash;
          return { hash: txHash, accepted: !!txHash, status: 'pending' as const, txHash };
        }

        case 'octra_signTransaction': {
          const result = (await _sendMessage(
            'sign_transaction',
            (p0 as Record<string, unknown>) || {}
          )) as any;
          return result?.signedTx ?? result;
        }

        case 'octra_submitTransaction': {
          const subResult = (await _sendMessage(
            'broadcast_only',
            (p0 as Record<string, unknown>) || {}
          )) as any;
          const subHash = subResult?.txHash ?? subResult?.hash;
          return {
            hash: subHash,
            accepted: !!subHash,
            status: 'pending' as const,
            txHash: subHash,
          };
        }

        case 'octra_callContract':
          return _sendMessage('contract_call_view', (p0 as Record<string, unknown>) || {});

        case 'octra_sendContractTransaction': {
          const ctxResult = (await _sendMessage(
            'call_contract',
            (p0 as Record<string, unknown>) || {}
          )) as any;
          const ctxHash = ctxResult?.txHash ?? ctxResult?.hash;
          return {
            hash: ctxHash,
            accepted: !!ctxHash,
            status: 'pending' as const,
            txHash: ctxHash,
          };
        }

        case 'octra_deployContract': {
          const dResult = (await _sendMessage(
            'deploy_contract',
            (p0 as Record<string, unknown>) || {}
          )) as any;
          const dHash = dResult?.txHash ?? dResult?.hash;
          return {
            hash: dHash,
            accepted: !!dHash,
            status: 'pending' as const,
            txHash: dHash,
            contractAddress: dResult?.contractAddress,
          };
        }

        case 'octra_getContractReceipt':
          throw new OctraProviderError(4200, 'octra_getContractReceipt is not yet supported');

        case 'octra_getEncryptedBalance':
          return _sendMessage('get_private_balance_info');

        case 'octra_encryptBalance':
          return _sendMessage('encrypt_balance', (p0 as Record<string, unknown>) || {});

        case 'octra_decryptBalance':
          return _sendMessage('decrypt_balance', (p0 as Record<string, unknown>) || {});

        case 'octra_sendPrivateTransfer':
          return _sendMessage('send_private_transfer', (p0 as Record<string, unknown>) || {});

        case 'octra_scanStealth':
          throw new OctraProviderError(4200, 'octra_scanStealth is not yet supported');

        case 'octra_claimStealth':
        case 'octra_claimPrivateTransfer':
          return _sendMessage('claim_private_transfer', (p0 as Record<string, unknown>) || {});

        case 'octra_getPrivateCapabilities':
          return _sendMessage('get_private_capabilities');
        case 'octra_callContractView':
          return _sendMessage('contract_call_view', (p0 as Record<string, unknown>) || {});
        case 'octra_getPrivateBalance':
          return _sendMessage('get_private_balance', (p0 as Record<string, unknown>) || {});
        case 'octra_encryptValue':
          return _sendMessage('encrypt_value', (p0 as Record<string, unknown>) || {});
        case 'octra_decryptValue':
          return _sendMessage('decrypt_value', (p0 as Record<string, unknown>) || {});
        case 'octra_makeZeroProof':
          return _sendMessage('make_zero_proof', (p0 as Record<string, unknown>) || {});
        case 'octra_makeRangeProof':
          return _sendMessage('make_range_proof', (p0 as Record<string, unknown>) || {});
        case 'octra_registerPrivateViewKey':
          return _sendMessage('register_private_view_key', (p0 as Record<string, unknown>) || {});
        case 'octra_sendContractTransactionSequence':
          return _sendMessage(
            'send_contract_transaction_sequence',
            (p0 as Record<string, unknown>) || {}
          );

        default:
          if (method.startsWith('octra_') || method.startsWith('oct_')) {
            return _sendMessage('rpc_call', { method, params });
          }
          throw new OctraProviderError(4200, `Unsupported method: ${method}`);
      }
    },

    on(event: string, listener: (...args: any[]) => void): OctraProvider {
      if (!_octraListeners.has(event)) _octraListeners.set(event, new Set());
      _octraListeners.get(event)!.add(listener);
      return octraProvider;
    },

    removeListener(event: string, listener: (...args: any[]) => void): OctraProvider {
      _octraListeners.get(event)?.delete(listener);
      return octraProvider;
    },
  };

  const EVM_REVIEWED = new Set([
    'eth_requestAccounts',
    'wallet_requestPermissions',
    'eth_sendTransaction',
    'personal_sign',
    'eth_signTypedData_v3',
    'eth_signTypedData_v4',
    'wallet_switchEthereumChain',
    'wallet_addEthereumChain',
    'wallet_watchAsset',
  ]);
  const _evmListeners = new Map<string, Set<(...args: any[]) => void>>();
  let _evmChainId: string | null = null;
  let _evmAccounts: string[] = [];
  let _evmConnected = false;
  let _evmGone = false;
  let _evmStateAsked = false;

  function _evmEmit(event: string, ...args: unknown[]) {
    for (const fn of [...(_evmListeners.get(event) ?? [])]) {
      try {
        fn(...args);
      } catch (err) {
        console.error('[0xio Wallet] ethereum listener error:', err);
      }
    }
  }

  function _evmSetChain(chainId: unknown, emit: boolean) {
    if (typeof chainId !== 'string' || !/^0x[0-9a-f]+$/i.test(chainId)) return;
    const changed = _evmChainId !== null && _evmChainId !== chainId;
    _evmChainId = chainId;
    if (!_evmConnected) {
      _evmConnected = true;
      _evmEmit('connect', { chainId });
    } else if (changed && emit) {
      _evmEmit('chainChanged', chainId);
    }
  }

  function _evmSetAccounts(accounts: unknown) {
    if (!Array.isArray(accounts) || accounts.some((a) => typeof a !== 'string')) return;
    const next = accounts as string[];
    if (next.length === _evmAccounts.length && next.every((a, i) => a === _evmAccounts[i])) return;
    _evmAccounts = next;
    _evmEmit('accountsChanged', [...next]);
  }

  function _evmApplyState(state: any, emit: boolean) {
    if (!state || typeof state !== 'object') return;
    _evmSetChain(state.chainId, emit);
    _evmSetAccounts(state.accounts);
  }

  function _evmSettle(requestId: string, response: any) {
    const req = _evmPending.get(requestId);
    if (!req) return;
    _evmPending.delete(requestId);
    clearTimeout(req.timer);
    if (response?.success === true) {
      req.resolve(response.data);
      return;
    }
    const err = response?.error;
    if (err && typeof err === 'object' && typeof err.code === 'number') {
      req.reject(new EvmProviderError(err.code, String(err.message || 'Request failed'), err.data));
    } else if (err && typeof err === 'object' && err.code === 'EXTENSION_NOT_FOUND') {
      const gone = new EvmProviderError(4900, String(err.message || 'Disconnected'));
      req.reject(gone);
      if (!_evmGone) {
        _evmGone = true;
        _evmConnected = false;
        _evmEmit('disconnect', gone);
      }
    } else {
      req.reject(new EvmProviderError(-32603, typeof err === 'string' ? err : 'Request failed'));
    }
  }

  function _evmSend(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!_port) {
        reject(new EvmProviderError(4900, 'The 0xio extension is not connected to this page.'));
        return;
      }
      let clean: unknown;
      try {
        clean = params === undefined ? undefined : JSON.parse(JSON.stringify(params));
      } catch {
        reject(new EvmProviderError(-32602, 'params must be JSON'));
        return;
      }
      const requestId = crypto.randomUUID();
      const timer = setTimeout(
        () => {
          if (!_evmPending.delete(requestId)) return;
          reject(new EvmProviderError(-32603, 'Request timed out'));
        },
        EVM_REVIEWED.has(method) ? 300_000 : 60_000
      );
      _evmPending.set(requestId, { resolve, reject, timer });
      _port.postMessage({ requestId, method, params: clean });
    });
  }

  function _evmLoadState() {
    if (_evmStateAsked) return;
    _evmStateAsked = true;
    _evmSend('wallet_getProviderState', [])
      .then((state) => _evmApplyState(state, true))
      .catch(() => {
        _evmStateAsked = false;
      });
  }

  async function _evmRequest(args: unknown): Promise<unknown> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new EvmProviderError(-32602, 'Expected a single object with a method');
    }
    const { method, params } = args as { method?: unknown; params?: unknown };
    if (typeof method !== 'string' || !method) {
      throw new EvmProviderError(-32602, 'method must be a non-empty string');
    }
    _evmLoadState();
    const result = await _evmSend(method, params);
    if (method === 'eth_chainId') _evmSetChain(result, true);
    else if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
      _evmSetAccounts(result);
    } else if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') {
      _evmApplyState(await _evmSend('wallet_getProviderState', []).catch((): null => null), true);
    }
    return result;
  }

  type LegacyPayload = { id?: unknown; jsonrpc?: string; method: string; params?: unknown };
  type LegacyCallback = (error: Error | null, response?: unknown) => void;

  function _evmSendAsync(payload: LegacyPayload | LegacyPayload[], callback: LegacyCallback) {
    const one = (p: LegacyPayload) =>
      _evmRequest({ method: p.method, params: p.params }).then(
        (result) => ({ id: p.id, jsonrpc: '2.0', result }),
        (error: EvmProviderError) => ({
          id: p.id,
          jsonrpc: '2.0',
          error: { code: error.code ?? -32603, message: error.message, data: error.data },
        })
      );
    if (Array.isArray(payload)) {
      Promise.all(payload.map(one)).then((r) => callback(null, r));
    } else {
      one(payload).then((r) => callback((r as any).error ? (r as any).error : null, r));
    }
  }

  const evmProvider: Record<string, unknown> = {
    isMetaMask: false,
    isOxio: true,
    is0xio: true,
    request: (args: unknown) => _evmRequest(args),
    isConnected: () => !!_port && !_evmGone,
    enable: () => _evmRequest({ method: 'eth_requestAccounts' }),
    on(event: string, listener: (...args: any[]) => void) {
      if (typeof listener !== 'function') return evmProvider;
      if (!_evmListeners.has(event)) _evmListeners.set(event, new Set());
      _evmListeners.get(event)!.add(listener);
      if (event === 'accountsChanged' || event === 'chainChanged' || event === 'connect') {
        _evmLoadState();
      }
      return evmProvider;
    },
    once(event: string, listener: (...args: any[]) => void) {
      const wrapped = (...args: any[]) => {
        _evmListeners.get(event)?.delete(wrapped);
        listener(...args);
      };
      return (evmProvider.on as (e: string, l: (...a: any[]) => void) => unknown)(event, wrapped);
    },
    removeListener(event: string, listener: (...args: any[]) => void) {
      _evmListeners.get(event)?.delete(listener);
      return evmProvider;
    },
    off(event: string, listener: (...args: any[]) => void) {
      _evmListeners.get(event)?.delete(listener);
      return evmProvider;
    },
    removeAllListeners(event?: string) {
      if (event) _evmListeners.delete(event);
      else _evmListeners.clear();
      return evmProvider;
    },
    listenerCount: (event: string) => _evmListeners.get(event)?.size ?? 0,
    sendAsync: (payload: LegacyPayload | LegacyPayload[], callback: LegacyCallback) =>
      _evmSendAsync(payload, callback),
    send(methodOrPayload: string | LegacyPayload, paramsOrCallback?: unknown) {
      if (typeof methodOrPayload === 'string') {
        return _evmRequest({ method: methodOrPayload, params: paramsOrCallback });
      }
      if (typeof paramsOrCallback === 'function') {
        _evmSendAsync(methodOrPayload, paramsOrCallback as LegacyCallback);
        return undefined;
      }
      const p = methodOrPayload;
      const cached: Record<string, unknown> = {
        eth_accounts: [..._evmAccounts],
        eth_coinbase: _evmAccounts[0] ?? null,
        net_version: _evmChainId ? String(parseInt(_evmChainId, 16)) : null,
        eth_chainId: _evmChainId,
      };
      if (!p || !(p.method in cached)) {
        throw new EvmProviderError(4200, 'Synchronous send is not supported. Use request().');
      }
      return { id: p.id, jsonrpc: '2.0', result: cached[p.method] };
    },
  };
  Object.defineProperties(evmProvider, {
    chainId: { get: () => _evmChainId, enumerable: true },
    networkVersion: {
      get: () => (_evmChainId ? String(parseInt(_evmChainId, 16)) : null),
      enumerable: true,
    },
    selectedAddress: { get: () => _evmAccounts[0] ?? null, enumerable: true },
  });

  if (!(window as any).ethereum) {
    try {
      Object.defineProperty(window, 'ethereum', {
        value: evmProvider,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      window.dispatchEvent(new Event('ethereum#initialized'));
    } catch {}
  }

  const _eip6963Detail = Object.freeze({
    info: Object.freeze({
      uuid: crypto.randomUUID(),
      name: '0xio Wallet',
      icon: OXIO_ICON,
      rdns: 'xyz.0xio.wallet',
    }),
    provider: evmProvider,
  });
  const _announce = () =>
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: _eip6963Detail }));
  window.addEventListener('eip6963:requestProvider', _announce);
  _announce();

  window.octra = octraProvider;
  const _existingProviders: object[] = Array.isArray((window as any).octraProviders)
    ? (window as any).octraProviders
    : [];
  _existingProviders.push(octraProvider);
  window.octraProviders = _existingProviders;

  window.wallet0xio = api;
  window.ZeroXIOWallet = api;
  if (!window.wallet) window.wallet = api;

  const EXT_VERSION = typeof __EXT_VERSION__ !== 'undefined' ? __EXT_VERSION__ : '0.0.0';

  window.dispatchEvent(
    new CustomEvent('0xioWalletReady', { detail: { version: EXT_VERSION, wallet: api } })
  );
  window.dispatchEvent(
    new CustomEvent('wallet0xioReady', { detail: { version: EXT_VERSION, wallet: api } })
  );
  window.dispatchEvent(
    new CustomEvent('octraWalletReady', {
      detail: { version: EXT_VERSION, provider: octraProvider },
    })
  );
  window.dispatchEvent(new CustomEvent('octra#initialized'));

  // Presence only: never the lock state, address, network or connection.
  const _walletAnnounce = Object.freeze({
    protocol: 2,
    kind: 'extension',
    version: EXT_VERSION,
    name: '0xio Wallet',
  });
  const _announceWallet = () =>
    window.dispatchEvent(new CustomEvent('0xio:announceWallet', { detail: _walletAnnounce }));
  window.addEventListener('0xio:requestWallet', _announceWallet);
  _announceWallet();
})();
