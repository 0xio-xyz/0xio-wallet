import { isOctAddress } from './address';
import { MIN_OU, parseBaseUnits } from './dappTx';

export const DEPLOY_MAX_CODE_BYTES = 512 * 1024;
export const DEPLOY_MAX_PARAMS_CHARS = 64 * 1024;
export const DEPLOY_MAX_OU = 50_000_000n;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function base64DecodedLength(value: string): number | null {
  if (!value || value.length % 4 !== 0 || !BASE64_RE.test(value)) return null;
  const pad = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - pad;
}

/** webcli's size-based deploy fee: 200000 OU plus 1000 OU per started KiB of payload. */
export function deployBaseOu(payloadChars: number): bigint {
  return 200_000n + BigInt(Math.ceil(payloadChars / 1024)) * 1000n;
}

export function parseDeployOu(value: unknown): bigint | null {
  const ou = parseBaseUnits(value);
  if (ou == null || ou < MIN_OU || ou > DEPLOY_MAX_OU) return null;
  return ou;
}

// A lone surrogate has no UTF-8 form, so the node could never rebuild the signed bytes.
function signable(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export interface DeployRequest {
  bytecodeB64: string;
  codeBytes: number;
  constructorParams: string;
  ou: bigint | null;
}

export type DeployRequestResult =
  | { ok: true; request: DeployRequest }
  | { ok: false; error: string };

export function parseDeployRequest(raw: unknown): DeployRequestResult {
  const p = (raw ?? {}) as Record<string, unknown>;
  const bytecode = p.bytecode ?? p.bytecodeB64;
  if (typeof bytecode !== 'string' || !bytecode) {
    return { ok: false, error: 'bytecode (base64) is required' };
  }
  const codeBytes = base64DecodedLength(bytecode);
  if (codeBytes == null || codeBytes === 0) {
    return { ok: false, error: 'bytecode must be base64' };
  }
  if (codeBytes > DEPLOY_MAX_CODE_BYTES) {
    return { ok: false, error: `bytecode is larger than ${DEPLOY_MAX_CODE_BYTES / 1024} KB` };
  }

  let params = '';
  const rawParams = p.params ?? p.constructorParams;
  if (Array.isArray(rawParams)) {
    try {
      params = JSON.stringify(rawParams);
    } catch {
      return { ok: false, error: 'Constructor params are not serialisable' };
    }
  } else if (typeof rawParams === 'string') {
    params = rawParams;
  } else if (rawParams != null) {
    return { ok: false, error: 'Constructor params must be a JSON string or an array' };
  }
  if (params.length > DEPLOY_MAX_PARAMS_CHARS) {
    return { ok: false, error: 'Constructor params are too long' };
  }
  if (params) {
    if (!signable(params)) {
      return { ok: false, error: 'Constructor params hold characters that cannot be signed' };
    }
    try {
      JSON.parse(params);
    } catch {
      return { ok: false, error: 'Constructor params must be valid JSON' };
    }
  }

  let ou: bigint | null = null;
  if (p.ou != null && p.ou !== '') {
    ou = parseDeployOu(p.ou);
    if (ou == null) return { ok: false, error: 'Invalid fee' };
  }

  return { ok: true, request: { bytecodeB64: bytecode, codeBytes, constructorParams: params, ou } };
}

export interface DeployReviewParams {
  codeBytes?: unknown;
  contractAddress?: unknown;
  constructorParams?: unknown;
  ou?: unknown;
}

export function deployReviewError(params: DeployReviewParams | undefined): string | null {
  const p = params ?? {};
  if (typeof p.codeBytes !== 'number' || !Number.isSafeInteger(p.codeBytes) || p.codeBytes <= 0) {
    return 'Invalid contract code';
  }
  if (typeof p.contractAddress !== 'string' || !isOctAddress(p.contractAddress)) {
    return 'No contract address from the node';
  }
  if (parseDeployOu(p.ou) == null) return 'Invalid fee';
  if (p.constructorParams != null && typeof p.constructorParams !== 'string') {
    return 'Invalid constructor params';
  }
  return null;
}
