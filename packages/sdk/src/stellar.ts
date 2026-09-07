import {
  Account,
  Asset,
  BASE_FEE,
  Horizon,
  Memo,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
  type Asset as StellarAsset,
  type Transaction,
} from '@stellar/stellar-sdk';
import type { AssetBalance } from '@stellar-pay/types';
import { fromStroops, toStroops } from '@stellar-pay/shared';

export interface StellarNetworkConfig {
  horizonUrl: string;
  networkPassphrase: string;
}

export interface PaymentTxInput {
  from: string;
  to: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string | null;
  memo?: string;
  memoType?: 'text' | 'hash' | 'id';
}

export interface SubmitResult {
  hash: string;
  sequence: string;
  fee: string;
  ledger: number | null;
  status: 'SUCCEEDED' | 'FAILED';
  errorMessage?: string;
}

export interface SorobanSendInput {
  /** Payer account (G…). Must sign the transaction for `from.require_auth()`. */
  from: string;
  /** Recipient account (G…). */
  to: string;
  /** Token contract address (C…) — use `sorobanTokenAddress()` for SAC assets. */
  tokenAddress: string;
  /** Amount in decimal asset units (e.g. "10" for 10 XLM). */
  amount: string;
  /** Correlation memo passed to the contract's `send` (surfaces in the event). */
  memo?: string;
}

/** Wraps Horizon for balances, tx building and submission. */
export class StellarNetwork {
  readonly server: Horizon.Server;
  readonly config: StellarNetworkConfig;

  constructor(config: StellarNetworkConfig) {
    this.config = config;
    this.server = new Horizon.Server(config.horizonUrl);
  }

  static forTestnet(): StellarNetwork {
    return new StellarNetwork({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      networkPassphrase: Networks.TESTNET,
    });
  }

  /** List native + issued asset balances for an account. */
  async getBalances(publicKey: string): Promise<AssetBalance[]> {
    const account = await this.server.loadAccount(publicKey);
    return account.balances
      .filter(
        (b) =>
          b.asset_type === 'native' ||
          b.asset_type === 'credit_alphanum4' ||
          b.asset_type === 'credit_alphanum12',
      )
      .map((b) => {
        if (b.asset_type === 'native') {
          return {
            assetCode: 'XLM',
            assetIssuer: null,
            balance: b.balance,
            stroops: toStroops(b.balance).toString(),
            isNative: true,
          } satisfies AssetBalance;
        }
        const credit = b as Horizon.HorizonApi.BalanceLineAsset;
        return {
          assetCode: credit.asset_code,
          assetIssuer: credit.asset_issuer,
          balance: credit.balance,
          stroops: toStroops(credit.balance).toString(),
          isNative: false,
        } satisfies AssetBalance;
      });
  }

  /** Load account details (or null when the account doesn't exist). */
  async getAccount(
    publicKey: string,
  ): Promise<Awaited<ReturnType<Horizon.Server['loadAccount']>> | null> {
    try {
      return await this.server.loadAccount(publicKey);
    } catch {
      return null;
    }
  }

