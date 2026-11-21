import { privacyNetworkService } from '../network/NetworkService';
import { pvacManager } from '../pvac/PvacManager';
import {
  computeClaimPub,
  computeClaimSecret,
  computePrivateTag,
  ecdhSharedSecret,
  encryptPrivateAmount,
  generateEphemeralKeypair,
} from '../crypto/PrivateCrypto';
import { base64ToBytes, bytesToBase64, bytesToHex } from 'src/lib/encoding';
import type { TxScope } from '../network/txScope';

/**
 * The encrypted_data of a stealth send (webcli /api/stealth/send, version 5): the recipient finds
 * it by scanning stealth outputs on any network. The PVAC engine must be ready for this key.
 */
export async function buildStealthSendPayload(p: {
  from: string;
  to: string;
  privateKey: string;
  publicKey: string;
  amountRaw: number;
  scope: TxScope;
  policy: number;
}): Promise<string> {
  const [viewPubB64, ebal] = await Promise.all([
    privacyNetworkService.getViewPubkey(p.to),
    privacyNetworkService.getEncryptedBalanceDevnet(p.from, p.privateKey, p.publicKey),
  ]);
  if (!viewPubB64) {
    throw new Error('Recipient has no view pubkey registered. They need to register first.');
  }
  if (!ebal.success) throw new Error(ebal.error || 'Failed to fetch encrypted balance');
  if (!ebal.cipher) throw new Error('No encrypted balance to send from');
  if (ebal.encryptedRaw < p.amountRaw) throw new Error('Insufficient encrypted balance');

  await pvacManager.verifyRegistration(
    p.from,
    p.privateKey,
    p.publicKey,
    privacyNetworkService,
    false,
    p.scope.networkId
  );

  const { ephSk, ephPub } = generateEphemeralKeypair();
  const shared = await ecdhSharedSecret(ephSk, base64ToBytes(viewPubB64));
  const [tag, claimSecret] = await Promise.all([
    computePrivateTag(shared),
    computeClaimSecret(shared),
  ]);
  const claimPub = await computeClaimPub(claimSecret, p.to);

  const rBlind = crypto.getRandomValues(new Uint8Array(32));
  const encAmount = await encryptPrivateAmount(shared, p.amountRaw, rBlind);
  const { cipherBytes: ctDelta, commitmentBytes } = await pvacManager.encryptRawAsync(p.amountRaw);
  const currentCt = pvacManager.getCipherBytes(ebal.cipher);
  const newBalanceCt = await pvacManager.ctSubRawAsync(currentCt, ctDelta);
  const newBalance = ebal.encryptedRaw - p.amountRaw;
  const rpDelta = await pvacManager.makeBoundRangeProof(ctDelta, p.amountRaw, p.policy);
  const rpBalance = await pvacManager.makeBoundRangeProof(newBalanceCt, newBalance, p.policy);
  const amountCommitment = await pvacManager.pedersenCommitAsync(p.amountRaw, rBlind);
  const sendZeroProof = await pvacManager.makeBoundProof(ctDelta, p.amountRaw, rBlind, p.policy);

  return JSON.stringify({
    version: 5,
    delta_cipher: pvacManager.encodeCipher(ctDelta),
    commitment: bytesToBase64(commitmentBytes),
    range_proof_delta: rpDelta,
    range_proof_balance: rpBalance,
    eph_pub: bytesToBase64(ephPub),
    stealth_tag: bytesToHex(tag),
    enc_amount: encAmount,
    claim_pub: bytesToHex(claimPub),
    amount_commitment: amountCommitment,
    send_zero_proof: sendZeroProof,
  });
}
