import { toChecksumAddress } from './accounts';

export type KnownCall =
  | { kind: 'transfer'; to: string; amount: string }
  | { kind: 'approve'; spender: string; amount: string; unlimited: boolean }
  | { kind: 'increaseAllowance'; spender: string; amount: string; unlimited: boolean }
  | { kind: 'transferFrom'; from: string; to: string; amount: string }
  | { kind: 'setApprovalForAll'; operator: string; approved: boolean };

const SIGNATURES: Record<
  string,
  { name: KnownCall['kind']; args: ('address' | 'uint' | 'bool')[] }
> = {
  a9059cbb: { name: 'transfer', args: ['address', 'uint'] },
  '095ea7b3': { name: 'approve', args: ['address', 'uint'] },
  '39509351': { name: 'increaseAllowance', args: ['address', 'uint'] },
  '23b872dd': { name: 'transferFrom', args: ['address', 'address', 'uint'] },
  a22cb465: { name: 'setApprovalForAll', args: ['address', 'bool'] },
};

/** Allowances this high are what sites send for "unlimited". */
const UNLIMITED = 1n << 255n;

export function selectorOf(data: string): string | null {
  return /^0x[0-9a-fA-F]{8}/.test(data) ? data.slice(0, 10).toLowerCase() : null;
}

export function decodeKnownCall(data: string): KnownCall | null {
  const selector = selectorOf(data);
  if (!selector) return null;
  const sig = SIGNATURES[selector.slice(2)];
  if (!sig) return null;
  const body = data.slice(10);
  if (body.length !== sig.args.length * 64 || !/^[0-9a-fA-F]*$/.test(body)) return null;
  const values: (string | bigint | boolean)[] = [];
  for (let i = 0; i < sig.args.length; i++) {
    const w = body.slice(i * 64, i * 64 + 64);
    const n = BigInt('0x' + w);
    if (sig.args[i] === 'address') {
      if (n >> 160n !== 0n) return null;
      values.push(toChecksumAddress(w.slice(24)));
    } else if (sig.args[i] === 'bool') {
      if (n > 1n) return null;
      values.push(n === 1n);
    } else {
      values.push(n);
    }
  }
  const amount = (v: unknown) => (v as bigint).toString();
  switch (sig.name) {
    case 'transfer':
      return { kind: 'transfer', to: values[0] as string, amount: amount(values[1]) };
    case 'approve':
    case 'increaseAllowance':
      return {
        kind: sig.name,
        spender: values[0] as string,
        amount: amount(values[1]),
        unlimited: (values[1] as bigint) >= UNLIMITED,
      };
    case 'transferFrom':
      return {
        kind: 'transferFrom',
        from: values[0] as string,
        to: values[1] as string,
        amount: amount(values[2]),
      };
    case 'setApprovalForAll':
      return {
        kind: 'setApprovalForAll',
        operator: values[0] as string,
        approved: values[1] as boolean,
      };
  }
  return null;
}
