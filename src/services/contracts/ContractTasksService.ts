import { ZeroXIOConfig, isCustomNetworkId, resolveCustomNetwork } from 'src/utils/config';
import { logger } from 'src/utils/logger';
import type { TxScope } from '../network/txScope';

export interface ContractMethodParam {
  name: string;
  type: 'number' | 'address';
  label: string;
  max?: number;
  placeholder?: string;
}

export interface ContractMethod {
  name: string;
  label: string;
  params: ContractMethodParam[];
  type: 'view' | 'call';
  description: string;
}

interface UsageStats {
  [methodName: string]: {
    count: number;
    lastUsed: string | null;
  };
}

interface ContractResult {
  success: boolean;
  result?: unknown;
  decryptedResult?: number;
  txHash?: string;
  error?: string;
}

interface NetworkServiceLike {
  contractCallView(
    contractAddress: string,
    methodName: string,
    params: unknown[],
    callerAddress: string
  ): Promise<unknown>;
  contractCall(
    contractAddress: string,
    methodName: string,
    params: unknown[],
    walletAddress: string,
    privateKey: string,
    ou: string | undefined,
    scope: TxScope
  ): Promise<string>;
}

export class ContractTasksService {
  private network: NetworkServiceLike;
  private methods: ContractMethod[];

  constructor(networkService: NetworkServiceLike) {
    this.network = networkService;

    this.methods = [
      {
        name: 'greetCaller',
        label: 'Greeting (get personal message)',
        params: [],
        type: 'view',
        description: 'Get a personalized greeting from the contract',
      },
      {
        name: 'getSpec',
        label: 'Contract Info (get contract description)',
        params: [],
        type: 'view',
        description: 'Retrieve contract specification and details',
      },
      {
        name: 'claimToken',
        label: 'Claim 1 Token (only once per address)',
        params: [],
        type: 'call',
        description: 'Claim your one-time token reward',
      },
      {
        name: 'getCredits',
        label: 'Check Token Balance',
        params: [{ name: 'address', type: 'address' as const, label: 'Wallet Address' }],
        type: 'view',
        description: 'Check how many tokens an address has',
      },
      {
        name: 'dotProduct',
        label: 'Dot Product (x1 * x2 + y1 * y2)',
        params: [
          { name: 'x1', type: 'number' as const, label: 'X1' },
          { name: 'y1', type: 'number' as const, label: 'Y1' },
          { name: 'x2', type: 'number' as const, label: 'X2' },
          { name: 'y2', type: 'number' as const, label: 'Y2' },
        ],
        type: 'view',
        description: 'Calculate dot product of two 2D vectors',
      },
      {
        name: 'vectorMagnitude',
        label: 'Vector Magnitude sqrt(x^2 + y^2)',
        params: [
          { name: 'x', type: 'number' as const, label: 'X' },
          { name: 'y', type: 'number' as const, label: 'Y' },
        ],
        type: 'view',
        description: 'Calculate magnitude of a 2D vector',
      },
      {
        name: 'power',
        label: 'Power (base^exponent)',
        params: [
          { name: 'base', type: 'number' as const, label: 'Base' },
          { name: 'exponent', type: 'number' as const, label: 'Exponent', max: 255 },
        ],
        type: 'view',
        description: 'Calculate base raised to exponent',
      },
      {
        name: 'factorial',
        label: 'Factorial (n!)',
        params: [{ name: 'n', type: 'number' as const, label: 'Number', max: 20 }],
        type: 'view',
        description: 'Calculate factorial of a number',
      },
      {
        name: 'fibonacci',
        label: 'Fibonacci Number',
        params: [{ name: 'n', type: 'number' as const, label: 'Position', max: 100 }],
        type: 'view',
        description: 'Get the nth Fibonacci number',
      },
      {
        name: 'gcd',
        label: 'Greatest Common Divisor',
        params: [
          { name: 'a', type: 'number' as const, label: 'Number A' },
          { name: 'b', type: 'number' as const, label: 'Number B' },
        ],
        type: 'view',
        description: 'Find GCD of two numbers',
      },
      {
        name: 'isPrime',
        label: 'Check if Number is Prime',
        params: [{ name: 'n', type: 'number' as const, label: 'Number' }],
        type: 'view',
        description: 'Determine if a number is prime',
      },
      {
        name: 'matrixDeterminant2x2',
        label: '2x2 Matrix Determinant (ad - bc)',
        params: [
          { name: 'a', type: 'number' as const, label: 'a' },
          { name: 'b', type: 'number' as const, label: 'b' },
          { name: 'c', type: 'number' as const, label: 'c' },
          { name: 'd', type: 'number' as const, label: 'd' },
        ],
        type: 'view',
        description: 'Calculate determinant of 2x2 matrix',
      },
      {
        name: 'linearInterpolate',
        label: 'Linear Interpolation',
        params: [
          { name: 'x0', type: 'number' as const, label: 'X0' },
          { name: 'y0', type: 'number' as const, label: 'Y0' },
          { name: 'x1', type: 'number' as const, label: 'X1' },
          { name: 'y1', type: 'number' as const, label: 'Y1' },
          { name: 'x', type: 'number' as const, label: 'X' },
        ],
        type: 'view',
        description: 'Calculate linear interpolation between two points',
      },
      {
        name: 'modularExponentiation',
        label: 'Modular Exponentiation (base^exp mod m)',
        params: [
          { name: 'base', type: 'number' as const, label: 'Base' },
          { name: 'exp', type: 'number' as const, label: 'Exponent' },
          { name: 'mod', type: 'number' as const, label: 'Modulo' },
        ],
        type: 'view',
        description: 'Calculate modular exponentiation',
      },
    ];
  }

