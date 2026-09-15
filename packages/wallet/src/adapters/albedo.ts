import { ProtocolError, UserRejectionError, WalletError, WalletTimeoutError } from '../errors';
import type { NetworkId, WalletAdapter } from '../types';

// @albedo-link/intent API (v0.13): retrievePublicKey(), signTransaction({xdr, network}),
// signBlob({blob, network}). Networks: 'test' | 'public'.
type AlbedoApi = {
  retrievePublicKey: (opts?: Record<string, unknown>) => Promise<string | { publicKey: string }>;
  signTransaction: (opts: {
    xdr: string;
    network?: 'test' | 'public';
  }) => Promise<string | { signedXdr: string }>;
  signBlob: (opts: {
    blob: string;
    network?: 'test' | 'public';
  }) => Promise<string | { signature: string }>;
};

function handleAlbedoError(err: unknown): WalletError {
  if (err instanceof WalletError) {
    return err;
  }
  const errorObj = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
  const rawMsg = typeof err === 'string' ? err : String(errorObj.message ?? err ?? '');
  const lowerMsg = rawMsg.toLowerCase();

  if (
    errorObj.code === -1 ||
    errorObj.closed === true ||
    lowerMsg.includes('reject') ||
    lowerMsg.includes('closed') ||
    lowerMsg.includes('cancel') ||
    lowerMsg.includes('denied')
  ) {
    return new UserRejectionError(rawMsg || 'Albedo request was rejected by the user');
  }

  if (lowerMsg.includes('timeout') || lowerMsg.includes('timed out')) {
    return new WalletTimeoutError(rawMsg || 'Albedo request timed out. Please try again');
  }

  return new ProtocolError(rawMsg || 'Albedo wallet protocol or communication error');
}

export class AlbedoAdapter implements WalletAdapter {
  readonly id = 'ALBEDO' as const;

  private api(): AlbedoApi {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@albedo-link/intent') as AlbedoApi;
  }

  private albedoNetwork(network: NetworkId): 'test' | 'public' {
    return network === 'public' ? 'public' : 'test';
  }

  async requestAccess(): Promise<string> {
    try {
      const result = await this.api().retrievePublicKey();
      const publicKey = typeof result === 'string' ? result : result?.publicKey;
      if (!publicKey) {
        throw new UserRejectionError('Albedo connection was rejected by the user');
      }
      return publicKey;
    } catch (err) {
      throw handleAlbedoError(err);
    }
  }

  async isConnected(): Promise<boolean> {
    try {
      return Boolean(await this.requestAccess());
    } catch {
      return false;
    }
  }

  async getPublicKey(): Promise<string> {
    return this.requestAccess();
  }

  async signTx(xdr: string): Promise<string> {
    try {
      const result = await this.api().signTransaction({
        xdr,
        network: this.albedoNetwork(await this.getNetworkId()),
      });
      const signedXdr = typeof result === 'string' ? result : result?.signedXdr;
      if (!signedXdr) {
        throw new UserRejectionError('Albedo transaction signing was rejected by the user');
      }
      return signedXdr;
    } catch (err) {
      throw handleAlbedoError(err);
    }
  }

  async signMessage(message: string): Promise<string> {
    try {
      // Albedo's signBlob signs the base64-encoded payload; we pass the UTF-8
      // message base64-encoded so the resulting signature covers the message bytes.
      const blob = btoa(unescape(encodeURIComponent(message)));
      const result = await this.api().signBlob({
        blob,
        network: this.albedoNetwork(await this.getNetworkId()),
      });
      const signature = typeof result === 'string' ? result : result?.signature;
      if (!signature) {
        throw new UserRejectionError('Albedo message signing was rejected by the user');
      }
      return signature;
    } catch (err) {
      throw handleAlbedoError(err);
    }
  }

  async getNetworkId(): Promise<NetworkId> {
    return 'unknown';
  }
}
