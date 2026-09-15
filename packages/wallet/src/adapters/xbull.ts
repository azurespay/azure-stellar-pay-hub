import { ProtocolError, UserRejectionError, WalletError, WalletTimeoutError } from '../errors';
import type { NetworkId, WalletAdapter } from '../types';

// The xBull SDK keeps evolving its method surface; duck-typing keeps this
// adapter working across versions. See packages/wallet/README.md.
type XBullBridge = {
  connect: () => Promise<string>;
  getPublicKey?: () => Promise<string>;
  sign: (
    input: string | { xdr: string; networkPassphrase?: string; publicKey?: string },
  ) => Promise<string>;
  signXdr?: (xdr: string) => Promise<string>;
  signMessage?: (message: string) => Promise<string>;
  close?: () => Promise<void>;
  closeConnections?: () => Promise<void>;
};

function handleXBullError(err: unknown): WalletError {
  if (err instanceof WalletError) {
    return err;
  }
  const errorObj = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
  const rawMsg = typeof err === 'string' ? err : String(errorObj.message ?? err ?? '');
  const lowerMsg = rawMsg.toLowerCase();

  if (
    lowerMsg.includes('reject') ||
    lowerMsg.includes('closed') ||
    lowerMsg.includes('cancel') ||
    lowerMsg.includes('declined') ||
    lowerMsg.includes('denied')
  ) {
    return new UserRejectionError(rawMsg || 'xBull request was rejected by the user');
  }

  if (lowerMsg.includes('timeout') || lowerMsg.includes('timed out')) {
    return new WalletTimeoutError(rawMsg || 'xBull request timed out. Please try again');
  }

  return new ProtocolError(rawMsg || 'xBull wallet protocol or communication error');
}

export class XBullAdapter implements WalletAdapter {
  readonly id = 'XBULL' as const;

  private bridge: XBullBridge | null = null;

  private getBridge(): XBullBridge {
    if (this.bridge) {
      return this.bridge;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@creit.tech/xbull-wallet-connect') as unknown as Record<string, unknown>;
    const Ctor =
      (mod.default as unknown) ?? (mod.XBullWalletConnect as unknown) ?? (mod as unknown);
    if (typeof Ctor !== 'function') {
      throw new Error('xBull wallet SDK could not be loaded');
    }
  }

  async requestAccess(): Promise<string> {
    try {
      const bridge = this.getBridge();
      const publicKey = await bridge.connect();
      if (!publicKey) {
        throw new UserRejectionError('xBull connection was rejected by the user');
      }
      return publicKey;
    } catch (err) {
      throw handleXBullError(err);
    }
  }

  async isConnected(): Promise<boolean> {
    try {
      const bridge = this.getBridge();
      if (bridge.getPublicKey) {
        return Boolean(await bridge.getPublicKey());
      }
      return true;
    } catch {
      return false;
    }
  }

  async getPublicKey(): Promise<string> {
    try {
      const bridge = this.getBridge();
      if (bridge.getPublicKey) {
        const key = await bridge.getPublicKey();
        if (!key) {
          throw new UserRejectionError('xBull public key request was rejected by the user');
        }
        return key;
      }
      return this.requestAccess();
    } catch (err) {
      throw handleXBullError(err);
    }
  }

  async signTx(xdr: string): Promise<string> {
    try {
      const bridge = this.getBridge();
      try {
        const signed = await bridge.sign({ xdr });
        if (!signed) {
          throw new UserRejectionError('xBull transaction signing was rejected by the user');
        }
        return signed;
      } catch (innerErr) {
        if (innerErr instanceof WalletError) {
          throw innerErr;
        }
        if (bridge.signXdr) {
          const signedFallback = await bridge.signXdr(xdr);
          if (!signedFallback) {
            throw new UserRejectionError('xBull transaction signing was rejected by the user');
          }
          return signedFallback;
        }
        throw innerErr;
      }
    } catch (err) {
      throw handleXBullError(err);
    }
  }

  async signMessage(message: string): Promise<string> {
    try {
      const bridge = this.getBridge();
      if (!bridge.signMessage) {
        throw new ProtocolError(
          'xBull message signing is not supported by the installed SDK version; use Freighter or Albedo for wallet auth',
        );
      }
      const result = await bridge.signMessage(message);
      const signature =
        typeof result === 'string' ? result : (result as { signedMessage?: string })?.signedMessage;
      if (!signature) {
        throw new UserRejectionError('xBull message signing was rejected by the user');
      }
      return signature;
    } catch (err) {
      throw handleXBullError(err);
    }
  }

  async getNetworkId(): Promise<NetworkId> {
    // xBull does not expose network detection; the app declares the target network.
    return 'unknown';
  }

  async disconnect(): Promise<void> {
    const bridge = this.bridge;
    if (bridge?.close) {
      await bridge.close();
    } else if (bridge?.closeConnections) {
      await bridge.closeConnections();
    }
    this.bridge = null;
  }
}
