import type { ReactNode } from 'react';
import { Mascot } from 'src/shared/ui/Mascot';

export type PrivacyOpsState =
  | 'checking'
  | 'legacy'
  | 'held'
  | 'migrate'
  | 'upgrading'
  | 'migrating'
  | 'ready';

export interface PrivacyOpsInput {
  upgrading: boolean;
  migrating: boolean;
  legacy: boolean;
  heldNoMigration: boolean;
  needsMigrate: boolean;
  checking?: boolean;
}

export function resolvePrivacyOpsState(i: PrivacyOpsInput): PrivacyOpsState {
  if (i.upgrading) return 'upgrading';
  if (i.migrating) return 'migrating';
  if (i.legacy) return 'legacy';
  if (i.heldNoMigration) return 'held';
  if (i.checking) return 'checking';
  if (i.needsMigrate) return 'migrate';
  return 'ready';
}

export function outranksKeyGate(state: PrivacyOpsState): boolean {
  return state === 'upgrading' || state === 'migrating' || state === 'legacy' || state === 'held';
}

const BASE = {
  width: '100%',
  height: '44px',
  borderRadius: '10px',
  fontSize: '13px',
  fontWeight: 600,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
} as const;

const NEUTRAL = {
  ...BASE,
  background: 'var(--bg-1)',
  border: 'none',
  color: 'var(--fg-2)',
  cursor: 'not-allowed',
} as const;

const PRIMARY = {
  ...BASE,
  background: 'var(--color-accent)',
  border: 'none',
  color: 'var(--accent-fg)',
} as const;

interface Props {
  state: PrivacyOpsState;
  onMigrate: () => void;
  children: ReactNode;
}

export default function PrivacyOpsCta({ state, onMigrate, children }: Props) {
  if (state === 'ready') return <>{children}</>;

  if (state === 'checking') {
    return (
      <button disabled style={{ ...PRIMARY, opacity: 0.5, cursor: 'wait' }}>
        <Mascot mood="loading" size={20} hole="var(--color-accent)" className="text-current!" />
        Checking balance…
      </button>
    );
  }

  if (state === 'upgrading' || state === 'migrating') {
    return (
      <button disabled style={{ ...PRIMARY, opacity: 0.6, cursor: 'wait' }}>
        <Mascot mood="encrypt" size={20} hole="var(--color-accent)" className="text-current!" />
        {state === 'upgrading' ? 'Upgrade in progress…' : 'Migrating balance…'}
      </button>
    );
  }

  if (state === 'legacy') {
    return (
      <button
        disabled
        style={NEUTRAL}
        title="This encrypted balance was written by an earlier wallet version. It stays readable, but private operations are paused until it can be upgraded."
      >
        Balance needs upgrade
      </button>
    );
  }

  if (state === 'held') {
    return (
      <button
        disabled
        style={NEUTRAL}
        title="The node has this balance queued for a network migration and refuses key updates until then. Nothing is lost."
      >
        Awaiting network migration
      </button>
    );
  }

  return (
    <button onClick={onMigrate} style={PRIMARY}>
      Migrate balance
    </button>
  );
}
