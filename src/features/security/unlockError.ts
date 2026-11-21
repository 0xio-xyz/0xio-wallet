import type { TFunction } from 'src/i18n/core';
import { LockedOutError, WrongPasswordError } from 'src/services/crypto/PasswordManager';

export function unlockErrorMessage(err: unknown, t: TFunction): string {
  if (err instanceof LockedOutError) return t('lock.lockedFor', { seconds: err.seconds });
  if (err instanceof WrongPasswordError) return t('approval.invalidPassword');
  return t('lock.unlockFailed', { defaultValue: 'Could not unlock. Try again.' });
}