  async getContractAddress(networkId?: string): Promise<string> {
    try {
      const storage = networkId
        ? {}
        : await chrome.storage.local.get([
            ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK,
            ZeroXIOConfig.STORAGE.KEYS.CUSTOM_NETWORK,
          ]);

      const currentNetwork =
        networkId || storage[ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK] || 'mainnet';

      if (currentNetwork === 'mainnet') {
        return ZeroXIOConfig.CONTRACTS.DEMO_CONTRACT;
      }

      if (isCustomNetworkId(currentNetwork)) {
        const net = await resolveCustomNetwork(currentNetwork);
        if (net?.contract_address) return net.contract_address;
      }

      return ZeroXIOConfig.CONTRACTS.DEMO_CONTRACT;
    } catch (error: unknown) {
      logger.error('Failed to get contract address:', error);
      return ZeroXIOConfig.CONTRACTS.DEMO_CONTRACT;
    }
  }

  getMethods(): ContractMethod[] {
    return this.methods;
  }

  getMethod(methodName: string): ContractMethod | undefined {
    return this.methods.find((m) => m.name === methodName);
  }

  async getUsageStats(): Promise<UsageStats> {
    try {
      const result = await chrome.storage.local.get('contract_usage_stats');
      return result.contract_usage_stats || {};
    } catch (error: unknown) {
      logger.error('Failed to load usage stats:', error);
      return {};
    }
  }

  async saveUsageStats(stats: UsageStats): Promise<void> {
    try {
      await chrome.storage.local.set({ contract_usage_stats: stats });
    } catch (error: unknown) {
      logger.error('Failed to save usage stats:', error);
    }
  }

  async trackMethodUsage(methodName: string): Promise<void> {
    const stats = await this.getUsageStats();

    if (!stats[methodName]) {
      stats[methodName] = {
        count: 0,
        lastUsed: null,
      };
    }

    stats[methodName].count++;
    stats[methodName].lastUsed = new Date().toISOString();

    await this.saveUsageStats(stats);
  }