  /** Build an unsigned payment transaction, returning the base64 XDR for wallet signing. */
  async buildPaymentTransaction(input: PaymentTxInput): Promise<string> {
    const source = await this.server.loadAccount(input.from);
    const asset: StellarAsset =
      input.assetCode === 'XLM' ? Asset.native() : new Asset(input.assetCode, input.assetIssuer!);

    const memo =
      input.memo && input.memoType
        ? input.memoType === 'hash'
          ? Memo.hash(input.memo)
          : input.memoType === 'id'
            ? Memo.id(input.memo)
            : Memo.text(input.memo)
        : Memo.none();

    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: input.to,
          asset,
          amount: input.amount,
        }),
      )
      .addMemo(memo)
      .setTimeout(300)
      .build();

    return tx.toXDR();
  }

  /**
   * Resolve the Soroban token (SAC) contract address for an asset. Returns the
   * C… strkey of the Stellar Asset Contract for the given asset+network.
   */
  sorobanTokenAddress(assetCode: string, assetIssuer?: string | null): string {
    const asset: StellarAsset =
      assetCode === 'XLM' ? Asset.native() : new Asset(assetCode, assetIssuer!);
    return asset.contractId(this.config.networkPassphrase);
  }

  /**
   * Build an unsigned Soroban transaction that invokes the payment contract's
   * `send(from, to, token, amount, memo)` entry point. The payer must sign the
   * returned XDR (the contract calls `from.require_auth()`), then submit via
   * `submitSignedTransaction`.
   */
  async buildSorobanSendTransaction(input: SorobanSendInput): Promise<string> {
    const source = await this.server.loadAccount(input.from);
    const amountStroops = BigInt(toStroops(input.amount));

    const hostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: xdr.ScAddress.scAddressTypeContract(
          StrKey.decodeContract(input.tokenAddress),
        ),
        functionName: 'send',
        args: [
          this.accountScVal(input.from),
          this.accountScVal(input.to),
          this.accountScVal(input.tokenAddress),
          xdr.ScVal.scvI128(
            // Runtime expects bigint hi/lo; the generated typings use branded
            // Uint64/Int64, hence the cast.
            new xdr.Int128Parts({
              hi: BigInt.asUintN(64, amountStroops >> 64n),
              lo: BigInt.asUintN(64, amountStroops),
            } as never),
          ),
          // Option<String> is encoded as the value itself, or void for None.
          input.memo ? xdr.ScVal.scvString(input.memo) : xdr.ScVal.scvVoid(),
        ],
      }),
    );

    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(Operation.invokeHostFunction({ func: hostFunction, auth: [] }))
      .setTimeout(300)
      .build();
    return tx.toXDR();
  }

  /** Build a changeTrust transaction (unsigned XDR for wallet signing). */
  async buildTrustlineTransaction(input: {
    from: string;
    assetCode: string;
    assetIssuer: string;
    limit?: string;
    remove?: boolean;
  }): Promise<string> {
    const source = await this.server.loadAccount(input.from);
    const asset = new Asset(input.assetCode, input.assetIssuer);
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        Operation.changeTrust({
          asset,
          limit: input.remove ? '0' : input.limit,
        }),
      )
      .setTimeout(300)
      .build();
    return tx.toXDR();
  }

  /** Submit a signed transaction envelope (base64 XDR string). Throws on failure. */
  async submitSignedTransaction(signedXdr: string): Promise<SubmitResult> {
    // v13 submits a decoded Transaction object rather than a raw XDR string.
    const tx = TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase) as Transaction;
    const response = await this.server.submitTransaction(tx);
    if (!response.successful) {
      const resultCode =
        (response as unknown as { result_codes?: { transaction?: string } }).result_codes
          ?.transaction ?? 'unknown';
      throw new Error(`Transaction failed: ${resultCode}`);
    }
    return {
      hash: response.hash,
      sequence: tx.sequence,
      fee: tx.fee,
      ledger: response.ledger,
      status: 'SUCCEEDED',
    };
  }

  private accountScVal(address: string): xdr.ScVal {
    if (address.startsWith('C')) {
      return xdr.ScVal.scvAddress(
        xdr.ScAddress.scAddressTypeContract(StrKey.decodeContract(address)),
      );
    }
    return xdr.ScVal.scvAddress(
      xdr.ScAddress.scAddressTypeAccount(
        xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(address)),
      ),
    );
  }

  /** Build a simulated fee estimate without submitting. */
  async estimateFee(input: PaymentTxInput): Promise<{ fee: string; warnings: string[] }> {
    const warnings: string[] = [];
    const simulated = await this.server.feeStats().catch(() => null);
    return {
      fee: simulated?.fee_charged?.max ?? BASE_FEE,
      warnings,
    };
  }
}
