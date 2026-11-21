import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageBlobUrl, peekImageBlobUrl } from 'src/features/wallet/nft/piece/pieceData';

afterEach(() => vi.unstubAllGlobals());

describe('NFT image reuse', () => {
  it('hands a remounted tile the image it already made, at once', async () => {
    const src = 'https://example.test/art.gif';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['x']) }))
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:made-1');
    expect(peekImageBlobUrl(src)).toBeNull();
    const made = await imageBlobUrl(src);
    expect(peekImageBlobUrl(src)).toBe(made);
    expect(await imageBlobUrl(src)).toBe(made);
  });

  it('passes inline images through and knows nothing for no image', () => {
    expect(peekImageBlobUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(peekImageBlobUrl(null)).toBeNull();
  });
});