  async executeViewMethod(
    methodName: string,
    params: unknown[] = [],
    callerAddress: string,
    fhe?: {
      encrypt?: (value: number) => Promise<string>;
      decrypt?: (cipher: string) => Promise<number>;
    }
  ): Promise<ContractResult> {
    try {
      await this.trackMethodUsage(methodName);

      const contractAddress = await this.getContractAddress();

      let finalParams = params;
      if (fhe?.encrypt) {
        const paramsStr = JSON.stringify(params);
        const expanded = await this.expandEncParams(paramsStr, fhe.encrypt);
        if (expanded !== paramsStr) {
          finalParams = JSON.parse(expanded);
          logger.debug('Expanded FHE params for view:', methodName);
        }
      }

      const response = await this.network.contractCallView(
        contractAddress,
        methodName,
        finalParams,
        callerAddress
      );

      let decryptedResult: number | undefined;
      if (fhe?.decrypt) {
        const dec = await this.tryFheDecrypt(response, fhe.decrypt);
        if (dec !== null) {
          decryptedResult = dec;
          logger.debug('FHE auto-decrypted view result:', methodName, dec);
        }
      }

      return {
        success: true,
        result: response,
        decryptedResult,
      };
    } catch (error: unknown) {
      logger.error(`View method ${methodName} failed:`, error);
      const msg = error instanceof Error ? error.message : 'Contract call failed';
      return {
        success: false,
        error: msg,
      };
    }
  }

  async executeCallMethod(
    methodName: string,
    params: unknown[] = [],
    walletAddress: string,
    privateKey: string,
    scope: TxScope,
    fhe?: { encrypt?: (value: number) => Promise<string> }
  ): Promise<ContractResult> {
    try {
      await this.trackMethodUsage(methodName);

      const contractAddress = await this.getContractAddress(scope.networkId);

      let finalParams = params;
      if (fhe?.encrypt) {
        const paramsStr = JSON.stringify(params);
        const expanded = await this.expandEncParams(paramsStr, fhe.encrypt);
        if (expanded !== paramsStr) {
          finalParams = JSON.parse(expanded);
          logger.debug('Expanded FHE params for call:', methodName);
        }
      }

      const txHash = await this.network.contractCall(
        contractAddress,
        methodName,
        finalParams,
        walletAddress,
        privateKey,
        undefined,
        scope
      );

      return {
        success: true,
        txHash: txHash,
        result: { txHash },
      };
    } catch (error: unknown) {
      logger.error(`Call method ${methodName} failed:`, error);
      const msg = error instanceof Error ? error.message : 'Transaction failed';
      return {
        success: false,
        error: msg,
      };
    }
  }

  async expandEncParams(
    paramsJson: string,
    encryptFn: (value: number) => Promise<string>
  ): Promise<string> {
    const re = /enc\((-?\d+)\)/g;
    const matches: Array<{ start: number; end: number; value: number }> = [];
    let m;
    while ((m = re.exec(paramsJson)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, value: parseInt(m[1]) });
    }
    if (matches.length === 0) return paramsJson;
    let result = paramsJson;
    for (let i = matches.length - 1; i >= 0; i--) {
      const r = matches[i];
      const cipher = await encryptFn(r.value);
      result = result.substring(0, r.start) + '"' + cipher + '"' + result.substring(r.end);
    }
    return result;
  }

  async tryFheDecrypt(
    val: unknown,
    decryptFn: (cipher: string) => Promise<number>
  ): Promise<number | null> {
    if (typeof val !== 'string' || val.length < 100) return null;
    try {
      return await decryptFn(val);
    } catch {
      return null;
    }
  }

  validateParams(method: ContractMethod, paramValues: unknown[]): string[] {
    const errors: string[] = [];

    method.params.forEach((param, index) => {
      const value = paramValues[index];

      if (value === undefined || value === null || value === '') {
        errors.push(`${param.label || param.name} is required`);
        return;
      }

      if (param.type === 'number') {
        const num = Number(value);
        if (isNaN(num)) {
          errors.push(`${param.label || param.name} must be a valid number`);
          return;
        }

        if (param.max !== undefined && num > param.max) {
          errors.push(`${param.label || param.name} must be <= ${param.max}`);
        }

        if (num < 0) {
          errors.push(`${param.label || param.name} must be >= 0`);
        }
      }

      if (param.type === 'address') {
        const addrStr = String(value);
        if (!addrStr.startsWith('oct')) {
          errors.push(`${param.label || param.name} must start with 'oct'`);
        }
        if (addrStr.length < 40) {
          errors.push(`${param.label || param.name} must be a valid address`);
        }
      }
    });

    return errors;
  }
}
