import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { erc1155SafeTransferData, erc721SafeTransferData } from '../tx';
import { nftTransferData } from '../nfts';
import { INTERFACE_IDS, SELECTORS } from '../detect';

const selector = (sig: string) => bytesToHex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);

const FROM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const TO = '0x1111111111111111111111111111111111111111';

describe('NFT transfer calldata', () => {
  it('uses the safeTransferFrom selectors', () => {
    expect(selector('safeTransferFrom(address,address,uint256)')).toBe('42842e0e');
    expect(selector('safeTransferFrom(address,address,uint256,uint256,bytes)')).toBe('f242432a');
  });

  it('encodes ERC-721 safeTransferFrom(from, to, id)', () => {
    expect(erc721SafeTransferData(FROM, TO, 1n)).toBe(
      '0x42842e0e' +
        '0000000000000000000000009858effd232b4033e47d90003d41ec34ecaeda94' +
        '0000000000000000000000001111111111111111111111111111111111111111' +
        '0000000000000000000000000000000000000000000000000000000000000001'
    );
  });

  it('encodes ERC-1155 safeTransferFrom(from, to, id, amount, "")', () => {
    expect(erc1155SafeTransferData(FROM, TO, 0xabcn, 3n)).toBe(
      '0xf242432a' +
        '0000000000000000000000009858effd232b4033e47d90003d41ec34ecaeda94' +
        '0000000000000000000000001111111111111111111111111111111111111111' +
        '0000000000000000000000000000000000000000000000000000000000000abc' +
        '0000000000000000000000000000000000000000000000000000000000000003' +
        '00000000000000000000000000000000000000000000000000000000000000a0' +
        '0000000000000000000000000000000000000000000000000000000000000000'
    );
  });

  it('encodes a uint256 token id at full width', () => {
    const max = (1n << 256n) - 1n;
    expect(erc721SafeTransferData(FROM, TO, max).slice(-64)).toBe('f'.repeat(64));
  });

  it('refuses bad addresses, ids and amounts', () => {
    expect(() => erc721SafeTransferData('0x123', TO, 1n)).toThrow();
    expect(() => erc721SafeTransferData(FROM, TO, -1n)).toThrow();
    expect(() => erc721SafeTransferData(FROM, TO, 1n << 256n)).toThrow();
    expect(() => erc1155SafeTransferData(FROM, TO, 1n, 0n)).toThrow();
  });

  it('picks the call by standard; an ERC-721 always moves one', () => {
    expect(nftTransferData({ standard: 'ERC-721', tokenId: '7' }, FROM, TO, 5n)).toBe(
      erc721SafeTransferData(FROM, TO, 7n)
    );
    expect(nftTransferData({ standard: 'ERC-1155', tokenId: '7' }, FROM, TO, 5n)).toBe(
      erc1155SafeTransferData(FROM, TO, 7n, 5n)
    );
  });

  it('reads with the standard selectors and ERC-165 ids', () => {
    expect(SELECTORS.supportsInterface.slice(2)).toBe(selector('supportsInterface(bytes4)'));
    expect(SELECTORS.ownerOf.slice(2)).toBe(selector('ownerOf(uint256)'));
    expect(SELECTORS.balanceOf1155.slice(2)).toBe(selector('balanceOf(address,uint256)'));
    expect(SELECTORS.tokenURI.slice(2)).toBe(selector('tokenURI(uint256)'));
    expect(SELECTORS.uri.slice(2)).toBe(selector('uri(uint256)'));
    expect(SELECTORS.name.slice(2)).toBe(selector('name()'));
    expect(SELECTORS.symbol.slice(2)).toBe(selector('symbol()'));
    expect(SELECTORS.decimals.slice(2)).toBe(selector('decimals()'));
    expect(INTERFACE_IDS['ERC-721']).toBe('80ac58cd');
    expect(INTERFACE_IDS['ERC-1155']).toBe('d9b67a26');
  });

  it('matches the ERC-165 ids computed from each standard', () => {
    const xor = (sigs: string[]) =>
      sigs
        .map((s) => parseInt(selector(s), 16))
        .reduce((a, b) => (a ^ b) >>> 0, 0)
        .toString(16)
        .padStart(8, '0');
    expect(
      xor([
        'balanceOf(address)',
        'ownerOf(uint256)',
        'approve(address,uint256)',
        'getApproved(uint256)',
        'setApprovalForAll(address,bool)',
        'isApprovedForAll(address,address)',
        'transferFrom(address,address,uint256)',
        'safeTransferFrom(address,address,uint256)',
        'safeTransferFrom(address,address,uint256,bytes)',
      ])
    ).toBe(INTERFACE_IDS['ERC-721']);
    expect(
      xor([
        'safeTransferFrom(address,address,uint256,uint256,bytes)',
        'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)',
        'balanceOf(address,uint256)',
        'balanceOfBatch(address[],uint256[])',
        'setApprovalForAll(address,bool)',
        'isApprovedForAll(address,address)',
      ])
    ).toBe(INTERFACE_IDS['ERC-1155']);
  });
});
