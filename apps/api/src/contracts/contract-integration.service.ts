import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { xdr } from '@stellar/stellar-sdk';
import { StellarNetwork, SorobanSubmissionError, type SubmitResult } from '@stellar-pay/sdk';
import { createStellarNetwork } from '../infra/stellar';

/**
 * Shared plumbing for the platform's Soroban contract integrations (escrow,
 * invoices, subscriptions, treasury, merchant settlement).
 *
 * Each integration follows the same lifecycle as the contract payment route:
 *
 *   1. `prepareCall` — build the raw invokeHostFunction transaction, simulate
 *      it against Soroban RPC (a reverting call — un-allowlisted SAC, failed
 *      precondition — surfaces here with the on-chain diagnostic), and assemble
 *      the envelope (footprint + unsigned `require_auth()` entries).
 *   2. the wallet signs the assembled envelope (`signContractCall` on the SDK),
 *   3. `submitCall` — the server submits via Soroban RPC `sendTransaction`
 *      and persists SUBMITTED with the on-chain hash,
 *   4. the event indexer observes the contract's event and advances the record
 *      to its terminal state (FUNDED/RELEASED/PAID/EXECUTED/…) — never a
 *      client- or server-optimistic write.
 *
 * A feature is inactive (503) when its deployed contract address is not
 * configured — the integration must never silently fall back to database-only
 * behavior, because database state alone is not blockchain confirmation.
 */
@Injectable()
export class ContractIntegrationService {
  constructor(private readonly config: ConfigService) {}

  network(): StellarNetwork {
    return createStellarNetwork(this.config);
  }

  /** Deployed contract id for a feature, or undefined when not configured. */
  contractAddress(envKey: string): string | undefined {
    return this.config.get<string>(envKey) ?? undefined;
  }

  /** Resolve the required contract id, failing fast with a 503 when unset. */
  requireContractAddress(envKey: string, label: string): string {
    const address = this.contractAddress(envKey);
    if (!address) {
      throw new ServiceUnavailableException(
        `${label} contract is not deployed/configured (${envKey}) — on-chain integration disabled`,
      );
    }
    return address;
  }

  /** SAC contract id for an asset on the configured network. */
  tokenAddress(assetCode: string, assetIssuer?: string | null): string {
    return this.network().sorobanTokenAddress(assetCode, assetIssuer);
  }

  /**
   * Simulate → assemble a contract call and return the unsigned envelope the
   * caller's wallet must sign. A failed simulation is a definitive
   * client/configuration error (e.g. the token SAC is not allowlisted) —
   * surfaced as a 400, never a 500.
   */
  async prepareCall(input: {
    source: string;
    contractId: string;
    functionName: string;
    args: xdr.ScVal[];
  }): Promise<{ unsignedXdr: string; minResourceFee: string; latestLedger: number }> {
    try {
      return await this.network().prepareContractCall(input);
    } catch (err) {
      if (err instanceof SorobanSubmissionError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  /**
   * Submit a wallet-signed envelope via Soroban RPC. A rejected/unsupported
   * submission is a definitive client error (bad envelope, reverted call) and
   * is surfaced as a 400; transient transport errors propagate so the caller
   * can revert its in-flight claim and let the user retry.
   */
  async submitCall(signedXdr: string): Promise<SubmitResult> {
    try {
      return await this.network().submitContractCall(signedXdr);
    } catch (err) {
      if (err instanceof SorobanSubmissionError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }
}