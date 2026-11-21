import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('src/i18n/react', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => String(opts?.defaultValue ?? key),
  }),
}));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,' } }));

import SecretSheet from 'src/features/settings/components/SecretSheet';

const WORDS = ['one', 'two', 'three'];

const show = async (onBackedUp?: () => void) => {
  const onCopy = vi.fn(async () => true);
  await act(async () => {
    render(
      <SecretSheet
        kind="mnemonic"
        value={WORDS.join(' ')}
        words={WORDS}
        onClose={() => {}}
        onCopy={onCopy}
        onBackedUp={onBackedUp}
      />
    );
  });
  return onCopy;
};

const press = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};

describe('recovery phrase sheet in Settings', () => {
  it('opens hidden, reveals on one click and stays shown', async () => {
    await show();
    expect(screen.queryByText('two')).toBeNull();
    await press('security.reveal');
    expect(screen.getByText('two')).toBeTruthy();
  });

  it('turns Reveal into Copy and says Copied', async () => {
    const onCopy = await show();
    await press('security.reveal');
    await press('security.copyPhrase');
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'toast.copied' })).toBeTruthy();
  });

  it('does not ask to confirm a phrase that is already backed up', async () => {
    await show();
    await press('security.reveal');
    expect(screen.queryByRole('button', { name: 'I have written it down' })).toBeNull();
  });

  it('asks to confirm only while a re-backup is open', async () => {
    const onBackedUp = vi.fn();
    await show(onBackedUp);
    await press('security.reveal');
    await press('I have written it down');
    expect(onBackedUp).toHaveBeenCalledTimes(1);
  });
});
