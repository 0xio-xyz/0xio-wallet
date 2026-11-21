import { describe, expect, it, vi } from 'vitest';
import { proveThenSubmit } from 'src/hooks/privacy/proveThenSubmit';

const steps = (over: Partial<Parameters<typeof proveThenSubmit>[0]> = {}) => {
  const order: string[] = [];
  const s = {
    prove: vi.fn(async () => {
      order.push('prove');
      return 'proof';
    }),
    takeNonce: vi.fn(async () => {
      order.push('nonce');
      return 7;
    }),
    releaseNonce: vi.fn(),
    sign: vi.fn(async () => {
      order.push('sign');
      return 'signed';
    }),
    send: vi.fn(async () => {
      order.push('send');
      return { success: true } as { success: boolean; errorType?: string };
    }),
    refused: (r: { success: boolean; errorType?: string }) => !r.success && !!r.errorType,
    ...over,
  };
  return { s, order };
};

describe('private op order', () => {
  it('takes the nonce only after the proofs', async () => {
    const { s, order } = steps();
    const out = await proveThenSubmit(s as never);
    expect(order).toEqual(['prove', 'nonce', 'sign', 'send']);
    expect(out.nonce).toBe(7);
    expect(s.releaseNonce).not.toHaveBeenCalled();
  });

  it('never reserves a nonce when a proof throws', async () => {
    const { s } = steps({
      prove: vi.fn(async () => {
        throw new Error('proof failed');
      }),
    });
    await expect(proveThenSubmit(s as never)).rejects.toThrow('proof failed');
    expect(s.takeNonce).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
  });

  it('gives the nonce back when signing fails before submit', async () => {
    const { s } = steps({
      sign: vi.fn(async () => {
        throw new Error('budget');
      }),
    });
    await expect(proveThenSubmit(s as never)).rejects.toThrow('budget');
    expect(s.releaseNonce).toHaveBeenCalledWith(7);
    expect(s.send).not.toHaveBeenCalled();
  });

  it('gives the nonce back on a refusal but keeps it on an ambiguous failure', async () => {
    const refused = steps({ send: vi.fn(async () => ({ success: false, errorType: 'x' })) });
    await proveThenSubmit(refused.s as never);
    expect(refused.s.releaseNonce).toHaveBeenCalledWith(7);

    const ambiguous = steps({ send: vi.fn(async () => ({ success: false })) });
    await proveThenSubmit(ambiguous.s as never);
    expect(ambiguous.s.releaseNonce).not.toHaveBeenCalled();
  });
});
