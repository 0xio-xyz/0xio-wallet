import { fromUnits, toUnits } from 'src/utils/amount';
import { feeCeilingProblem, type EvmFees, type PreparedTransfer } from './send';

export type FeeSpeed = 'slow' | 'normal' | 'fast';
export const FEE_SPEEDS: readonly FeeSpeed[] = ['slow', 'normal', 'fast'];

export interface GasPrice {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export type FeeChoice = { speed: FeeSpeed } | { custom: GasPrice };

export const NORMAL_FEE: FeeChoice = { speed: 'normal' };

const GWEI = 1_000_000_000n;
const TIP_STEP = GWEI / 10n;

export function feePresets(fees: EvmFees): Record<FeeSpeed, GasPrice> {
  const normal = {
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
  if (fees.baseFeePerGas === null) {
    const price = (n: bigint) => ({ maxFeePerGas: n, maxPriorityFeePerGas: n });
    return {
      slow: price((fees.maxFeePerGas * 10n) / 12n),
      normal,
      fast: price((fees.maxFeePerGas * 3n + 1n) / 2n),
    };
  }
  const base = fees.baseFeePerGas;
  const tip = fees.maxPriorityFeePerGas;
  const slowTip = tip / 2n;
  const fastTip = tip * 2n > tip + TIP_STEP ? tip * 2n : tip + TIP_STEP;
  return {
    slow: { maxFeePerGas: (base * 5n + 3n) / 4n + slowTip, maxPriorityFeePerGas: slowTip },
    normal,
    fast: { maxFeePerGas: base * 3n + fastTip, maxPriorityFeePerGas: fastTip },
  };
}

export function resolveFee(fees: EvmFees, choice: FeeChoice): GasPrice {
  return 'custom' in choice ? choice.custom : feePresets(fees)[choice.speed];
}

export function withGasPrice(prepared: PreparedTransfer, gas: GasPrice): PreparedTransfer {
  const legacy = prepared.tx.legacy === true;
  const maxPriorityFeePerGas = legacy ? gas.maxFeePerGas : gas.maxPriorityFeePerGas;
  const feeWei = prepared.tx.gasLimit * gas.maxFeePerGas;
  return {
    ...prepared,
    tx: { ...prepared.tx, maxFeePerGas: gas.maxFeePerGas, maxPriorityFeePerGas },
    feeWei,
    totalNative: prepared.tx.value + feeWei,
  };
}

export function applyFeeChoice(
  prepared: PreparedTransfer,
  choice: FeeChoice | undefined
): PreparedTransfer {
  if (!prepared.fees || !choice) return prepared;
  return withGasPrice(prepared, resolveFee(prepared.fees, choice));
}

export function networkMinimum(fees: EvmFees, priority: bigint): bigint {
  if (fees.baseFeePerGas === null) return (fees.maxFeePerGas * 10n) / 12n;
  return fees.baseFeePerGas + priority;
}

export function stillCovers(gas: GasPrice, fresh: EvmFees): boolean {
  return gas.maxFeePerGas >= networkMinimum(fresh, gas.maxPriorityFeePerGas);
}

export type CustomProblem = 'format' | 'priority' | 'belowBase' | 'ceiling';

export interface CustomInput {
  maxGwei: string;
  priorityGwei: string;
}

const parseGwei = (s: string): bigint | null => {
  try {
    return toUnits(s.trim(), 9);
  } catch {
    return null;
  }
};

export function checkCustom(
  input: CustomInput,
  fees: EvmFees,
  chainId: number
): { gas: GasPrice; problem: CustomProblem | null } | { gas: null; problem: CustomProblem } {
  const max = parseGwei(input.maxGwei);
  if (max === null || max === 0n) return { gas: null, problem: 'format' };
  const legacy = fees.baseFeePerGas === null;
  const priority = legacy ? max : parseGwei(input.priorityGwei);
  if (priority === null) return { gas: null, problem: 'format' };
  if (priority === 0n) return { gas: null, problem: 'priority' };
  const gas = { maxFeePerGas: max, maxPriorityFeePerGas: priority };
  if (max < networkMinimum(fees, priority)) return { gas, problem: 'belowBase' };
  const reference = networkMinimum(fees, fees.maxPriorityFeePerGas);
  if (feeCeilingProblem(chainId, max, reference)) return { gas, problem: 'ceiling' };
  return { gas, problem: null };
}

export function toGwei(wei: bigint): string {
  const [int, frac = ''] = fromUnits(wei, 9).split('.');
  const cut = frac.slice(0, 4).replace(/0+$/, '');
  if (cut) return `${int}.${cut}`;
  return int === '0' && wei > 0n ? fromUnits(wei, 9) : int;
}
