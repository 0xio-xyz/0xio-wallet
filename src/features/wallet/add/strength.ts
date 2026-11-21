import { getPasswordStrength } from 'src/lib/sanitize';

export const MIN_PASSWORD = 8;

const LEVELS = ['weak', 'fair', 'good', 'strong'] as const;

export const strengthBars = (password: string): number =>
  password.length < MIN_PASSWORD
    ? 0
    : LEVELS.indexOf(getPasswordStrength(password).level as (typeof LEVELS)[number]) + 1;
