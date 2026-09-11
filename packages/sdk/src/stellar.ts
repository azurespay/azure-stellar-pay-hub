import {
  Account,
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  rpc,
  xdr,
  type Asset as StellarAsset,
  type Transaction,
} from '@stellar/stellar-sdk';
import type { AssetBalance } from '@stellar-pay/types';
import { fromStroops, toStroops } from '@stellar-pay/shared';

export interface StellarNetworkConfig {
  horizonUrl: string;
  networkPassphrase: string;
  /** Soroban RPC endpoint — required for the contract (Soroban) payment route. */
  sorobanRpcUrl?: string;
  /**
   * Per-request HTTP timeout for Horizon + Soroban RPC calls, in milliseconds.
   * Both SDK clients default to *no* timeout, so a hung endpoint would block a
   * caller (API request or E2E harness) forever. Defaults to 30s — comfortably
   * above normal network latency but far below any operator patience threshold.
   */
  requestTimeoutMs?: number;
}

/** Default per-request timeout applied to Horizon + Soroban RPC clients. */
export const DEFAULT_STELLAR_REQUEST_TIMEOUT_MS = 30_000;

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

/**
 * Thrown when a Soroban contract transaction cannot be prepared, signed, or
 * submitted. Either the RPC endpoint is missing, the simulate/assemble step
 * failed (e.g. the token SAC is not allowlisted on-chain), or submission was
 * rejected by Soroban RPC.
 */
export class SorobanSubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SorobanSubmissionError';
  }
}

export interface SorobanSendInput {
  /** Payer account (G…). Must sign the transaction for `from.require_auth()`. */
  from: string;
  /** Recipient account (G…). */
  to: string;
  /**
   * The deployed payment contract (C…) whose `send(from, to, token, amount,
   * memo)` entry point is invoked. This must be the contract id from
   * `CONTRACT_STELLAR_PAY_PAYMENT`, NOT the token SAC — invoking `send` on the
   * token contract fails with "symbol not found" (regression guarded by unit
   * tests that assert the invoked contract address).
   */
  contractId: string;
  /** Token contract address (C…) — use `sorobanTokenAddress()` for SAC assets. */
  tokenAddress: string;
  /** Amount in decimal asset units (e.g. "10" for 10 XLM). */
  amount: string;
  /** Correlation memo passed to the contract's `send` (surfaces in the event). */
  memo?: string;
}

/**
 * A generic Soroban contract invocation: source account, deployed contract id
 * (C…), entry-point name, and the exact ScVal argument list. Used by the
 * platform's escrow / invoices / subscriptions / treasury / merchant
 * integrations — the payment route wraps the same pipeline with typed inputs.
 */
export interface ContractCallInput {
  /** Account (G…) the transaction is sourced from and which must authorize
   * (sign) any `require_auth` entries the simulation returns. */
  source: string;
  /** Deployed contract id (C…). */
  contractId: string;
  /** Entry-point name, e.g. `create`, `release`, `deposit`. */
  functionName: string;
  /** Exact ScVal argument list for the invocation. */
  args: xdr.ScVal[];
}

/** Wraps Horizon + Soroban RPC for balances, tx building and submission. */
export class StellarNetwork {
  readonly server: Horizon.Server;
  readonly config: StellarNetworkConfig;
  /** Per-request timeout applied to Horizon + Soroban RPC clients. */
  readonly timeoutMs: number;
  private rpcServer: rpc.Server | null = null;

  constructor(config: StellarNetworkConfig) {
    this.config = config;
    this.timeoutMs = config.requestTimeoutMs ?? DEFAULT_STELLAR_REQUEST_TIMEOUT_MS;
    this.server = new Horizon.Server(config.horizonUrl);
    // Horizon.Server takes no timeout option — set it on the underlying client
    // so a hung Horizon node fails fast instead of blocking the request.
    this.server.httpClient.defaults.timeout = this.timeoutMs;
  }

