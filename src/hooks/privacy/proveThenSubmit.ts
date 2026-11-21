/**
 * The order of a private op: the minutes of proof work first, then the nonce, then sign and
 * send. The nonce goes back when signing fails or the node refuses the tx outright; a
 * send that may have reached the node keeps it.
 */
export async function proveThenSubmit<P, S, R>(steps: {
  prove: () => Promise<P>;
  takeNonce: () => Promise<number>;
  releaseNonce: (nonce: number) => void;
  sign: (proof: P, nonce: number) => Promise<S>;
  send: (signed: S) => Promise<R>;
  refused: (result: R) => boolean;
}): Promise<{ result: R; nonce: number }> {
  const proof = await steps.prove();
  const nonce = await steps.takeNonce();
  let signed: S;
  try {
    signed = await steps.sign(proof, nonce);
  } catch (e) {
    steps.releaseNonce(nonce);
    throw e;
  }
  const result = await steps.send(signed);
  if (steps.refused(result)) steps.releaseNonce(nonce);
  return { result, nonce };
}
