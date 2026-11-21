import i18n, { type TFunction } from 'src/i18n/core';
import { onsContract, resolveWallet } from 'src/services/names/ons';
import type { NetworkPin } from 'src/services/network/txScope';
import { ONS_SUFFIX, isNameInput, normalizeName, type OnsFailure } from 'src/utils/octra/ons';
import { PlainError } from 'src/utils/plainError';

export interface NamedRecipient {
  name: string;
  address: string;
}

export const nameLabel = (name: string) => `${name}${ONS_SUFFIX}`;

export const isNameEntry = (text: string, networkId: string) =>
  !!onsContract(networkId) && isNameInput(text);

export const typedNameLabel = (text: string) => {
  const parsed = normalizeName(text);
  return parsed.ok ? nameLabel(parsed.name) : text.trim();
};

export const isRetryable = (reason: OnsFailure) =>
  reason === 'busy' || reason === 'unavailable' || reason === 'bad_reply';

export const nameReasonText = (t: TFunction, reason: OnsFailure): string => {
  switch (reason) {
    case 'not_registered':
      return t('ons.notRegistered', { defaultValue: 'This name is not registered' });
    case 'not_set':
      return t('ons.noWallet', { defaultValue: 'This name has no wallet set' });
    case 'points_to_circle':
      return t('ons.pointsToCircle', { defaultValue: 'This name points to a Circle' });
    case 'expired':
      return t('ons.expired', { defaultValue: 'This name has expired' });
    case 'reserved':
      return t('ons.reserved', { defaultValue: 'This name is reserved' });
    case 'invalid':
      return t('ons.invalid', { defaultValue: 'Not a valid name' });
    case 'service_changed':
      return t('ons.recheck', {
        defaultValue: 'The name could not be checked. Review the send again.',
      });
    case 'not_available':
      return t('ons.notAvailable', { defaultValue: 'Names are not available on this network' });
    case 'busy':
      return t('ons.busy', { defaultValue: 'The node is busy' });
    default:
      return t('ons.unreachable', { defaultValue: 'Could not reach the node' });
  }
};

export type NameCheck =
  | { kind: 'same'; address: string }
  | { kind: 'changed'; was: string; now: string }
  | { kind: 'stopped'; reason: OnsFailure };

export async function checkNamedRecipient(
  picked: NamedRecipient,
  opts: { at: NetworkPin; fresh: boolean }
): Promise<NameCheck> {
  let read: Awaited<ReturnType<typeof resolveWallet>>;
  try {
    read = await resolveWallet(picked.name, opts);
  } catch {
    return { kind: 'stopped', reason: 'unavailable' };
  }
  if (read.ok !== true) return { kind: 'stopped', reason: read.reason };
  return read.address === picked.address
    ? { kind: 'same', address: read.address }
    : { kind: 'changed', was: picked.address, now: read.address };
}

export function assertNamedSend(to: string, confirmedTo: string | null): void {
  if (confirmedTo === null || confirmedTo !== to) {
    throw new PlainError(
      i18n.t('ons.recheck', {
        defaultValue: 'The name could not be checked. Review the send again.',
      })
    );
  }
}