  static forTestnet(): StellarNetwork {
    return new StellarNetwork({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      networkPassphrase: Networks.TESTNET,
    });
  }

  /** Lazily-constructed Soroban RPC client (contract route only). */
  sorobanRpc(): rpc.Server {
    if (!this.config.sorobanRpcUrl) {
      throw new SorobanSubmissionError(
        'SOROBAN_RPC_URL is not configured — the contract (Soroban) payment route ' +
          'requires an RPC endpoint.',
      );
    }
    this.rpcServer ??= new rpc.Server(this.config.sorobanRpcUrl, { timeout: this.timeoutMs });
    return this.rpcServer;
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

    // A memo without an explicit type is a text memo (matches the API's
    // `memoType ?? 'text'` default) — a memo must never be silently dropped
    // just because the caller omitted memoType.
    const memoType = input.memoType ?? 'text';
    const memo = input.memo
      ? memoType === 'hash'
        ? Memo.hash(input.memo)
        : memoType === 'id'
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
   * Build the raw (pre-simulation) `send` invocation transaction — a thin
   * wrapper over the generic invoke-contract builder.
   */
  private async buildSorobanSendRawTx(input: SorobanSendInput): Promise<Transaction> {
    const amountStroops = BigInt(toStroops(input.amount));
    return this.buildInvokeContractRawTx({
      source: input.from,
      contractId: input.contractId,
      functionName: 'send',
      args: [
        this.accountScVal(input.from),
        this.accountScVal(input.to),
        this.accountScVal(input.tokenAddress),
        this.i128ScVal(amountStroops),
        input.memo ? xdr.ScVal.scvString(input.memo) : xdr.ScVal.scvVoid(),
      ],
    });
  }

  /**
   * Build the raw (pre-simulation) transaction for an arbitrary contract
   * invocation `contractId.functionName(args...)` sourced from `source`. The
   * returned envelope is *not* yet executable: callers must run
   * `prepareContractCall` (simulate → assemble) so the envelope carries the
   * on-chain footprint and the source account's authorization entries.
   */
  private async buildInvokeContractRawTx(input: ContractCallInput): Promise<Transaction> {
    const source = await this.server.loadAccount(input.source);
    const hostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: xdr.ScAddress.scAddressTypeContract(
          // v14 typings type the arm as Hash while decodeContract returns Buffer.
          StrKey.decodeContract(input.contractId) as unknown as xdr.Hash,
        ),
        functionName: input.functionName,
        args: input.args,
      }),
    );

    return new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(Operation.invokeHostFunction({ func: hostFunction, auth: [] }))
      .setTimeout(300)
      .build();
  }

  /**
   * Prepare an executable Soroban contract call (`contractId.functionName`):
   * build the raw invokeHostFunction transaction, simulate it against Soroban
   * RPC (a reverting call — e.g. an un-allowlisted SAC or a failed
   * precondition — surfaces here with the on-chain diagnostic), then assemble
   * the simulated envelope (footprint / `sorobanData` + unsigned
   * `require_auth()` entries).
   *
   * The returned XDR is what the wallet must sign (`signContractCall`); the
   * server then submits the signed envelope via `submitContractCall` (Soroban
   * RPC `sendTransaction`). This is the generic pipeline used by the
   * platform's escrow / invoices / subscriptions / treasury / merchant
   * integrations.
   */
  async prepareContractCall(input: ContractCallInput): Promise<{
    unsignedXdr: string;
    minResourceFee: string;
    latestLedger: number;
  }> {
    const raw = await this.buildInvokeContractRawTx(input);
    const rpcServer = this.sorobanRpc();
    const sim = await rpcServer.simulateTransaction(raw);

    if (rpc.Api.isSimulationSuccess(sim)) {
      const assembled = rpc.assembleTransaction(raw, sim).build();
      return {
        unsignedXdr: assembled.toXDR(),
        minResourceFee: sim.minResourceFee,
        latestLedger: sim.latestLedger ?? 0,
      };
    }

    // Simulation failed — surface the on-chain diagnostic so the caller gets
    // the real reason instead of a generic failure.
    const diag = this.extractSimulationError(sim);
    throw new SorobanSubmissionError(
      `Soroban simulation failed: ${diag.reason}${diag.detail ? ` (${diag.detail})` : ''}`,
    );
  }

  /**
   * Sign an assembled Soroban envelope (any contract invocation) with the
   * given keypair: fills in the address-credential authorization entries
   * returned by simulation (via soroban-auth), then signs the envelope.
   */
  async signContractCall(
    unsignedXdr: string,
    keypair: Keypair,
    opts?: { validUntilLedgerSeq?: number },
  ): Promise<string> {
    const tx = TransactionBuilder.fromXDR(
      unsignedXdr,
      this.config.networkPassphrase,
    ) as Transaction;
    const op = tx.operations[0] as Operation.InvokeHostFunction;
    if (!op || op.type !== 'invokeHostFunction') {
      throw new SorobanSubmissionError('assembled XDR does not contain an invokeHostFunction op');
    }

    const entries = op.auth ?? [];
    const validUntil =
      opts?.validUntilLedgerSeq ??
      ((await this.sorobanRpc().getLatestLedger()).sequence ?? 0) + 100;
    // Mutate the auth array *in place* (the same pattern the SDK's own
    // AssembledTransaction.signAuthEntries uses): the operation's auth list is
    // parsed lazily from the envelope, so reassigning `op.auth` would be
    // dropped on re-encode, while writing entries into the existing array is
    // serialized back into the XDR.
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const creds = entry.credentials();
      if (
        creds.switch().name === 'sorobanCredentialsAddress' &&
        creds.address().signature().switch().name === 'scvVoid'
      ) {
        entries[i] = await authorizeEntry(
          entry,
          keypair,
          validUntil,
          this.config.networkPassphrase,
        );
      }
    }
    tx.sign(keypair);
    return tx.toXDR();
  }

  /**
   * Submit a signed Soroban envelope (any contract invocation) via RPC
   * `sendTransaction`, polling `getTransaction` until the ledger reports a
   * terminal result. Returns `SUCCEEDED` when the invocation executed on-chain
   * (the contract reverts otherwise — e.g. token not allowlisted).
   */
  async submitContractCall(signedXdr: string): Promise<SubmitResult> {
    const rpcServer = this.sorobanRpc();
    const tx = TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase) as Transaction;
    const sent = await rpcServer.sendTransaction(tx);
    if (sent.status === 'ERROR') {
      const code = sent.errorResult?.result()?.switch().name ?? 'ERROR';
      throw new SorobanSubmissionError(`Soroban sendTransaction rejected: ${code}`);
    }
    const hash = sent.hash;

    // Poll for a terminal ledger result (SUCCESS or FAILED). TRY_AGAIN_LATER /
    // NOT_FOUND are transient — keep polling until the timeout.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const result = await rpcServer.getTransaction(hash).catch(() => null);
      if (result?.status === 'SUCCESS') {
        const fee = this.extractSucceedFee(result);
        return {
          hash,
          sequence: tx.sequence,
          fee: fee || tx.fee,
          ledger: result.ledger ?? null,
          status: 'SUCCEEDED',
        };
      }
      if (result?.status === 'FAILED') {
        const err = this.extractRevertReason(result);
        return {
          hash,
          sequence: tx.sequence,
          fee: tx.fee,
          ledger: result.ledger ?? null,
          status: 'FAILED',
          errorMessage: err,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    // Ledger result not yet available — the tx was accepted (PENDING). Return
    // the hash so the API can persist SUBMITTED and the indexer can confirm.
    return {
      hash,
      sequence: tx.sequence,
      fee: tx.fee,
      ledger: null,
      status: 'SUCCEEDED',
    };
  }

  /**
   * Build an unsigned Soroban transaction that invokes the payment contract's
   * `send(from, to, token, amount, memo)` entry point (the contract id is
   * `input.contractId`; the token SAC is passed as an argument). The payer
   * must sign the returned XDR (the contract calls `from.require_auth()`),
   * then submit via `submitSorobanSendTransaction`.
   *
   * Note: this is the *raw* pre-simulation XDR. For an executable contract
   * payment the server must instead use `prepareSorobanSendTransaction` (which
   * runs the simulate → assemble round-trip so the envelope carries the
   * footprint and authorization entries).
   */
  async buildSorobanSendTransaction(input: SorobanSendInput): Promise<string> {
    const tx = await this.buildSorobanSendRawTx(input);
    return tx.toXDR();
  }

  /**
   * Prepare an executable Soroban `send` payment:
   *
   *   1. build the raw invokeHostFunction transaction,
   *   2. simulate it against Soroban RPC (this is where an un-allowlisted SAC
   *      reverts — surfaced here as a clear error before anything is stored),
   *   3. assemble the simulated envelope (footprint / `sorobanData` and the
   *      `from.require_auth()` authorization entries embedded, unsigned).
   *
   * The returned XDR is what the payer's wallet must sign (see
   * `signSorobanSendTransaction`); the server then submits the signed envelope
   * via `submitSorobanSendTransaction` (Soroban RPC `sendTransaction`).
   */
  async prepareSorobanSendTransaction(input: SorobanSendInput): Promise<{
    unsignedXdr: string;
    minResourceFee: string;
    latestLedger: number;
  }> {
    const amountStroops = BigInt(toStroops(input.amount));
    return this.prepareContractCall({
      source: input.from,
      contractId: input.contractId,
      functionName: 'send',
      args: [
        this.accountScVal(input.from),
        this.accountScVal(input.to),
        this.accountScVal(input.tokenAddress),
        this.i128ScVal(amountStroops),
        input.memo ? xdr.ScVal.scvString(input.memo) : xdr.ScVal.scvVoid(),
      ],
    });
  }

  /**
   * Sign an assembled Soroban `send` envelope with the payer's keypair:
   * fills in the address-credential authorization entries returned by
   * simulation (via soroban-auth), then signs the transaction envelope.
   * Returns the base64 signed XDR ready for `submitSorobanSendTransaction`.
   */
  async signSorobanSendTransaction(
    unsignedXdr: string,
    keypair: Keypair,
    opts?: { validUntilLedgerSeq?: number },
  ): Promise<string> {
    return this.signContractCall(unsignedXdr, keypair, opts);
  }

  /**
   * Submit a signed Soroban envelope via RPC `sendTransaction`, polling
   * `getTransaction` until the ledger reports a terminal result. Returns the
   * on-chain outcome (`SUCCEEDED` when the `send` invocation executed,
   * `FAILED` when it reverted — e.g. token not allowlisted).
   */
  async submitSorobanSendTransaction(signedXdr: string): Promise<SubmitResult> {
    return this.submitContractCall(signedXdr);
  }

  /** Pull a readable reason out of a failed simulation response. */
  private extractSimulationError(sim: unknown): { reason: string; detail?: string } {
    const s = sim as {
      error?: string;
      result?: { error?: unknown; message?: string; msg?: string };
    };
    const result = s.result;
    if (typeof result?.error === 'string') {
      return { reason: result.error, detail: result.message ?? result.msg };
    }
    if (typeof result?.msg === 'string') {
      return { reason: result.msg };
    }
    if (typeof result?.message === 'string') {
      return { reason: 'contract reverted', detail: result.message };
    }
    if (typeof s.error === 'string') {
      return { reason: s.error };
    }
    return { reason: JSON.stringify(sim).slice(0, 300) };
  }

  /** Extract the fee charged from a successful getTransaction result. */
  private extractSucceedFee(result: { resultXdr?: xdr.TransactionResult }): string | null {
    if (result.resultXdr) {
      try {
        return result.resultXdr.feeCharged().toString();
      } catch {
        /* fall through */
      }
    }
    return null;
  }

  /** Extract the revert diagnostic from a FAILED getTransaction result. */
  private extractRevertReason(result: { resultXdr?: xdr.TransactionResult }): string {
    if (!result.resultXdr) {
      return 'soroban transaction failed';
    }
    try {
      const txResult = result.resultXdr;
      const res = txResult.result();
      if (res.switch().name === 'txFailed') {
        const failed = (res as unknown as { txFailed(): { results(): unknown[] } }).txFailed();
        const opResults = failed.results() ?? [];
        const first = opResults[0] as
          { tr(): { invokeHostFunctionResult(): { switch(): { name: string } } } } | undefined;
        if (first?.tr) {
          const inv = first.tr().invokeHostFunctionResult();
          if (inv) {
            return `contract revert: ${inv.switch().name}`;
          }
        }
        return 'soroban transaction failed (txFailed)';
      }
      return `transaction ${res.switch().name}`;
    } catch {
      return 'soroban transaction failed';
    }
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

  /**
   * Decode a signed envelope and verify it matches the payment intent the
   * server recorded (anti-manipulation gate for checkout/payment links — see
   * No. 5). A customer must not be able to sign a different amount, recipient,
   * asset, or memo than the one the intent fixed, then claim the payment.
   *
   * Only classic single `payment` operations can be verified this way; callers
   * with batch or Soroban-contract intents skip this gate.
   */
  verifySignedPaymentMatchesIntent(
    signedXdr: string,
    expected: {
      amount: string;
      assetCode: string;
      assetIssuer?: string | null;
      toPublicKey?: string | null;
      memo?: string | null;
    },
  ): { matches: true } | { matches: false; reason: string } {
    let tx: Transaction;
    try {
      tx = TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase) as Transaction;
    } catch {
      return { matches: false, reason: 'signed XDR could not be decoded' };
    }

    const payments = tx.operations.filter(
      (op) => op.type === 'payment',
    ) as Array<Operation.Payment>;
    if (payments.length === 0) {
      return { matches: false, reason: 'the signed transaction contains no payment operation' };
    }
    if (payments.length !== 1) {
      return {
        matches: false,
        reason: `expected a single payment operation, found ${payments.length}`,
      };
    }

    const op = payments[0];
    const opAssetCode = op.asset.isNative() ? 'XLM' : op.asset.getCode();
    const opAssetIssuer = op.asset.isNative() ? null : op.asset.getIssuer();

    // Amounts are decimals in XDR; compare on exact stroop integers.
    let expectedStroops: bigint;
    let actualStroops: bigint;
    try {
      expectedStroops = BigInt(toStroops(expected.amount));
      actualStroops = BigInt(toStroops(op.amount));
    } catch {
      return { matches: false, reason: 'amount could not be parsed' };
    }
    if (actualStroops !== expectedStroops) {
      return {
        matches: false,
        reason: `amount ${op.amount} does not match the expected ${expected.amount}`,
      };
    }

    if (expected.toPublicKey && op.destination !== expected.toPublicKey) {
      return {
        matches: false,
        reason: 'the signed transaction pays a different recipient than the intent',
      };
    }

    if (
      opAssetCode !== expected.assetCode ||
      (opAssetIssuer ?? null) !== (expected.assetIssuer ?? null)
    ) {
      return {
        matches: false,
        reason: `asset ${opAssetCode}${opAssetIssuer ? `:${opAssetIssuer}` : ''} does not match the expected ${expected.assetCode}${expected.assetIssuer ? `:${expected.assetIssuer}` : ''}`,
      };
    }

    if (expected.memo) {
      const memoText = tx.memo?.type === 'text' ? tx.memo.value?.toString() : undefined;
      if (memoText !== expected.memo) {
        return {
          matches: false,
          reason: 'the signed transaction memo does not match the intent',
        };
      }
    }

    return { matches: true };
  }

  /**
   * True when the envelope carries a Soroban invokeHostFunction operation.
   * Soroban transactions must go through Soroban RPC (sendTransaction) after a
   * simulate → assemble (soroban-auth) round-trip — they are not valid classic
   * transactions and Horizon rejects them.
   */
  isSorobanTransaction(signedXdr: string): boolean {
    try {
      const tx = TransactionBuilder.fromXDR(
        signedXdr,
        this.config.networkPassphrase,
      ) as Transaction;
      return tx.operations.some((op) => op.type === 'invokeHostFunction');
    } catch {
      return false;
    }
  }

  /** Submit a signed transaction envelope (base64 XDR string). Throws on failure. */
  async submitSignedTransaction(signedXdr: string): Promise<SubmitResult> {
    // v13 submits a decoded Transaction object rather than a raw XDR string.
    const tx = TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase) as Transaction;
    if (this.isSorobanTransaction(signedXdr)) {
      // Horizon's classic endpoint cannot carry Soroban envelopes. Fail fast
      // with the real reason instead of leaking Horizon's confusing 400 — a
      // Soroban payment needs a simulation-assembled (sorobanData + auth)
      // envelope submitted via Soroban RPC sendTransaction.
      throw new SorobanSubmissionError(
        'Soroban envelopes must be submitted via submitSorobanSendTransaction ' +
          '(Soroban RPC sendTransaction), not the classic Horizon path.',
      );
    }
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

  /**
   * Build an scvAddress ScVal for a G… account or C… contract address. This is
   * the argument encoding the Soroban contracts expect for `Address` params.
   */
  accountScVal(address: string): xdr.ScVal {
    if (address.startsWith('C')) {
      return xdr.ScVal.scvAddress(
        xdr.ScAddress.scAddressTypeContract(
          // v14 typings type the arm as Hash while decodeContract returns Buffer.
          StrKey.decodeContract(address) as unknown as xdr.Hash,
        ),
      );
    }
    return xdr.ScVal.scvAddress(
      xdr.ScAddress.scAddressTypeAccount(
        xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(address)),
      ),
    );
  }

  /** Build an scvI128 ScVal from a stroops bigint (contract `i128` params). */
  i128ScVal(stroops: bigint): xdr.ScVal {
    return xdr.ScVal.scvI128(
      // Runtime expects bigint hi/lo; the generated typings use branded
      // Uint64/Int64, hence the cast.
      new xdr.Int128Parts({
        hi: BigInt.asUintN(64, stroops >> 64n),
        lo: BigInt.asUintN(64, stroops),
      } as never),
    );
  }

  /** Build an scvU64 ScVal from a bigint (contract `u64` params). */
  u64ScVal(value: bigint): xdr.ScVal {
    // Runtime accepts a bigint; the generated typings brand the arg as Uint64.
    return xdr.ScVal.scvU64(value as never);
  }

  /** Build an scvU32 ScVal (contract `u32` params). */
  u32ScVal(value: number): xdr.ScVal {
    return xdr.ScVal.scvU32(value);
  }

  /** Build an scvString ScVal (contract `String` params). */
  stringScVal(value: string): xdr.ScVal {
    return xdr.ScVal.scvString(value);
  }

  /** Build an Option<T> ScVal: the value itself when present, scvVoid for None. */
  optionScVal<T extends xdr.ScVal>(value: T | null | undefined): xdr.ScVal {
    return value ?? xdr.ScVal.scvVoid();
  }

  /** Build a bool ScVal (contract `bool` params). */
  boolScVal(value: boolean): xdr.ScVal {
    return xdr.ScVal.scvBool(value);
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
