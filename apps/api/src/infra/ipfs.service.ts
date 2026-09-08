import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Content-addressable receipt payload stored on IPFS.
 */
export interface ReceiptPayload {
  schema: 'stellar-pay-receipt-v1';
  transactionId: string;
  transactionHash: string;
  from: string;
  to: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  memo: string | null;
  kind: string;
  network: string;
  settledAt: string;
}

export interface IpfsPinResult {
  cid: string;
  /** Gateway URL — only meaningful when `pinned` is true. */
  url: string;
  provider: string;
  /** True only when a real pinning backend stored the content. */
  pinned: boolean;
}

interface PinOutcome {
  cid: string;
  pinned: boolean;
}

/**
 * IPFS pinning service.
 *
 * Supports three backends selected via `IPFS_PROVIDER`:
 * - `local`  — talks to a local IPFS node's HTTP RPC API  (default: http://127.0.0.1:5001)
 * - `pinata` — Pinata.cloud pinning service
 * - `web3`   — web3.storage (w3up) pinning service
 *
 * When no provider is reachable, a deterministic content-hash CID is still
 * computed (stable, verifiable identifier) but it is reported with
 * `pinned: false` — the content is not actually on IPFS, so no gateway URL is
 * fabricated and callers must not present it as a resolvable receipt.
 */
@Injectable()
export class IpfsService {
  private readonly logger = new Logger(IpfsService.name);
  private readonly gateway: string;
  private readonly provider: string;

  constructor(private readonly config: ConfigService) {
    this.gateway = this.config.get<string>('IPFS_GATEWAY') ?? 'https://ipfs.io/ipfs/';
    this.provider = this.config.get<string>('IPFS_PROVIDER') ?? 'local';
  }

  /**
   * Pin a JSON receipt to IPFS and return the CID + gateway URL.
   * `pinned: false` means no pinning backend stored the content.
   */
  async pinReceipt(payload: ReceiptPayload): Promise<IpfsPinResult> {
    const json = JSON.stringify(payload);
    const { cid, pinned } = await this.pin(json);
    return {
      cid,
      url: pinned ? `${this.gateway.replace(/\/$/, '')}/${cid}` : '',
      provider: this.provider,
      pinned,
    };
  }

