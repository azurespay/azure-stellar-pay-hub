import { describe, expect, it } from '@jest/globals';
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import {
  verifyMessageSignature,
  verifyFreighterMessageSignature,
  verifySignedXdrOwner,
} from './signature';

const VALID_KEY = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/** Build a real, signed (v1 envelope) payment transaction for testnet. */
function signedPayment(signer: Keypair, other: Keypair): string {
  const tx = new TransactionBuilder(new Account(signer.publicKey(), '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: other.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(30)
    .build();
  tx.sign(signer);
  return tx.toEnvelope().toXDR('base64');
}

describe('signature verification', () => {
  describe('verifyMessageSignature', () => {
    it('rejects invalid public keys', () => {
      expect(
        verifyMessageSignature({
          publicKey: 'not-a-key',
          message: 'hello',
          signature: 'a'.repeat(128),
        }),
      ).toBe(false);
    });

    it('rejects empty signatures', () => {
      expect(
        verifyMessageSignature({
          publicKey: VALID_KEY,
          message: 'hello',
          signature: '',
        }),
      ).toBe(false);
    });

    it('rejects short hex signatures', () => {
      expect(
        verifyMessageSignature({
          publicKey: VALID_KEY,
          message: 'hello',
          signature: 'aabbcc',
        }),
      ).toBe(false);
    });

    it('rejects invalid base64 signatures', () => {
      expect(
        verifyMessageSignature({
          publicKey: VALID_KEY,
          message: 'hello',
          signature: '!!!invalid!!!',
        }),
      ).toBe(false);
    });
  });

  describe('verifyFreighterMessageSignature', () => {
    it('rejects a tampered challenge with wrong public key', () => {
      const fakeKey = 'GB5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
      const result = verifyFreighterMessageSignature({
        publicKey: fakeKey,
        message: 'stellar-pay:auth:' + fakeKey + ':nonce123',
        signature: 'a'.repeat(128),
      });
      expect(result).toBe(false);
    });

    it('attempts hex decode when message is valid hex', () => {
      const hexMessage = '7465737400000000000000000000000000000000000000000000000000000000';
      const result = verifyFreighterMessageSignature({
        publicKey: VALID_KEY,
        message: hexMessage,
        signature: 'a'.repeat(128),
      });
      // Should reject signature but not crash.
      expect(result).toBe(false);
    });
  });

  describe('verifySignedXdrOwner', () => {
    const signer = Keypair.fromSecret(Keypair.random().secret());
    const other = Keypair.random();
    const xdrStr = signedPayment(signer, other);

    it('accepts an envelope signed by the expected account', () => {
      expect(verifySignedXdrOwner(xdrStr, signer.publicKey(), Networks.TESTNET)).toBe(true);
    });

    it('rejects a different account that did not sign', () => {
      // The unsigned key is a valid G… address; only the *signature* check can
      // tell it apart from the signer, so this caught the previous hint-only
      // comparison (which also compared against the wrong bytes).
      expect(verifySignedXdrOwner(xdrStr, other.publicKey(), Networks.TESTNET)).toBe(false);
    });

    it('rejects an envelope verified against the wrong network passphrase', () => {
      expect(verifySignedXdrOwner(xdrStr, signer.publicKey(), Networks.PUBLIC)).toBe(false);
    });

    it('rejects malformed XDR', () => {
      expect(verifySignedXdrOwner('not-valid-xdr', VALID_KEY, Networks.TESTNET)).toBe(false);
    });

    it('rejects empty XDR', () => {
      expect(verifySignedXdrOwner('', VALID_KEY, Networks.TESTNET)).toBe(false);
    });
  });
});
