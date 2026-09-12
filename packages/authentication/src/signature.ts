import { Keypair, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

export interface SignatureInput {
  publicKey: string;
  /** The exact message bytes that were signed. */
  message: string;
  /** Signature encoded as hex or base64. */
  signature: string;
}

function decodeSignature(signature: string): Buffer | null {
  const hex = signature.replace(/\s+/g, '');
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0 && hex.length >= 128) {
    try {
      return Buffer.from(hex, 'hex');
    } catch {
      /* fall through */
    }
  }
  try {
    return Buffer.from(signature, 'base64');
  } catch {
    return null;
  }
}

/**
 * Verify an Ed25519 signature produced by a Stellar wallet over the given
 * message. Accepts hex or base64 signature encodings.
 */
export function verifyMessageSignature({ publicKey, message, signature }: SignatureInput): boolean {
  try {
    const keypair = Keypair.fromPublicKey(publicKey);
    const sig = decodeSignature(signature);
    if (!sig) {
      return false;
    }
    return keypair.verify(Buffer.from(message, 'utf8'), sig);
  } catch {
    return false;
  }
}

/**
 * Freighter's `signMessage` signs the hex-decoded bytes when the message is
 * valid hex, otherwise the raw UTF-8 bytes. Verify both interpretations.
 */
export function verifyFreighterMessageSignature(input: SignatureInput): boolean {
  if (verifyMessageSignature(input)) {
    return true;
  }
  if (/^[0-9a-fA-F]+$/.test(input.message) && input.message.length % 2 === 0) {
    return verifyMessageSignature({
      ...input,
      message: Buffer.from(input.message, 'hex').toString('utf8'),
    });
  }
  return false;
}

type DecoratedSignatureLike = {
  hint(): Buffer;
  signature(): Buffer;
};

/**
 * xdr envelope shape varies across @stellar/stellar-base versions (flat
 * `signatures()` on old versions, `v0()/v1()/feeBump()` variants on newer
 * ones). Duck-type through the union so this keeps compiling and working.
 */
type EnvelopeLike = {
  signatures?: () => DecoratedSignatureLike[];
  v0?: () => { signatures(): DecoratedSignatureLike[] };
  v1?: () => { signatures(): DecoratedSignatureLike[] };
  feeBump?: () => { signatures(): DecoratedSignatureLike[] };
};

function envelopeSignatures(env: EnvelopeLike): DecoratedSignatureLike[] {
  // The envelope shape varies across @stellar/stellar-base versions (a flat
  // `signatures()` on older ones, `v0()/v1()/feeBump()` union accessors on
  // newer ones). Two traps to avoid:
  //   1. union accessors THROW when their arm is not set (`xdr` raises
  //      "<arm> not set") instead of returning undefined, and
  //   2. they read instance state through `this`, so they must be called
  //      bound to the envelope — extracting the method and calling it
  //      separately throws a TypeError.
  const sigsOf = (inner: { signatures(): DecoratedSignatureLike[] } | undefined) => {
    if (!inner) {
      return [];
    }
    try {
      return inner.signatures();
    } catch {
      return [];
    }
  };

  try {
    const flat = env.signatures ? env.signatures() : [];
    if (flat.length > 0) {
      return flat;
    }
  } catch {
    /* not the flat envelope variant */
  }

  for (const variant of ['v0', 'v1', 'feeBump'] as const) {
    try {
      const accessor = env[variant];
      const sigs = accessor ? sigsOf(accessor.call(env)) : [];
      if (sigs.length > 0) {
        return sigs;
      }
    } catch {
      /* arm not set — try the next envelope variant */
    }
  }
  return [];
}

/**
 * Verify that a signed transaction envelope carries a valid signature from
 * `expectedPublicKey`.
 *
 * For each attached decorated signature this checks both:
 *
 *  1. the 4-byte hint equals the last 4 bytes of the signer's raw ed25519 key
 *     (a cheap filter — it is *not* proof: the hint space is tiny and anyone
 *     can pick it deliberately), and
 *  2. the signature itself verifies against the transaction hash for the given
 *     network passphrase.
 *
 * The second check is what actually proves ownership, which is why
 * `networkPassphrase` is required — without it the transaction hash (and
 * therefore the signed message) cannot be reconstructed.
 */
export function verifySignedXdrOwner(
  signedXdr: string,
  expectedPublicKey: string,
  networkPassphrase: string,
): boolean {
  try {
    const keypair = Keypair.fromPublicKey(expectedPublicKey);
    // The hint is the last 4 bytes of the RAW ed25519 key — not the last 4
    // characters of the StrKey (base32) public key, which encode the trailing
    // bits of the key plus the CRC16 checksum.
    const expectedHint = Buffer.from(keypair.rawPublicKey()).subarray(-4).toString('hex');
    const envelope = xdr.TransactionEnvelope.fromXDR(
      signedXdr,
      'base64',
    ) as unknown as EnvelopeLike;
    const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase) as Transaction;
    const txHash = tx.hash();
    for (const signature of envelopeSignatures(envelope)) {
      if (signature.hint().toString('hex') !== expectedHint) {
        continue;
      }
      if (keypair.verify(txHash, signature.signature())) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