  /**
   * Retrieve a pinned receipt by CID (only resolves content actually on IPFS).
   */
  async get(cid: string): Promise<ReceiptPayload | null> {
    try {
      const url = `${this.gateway.replace(/\/$/, '')}/${cid}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as ReceiptPayload;
      if (data.schema === 'stellar-pay-receipt-v1') {
        return data;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ Pinning backends

  private async pin(content: string): Promise<PinOutcome> {
    switch (this.provider) {
      case 'local':
        return this.pinToLocal(content);
      case 'pinata':
        return this.pinToPinata(content);
      case 'web3':
        return this.pinToWeb3Storage(content);
      default:
        return this.pinToLocal(content);
    }
  }

  // -- Local IPFS node (Kubo RPC API) -----------------------------------------

  private async pinToLocal(content: string): Promise<PinOutcome> {
    const apiUrl = this.config.get<string>('IPFS_API_URL') ?? 'http://127.0.0.1:5001/api/v0';

    try {
      const formData = new FormData();
      const blob = new Blob([content], { type: 'application/json' });
      formData.append('file', blob);

      const response = await fetch(`${apiUrl}/add?pin=true&cid-version=1`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw new Error(`IPFS add failed: ${response.status}`);
      }

      const result = (await response.json()) as { Hash: string };
      this.logger.log(`Pinned to local IPFS: ${result.Hash}`);
      return { cid: result.Hash, pinned: true };
    } catch (error) {
      this.logger.warn(
        `Local IPFS unavailable, computing deterministic CID — ${(error as Error).message}`,
      );
      return this.deterministicCid(content);
    }
  }

  // -- Pinata.cloud -----------------------------------------------------------

  private async pinToPinata(content: string): Promise<PinOutcome> {
    const jwt =
      this.config.get<string>('PINATA_JWT') ?? this.config.get<string>('IPFS_API_KEY') ?? '';

    if (!jwt) {
      this.logger.warn('PINATA_JWT not configured — falling back to local');
      return this.pinToLocal(content);
    }

    try {
      const response = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          pinataContent: JSON.parse(content),
          pinataMetadata: {
            name: `stellar-pay-receipt-${Date.now()}`,
            keyvalues: { app: 'stellar-pay', schema: 'receipt-v1' },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`Pinata pin failed (${response.status}): ${errBody}`);
      }

      const result = (await response.json()) as { IpfsHash: string };
      this.logger.log(`Pinned to Pinata: ${result.IpfsHash}`);
      return { cid: result.IpfsHash, pinned: true };
    } catch (error) {
      if ((error as Error).message.includes('Pinata pin failed')) {
        throw error;
      }
      this.logger.warn(
        `Pinata unavailable, computing deterministic CID — ${(error as Error).message}`,
      );
      return this.deterministicCid(content);
    }
  }

  // -- web3.storage (w3up) ----------------------------------------------------

  private async pinToWeb3Storage(content: string): Promise<PinOutcome> {
    const token = this.config.get<string>('WEB3_STORAGE_TOKEN') ?? '';

    if (!token) {
      this.logger.warn('WEB3_STORAGE_TOKEN not configured — falling back to local');
      return this.pinToLocal(content);
    }

    try {
      const blob = new Blob([content], { type: 'application/json' });
      const file = new File([blob], `receipt-${Date.now()}.json`, {
        type: 'application/json',
      });

      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('https://api.web3.storage/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`web3.storage upload failed (${response.status}): ${errBody}`);
      }

      const result = (await response.json()) as { cid: string };
      this.logger.log(`Pinned to web3.storage: ${result.cid}`);
      return { cid: result.cid, pinned: true };
    } catch (error) {
      if ((error as Error).message.includes('web3.storage upload failed')) {
        throw error;
      }
      this.logger.warn(
        `web3.storage unavailable, computing deterministic CID — ${(error as Error).message}`,
      );
      return this.deterministicCid(content);
    }
  }

  // -- Deterministic fallback CID (content-hash, no actual pinning) -----------

  /**
   * Generate a CIDv1 (raw, sha2-256) from content — a stable content address
   * even without an IPFS node, reported with `pinned: false`.
   */
  private deterministicCid(content: string): PinOutcome {
    const hash = createHash('sha256').update(content).digest();

    // Build a CIDv1: <cidv1><raw><sha2-256><multihash>
    // 0x01 = CIDv1, 0x55 = raw codec, 0x12 = sha2-256, 0x20 = 32 bytes digest
    const multihash = Buffer.concat([Buffer.from([0x12, 0x20]), hash]);
    const cidBytes = Buffer.concat([Buffer.from([0x01, 0x55]), multihash]);

    // Base32 (RFC 4648 lowercase, no padding) — standard IPFS CIDv1 encoding.
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let result = '';
    let bits = 0;
    let value = 0;
    for (const byte of cidBytes) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        result += alphabet[(value >> bits) & 0x1f];
      }
    }
    if (bits > 0) {
      result += alphabet[(value << (5 - bits)) & 0x1f];
    }

    const cid = `b${result}`;
    this.logger.log(`Generated deterministic CID (not pinned): ${cid}`);
    return { cid, pinned: false };
  }

  // ------------------------------------------------------------------ Receipt helpers

  /**
   * Build a receipt payload from a successful transaction's database record.
   */
  buildReceiptPayload(tx: {
    id: string;
    hash: string | null;
    fromPublicKey: string | null;
    toPublicKey: string | null;
    amount: string;
    assetCode: string;
    assetIssuer: string | null;
    memo: string | null;
    kind: string;
    sourceNetwork: string;
    createdAt: Date;
  }): ReceiptPayload {
    return {
      schema: 'stellar-pay-receipt-v1',
      transactionId: tx.id,
      transactionHash: tx.hash ?? '',
      from: tx.fromPublicKey ?? '',
      to: tx.toPublicKey ?? '',
      amount: tx.amount,
      assetCode: tx.assetCode,
      assetIssuer: tx.assetIssuer,
      memo: tx.memo,
      kind: tx.kind,
      network: tx.sourceNetwork,
      settledAt: tx.createdAt.toISOString(),
    };
  }
}
