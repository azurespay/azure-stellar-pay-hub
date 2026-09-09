import { Account, Address, Asset, Keypair, Networks, StrKey, xdr } from '@stellar/stellar-sdk';
import { SorobanSubmissionError, StellarNetwork } from './stellar';
import { toStroops } from '@stellar-pay/shared';

describe('StellarNetwork Soroban helpers', () => {
  const passphrase = Networks.TESTNET;
  const network = new StellarNetwork({
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: passphrase,
  });
  const payer = Keypair.random();
  const payee = Keypair.random();
  const CONTRACT_ID = 'CC5UUVJCU3WRXDPDE3MEP65BN7XASQDV6O5IWVQRT53D5UKJ63UVHLCA';

  beforeEach(() => {
    jest
      .spyOn(network.server, 'loadAccount')
      .mockResolvedValue(new Account(payer.publicKey(), '1') as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function decodeInvoke(xdrStr: string) {
    const envelope = xdr.TransactionEnvelope.fromXDR(xdrStr, 'base64');
    const op = envelope.v1().tx().operations()[0];
    const hostFunction = op.body().invokeHostFunctionOp().hostFunction();
    const args = hostFunction.invokeContract();
    return {
      opSwitch: op.body().switch().name,
      hostFunctionSwitch: hostFunction.switch().name,
      functionName: args.functionName().toString(),
      contractBytes: args.contractAddress().contractId(),
      args: args.args(),
    };
  }

  it('resolves the native (XLM) SAC contract address', () => {
    const address = network.sorobanTokenAddress('XLM');
    expect(address).toBe(Asset.native().contractId(passphrase));
    expect(address.startsWith('C')).toBe(true);
    expect(address.length).toBe(56);
  });

  it('resolves an issued asset SAC contract address from code + issuer', () => {
    const issuer = Keypair.random().publicKey();
    const address = network.sorobanTokenAddress('USDC', issuer);
    expect(address).toBe(new Asset('USDC', issuer).contractId(passphrase));
    expect(address.startsWith('C')).toBe(true);
  });

  it('builds an invokeHostFunction XDR calling payment.send with the expected arguments', async () => {
    const token = network.sorobanTokenAddress('XLM');
    const memo = 'sp:abc123';
    const amount = '10';

    const xdrStr = await network.buildSorobanSendTransaction({
      from: payer.publicKey(),
      to: payee.publicKey(),
      contractId: CONTRACT_ID,
      tokenAddress: token,
      amount,
      memo,
    });

    const invoke = decodeInvoke(xdrStr);
    expect(invoke.opSwitch).toBe('invokeHostFunction');
    expect(invoke.hostFunctionSwitch).toBe('hostFunctionTypeInvokeContract');
    expect(invoke.functionName).toBe('send');
    // REGRESSION GUARD: the invocation target must be the deployed payment
    // contract, never the token SAC (the SAC has no `send` entry point).
    // v14 Hash is a Buffer subclass — compare bytes directly.
    expect(Buffer.from(invoke.contractBytes as never)).toEqual(StrKey.decodeContract(CONTRACT_ID));
    expect(Buffer.from(invoke.contractBytes as never)).not.toEqual(StrKey.decodeContract(token));
    expect(invoke.args.length).toBe(5);

    // args[0]=from, args[1]=to, args[2]=token (accounts vs contract address).
    expect(invoke.args[0].address().switch().name).toBe('scAddressTypeAccount');
    expect(Buffer.from(invoke.args[0].address().accountId().ed25519() as never)).toEqual(
      StrKey.decodeEd25519PublicKey(payer.publicKey()),
    );
    // The token SAC must be passed as the THIRD argument of the payment
    // contract's send(from, to, token, amount, memo) — and it must be the
    // XLM SAC, not the payment contract itself.
    expect(invoke.args[2].address().switch().name).toBe('scAddressTypeContract');
    expect(Buffer.from(invoke.args[2].address().contractId() as never)).toEqual(
      StrKey.decodeContract(token),
    );

    // args[3] = amount in stroops as i128.
    expect(invoke.args[3].switch().name).toBe('scvI128');
    expect(invoke.args[3].i128().lo().toString()).toBe(toStroops(amount).toString());
    expect(invoke.args[3].i128().hi().toString()).toBe('0');

    // args[4] = correlation memo (Option<String> → the string itself).
    expect(invoke.args[4].switch().name).toBe('scvString');
    expect(invoke.args[4].str().toString()).toBe(memo);
  });

  it('builds a classic payment XDR that keeps a text memo when memoType is omitted', async () => {
    const xdrStr = await network.buildPaymentTransaction({
      from: payer.publicKey(),
      to: payee.publicKey(),
      amount: '10',
      assetCode: 'XLM',
      memo: 'e2e-test-payment',
      // memoType intentionally omitted — must default to a text memo,
      // not drop the memo (regression: signed XDR previously did not match
      // the recorded intent and submission was rejected).
    });
    const envelope = xdr.TransactionEnvelope.fromXDR(xdrStr, 'base64');
    const tx = envelope.v1().tx();
    // xdr.MemoType enum arm for a text memo is memoText.
    expect(tx.memo().switch().name).toBe('memoText');
    expect(tx.memo().text().toString()).toBe('e2e-test-payment');
    expect(
      network.verifySignedPaymentMatchesIntent(xdrStr, {
        amount: '10',
        assetCode: 'XLM',
        toPublicKey: payee.publicKey(),
        memo: 'e2e-test-payment',
      }),
    ).toEqual({ matches: true });
  });

  it('rejects Soroban envelopes through the classic submit path with a clear error', async () => {
    const token = network.sorobanTokenAddress('XLM');
    const xdrStr = await network.buildSorobanSendTransaction({
      from: payer.publicKey(),
      to: payee.publicKey(),
      contractId: CONTRACT_ID,
      tokenAddress: token,
      amount: '1',
    });
    const signed = network.isSorobanTransaction(xdrStr);
    expect(signed).toBe(true);
    await expect(network.submitSignedTransaction(xdrStr)).rejects.toThrow(SorobanSubmissionError);
  });

  it('encodes a missing memo as scvVoid', async () => {
    const token = network.sorobanTokenAddress('XLM');
    const xdrStr = await network.buildSorobanSendTransaction({
      from: payer.publicKey(),
      to: payee.publicKey(),
      contractId: CONTRACT_ID,
      tokenAddress: token,
      amount: '1',
    });

    const invoke = decodeInvoke(xdrStr);
    expect(invoke.args[4].switch().name).toBe('scvVoid');
  });
});

describe('StellarNetwork Soroban prepare/sign/submit (contract route)', () => {
  const passphrase = Networks.TESTNET;
  const CONTRACT_ID = 'CC5UUVJCU3WRXDPDE3MEP65BN7XASQDV6O5IWVQRT53D5UKJ63UVHLCA';
  const network = new StellarNetwork({
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: passphrase,
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  });
  const payer = Keypair.random();
  const payee = Keypair.random();

  /** Minimal-but-valid simulation response in the raw RPC shape. */
  function buildSimFixture(overrides: { auth?: string[]; latestLedger?: number } = {}) {
    // The js-xdr runtime accepts a switch value; the checked-in .d.ts is
    // stale for this union arm, so construct via the runtime form and cast.
    const txData = new xdr.SorobanTransactionData({
      ext: new xdr.SorobanTransactionDataExt(0),
      resources: new xdr.SorobanResources({
        footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
        instructions: 100000,
        diskReadBytes: 1000,
        writeBytes: 1000,
      }),
      resourceFee: xdr.Int64.fromString('100'),
    });
    const voidEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(payer.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString('0'),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(CONTRACT_ID).toScAddress(),
            functionName: 'send',
            args: [],
          }),
        ),
        subInvocations: [],
      }),
    });
    return {
      id: 'sim-unit',
      latestLedger: overrides.latestLedger ?? 500,
      transactionData: txData.toXDR('base64'),
      results: [
        {
          auth: overrides.auth ?? [voidEntry.toXDR('base64')],
          xdr: xdr.ScVal.scvVoid().toXDR('base64'),
        },
      ],
      events: [],
      minResourceFee: '100',
    };
  }

  function mockRpc(overrides: {
    simulate?: unknown;
    send?: unknown;
    getTx?: unknown;
    latestLedger?: number;
  }) {
    const fake = {
      simulateTransaction: jest.fn().mockResolvedValue(overrides.simulate ?? buildSimFixture()),
      sendTransaction: jest
        .fn()
        .mockResolvedValue(overrides.send ?? { status: 'PENDING', hash: 'unit-hash' }),
      getTransaction: jest.fn().mockResolvedValue(overrides.getTx ?? null),
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: overrides.latestLedger ?? 500 }),
    };
    jest.spyOn(network, 'sorobanRpc').mockReturnValue(fake as never);
    return fake;
  }

  beforeEach(() => {
    jest
      .spyOn(network.server, 'loadAccount')
      .mockResolvedValue(new Account(payer.publicKey(), '1') as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prepares an assembled XDR with a sp: correlation memo and simulation metadata', async () => {
    const rpcMock = mockRpc({});

    const prepared = await network.prepareSorobanSendTransaction({
      from: payer.publicKey(),
      to: payee.publicKey(),
      contractId: CONTRACT_ID,
      tokenAddress: network.sorobanTokenAddress('XLM'),
      amount: '10',
      memo: 'sp:unit-1',
    });

    expect(rpcMock.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(prepared.minResourceFee).toBe('100');
    expect(prepared.latestLedger).toBe(500);

    // The assembled XDR carries the invokeHostFunction op and the unsigned
    // (void-signature) authorization entry from the simulation.
    const envelope = xdr.TransactionEnvelope.fromXDR(prepared.unsignedXdr, 'base64');
    const op = envelope.v1().tx().operations()[0];
    const invoke = op.body().invokeHostFunctionOp();
    const auth = invoke.auth();
    expect(auth.length).toBe(1);
    expect(auth[0].credentials().address().signature().switch().name).toBe('scvVoid');
    const fnName = invoke.hostFunction().invokeContract().functionName().toString();
    expect(fnName).toBe('send');
  });

  it('surfaces an un-allowlisted SAC simulation failure with the on-chain reason', async () => {
    const sim = {
      status: 'FAILED',
      error: 'host invocation failed',
      result: {
        error: 'ContractError(4)',
        message: 'TokenNotAllowed',
      },
    };
    mockRpc({ simulate: sim });

    await expect(
      network.prepareSorobanSendTransaction({
        from: payer.publicKey(),
        to: payee.publicKey(),
        contractId: CONTRACT_ID,
        tokenAddress: network.sorobanTokenAddress('XLM'),
        amount: '1',
      }),
    ).rejects.toThrow(SorobanSubmissionError);
  });

  it('signs the assembled envelope: fills the void auth entry and signs the envelope', async () => {
    mockRpc({});
    const prepared = await network.prepareSorobanSendTransaction({
      from: payer.publicKey(),
      to: payee.publicKey(),
      contractId: CONTRACT_ID,
      tokenAddress: network.sorobanTokenAddress('XLM'),
      amount: '10',
      memo: 'sp:unit-1',
    });

    const signedXdr = await network.signSorobanSendTransaction(prepared.unsignedXdr, payer);

    const envelope = xdr.TransactionEnvelope.fromXDR(signedXdr, 'base64');
    const op = envelope.v1().tx().operations()[0];
    const auth = op.body().invokeHostFunctionOp().auth();
    // The payer's require_auth() entry is now signed (scvVec), not void.
    expect(auth[0].credentials().address().signature().switch().name).toBe('scvVec');
    // The envelope itself is signed by the payer.
    expect(envelope.v1().signatures().length).toBe(1);
  });

  it('rejects signing a non-invoke XDR', async () => {
    const classic = await network.buildPaymentTransaction({
      from: payer.publicKey(),
      to: payee.publicKey(),
      amount: '10',
      assetCode: 'XLM',
    });
    await expect(network.signSorobanSendTransaction(classic, payer)).rejects.toThrow(
      SorobanSubmissionError,
    );
  });

  it('submits via RPC and returns SUCCEEDED once the ledger reports success', async () => {
    mockRpc({});
    const prepared = await network.prepareSorobanSendTransaction({
      from: payer.publicKey(),
      to: payee.publicKey(),
      contractId: CONTRACT_ID,
      tokenAddress: network.sorobanTokenAddress('XLM'),
      amount: '10',
    });
    const signed = await network.signSorobanSendTransaction(prepared.unsignedXdr, payer);

    // sendTransaction → PENDING, then getTransaction → SUCCESS.
    mockRpc({
      send: { status: 'PENDING', hash: 'unit-hash' },
      getTx: { status: 'SUCCESS', ledger: 123, resultXdr: undefined },
    });
    const result = await network.submitSorobanSendTransaction(signed);

    expect(result).toEqual(
      expect.objectContaining({ hash: 'unit-hash', status: 'SUCCEEDED', ledger: 123 }),
    );
  });

  it('reports FAILED with the revert reason when the on-chain result reverted', async () => {
    mockRpc({});
    const prepared = await network.prepareSorobanSendTransaction({
      from: payer.publicKey(),
      to: payee.publicKey(),
      contractId: CONTRACT_ID,
      tokenAddress: network.sorobanTokenAddress('XLM'),
      amount: '10',
    });
    const signed = await network.signSorobanSendTransaction(prepared.unsignedXdr, payer);

    mockRpc({
      send: { status: 'PENDING', hash: 'unit-hash' },
      getTx: { status: 'FAILED', ledger: 124, resultXdr: undefined },
    });
    const result = await network.submitSorobanSendTransaction(signed);

    expect(result.status).toBe('FAILED');
    expect(result.errorMessage).toBe('soroban transaction failed');
  });

  it('rejects a submission rejected by RPC sendTransaction', async () => {
    mockRpc({});
    const prepared = await network.prepareSorobanSendTransaction({
      from: payer.publicKey(),
      to: payee.publicKey(),
      contractId: CONTRACT_ID,
      tokenAddress: network.sorobanTokenAddress('XLM'),
      amount: '10',
    });
    const signed = await network.signSorobanSendTransaction(prepared.unsignedXdr, payer);

    mockRpc({
      send: {
        status: 'ERROR',
        errorResult: { result: () => ({ switch: () => ({ name: 'txFailed' }) }) },
      },
    });
    await expect(network.submitSorobanSendTransaction(signed)).rejects.toThrow(
      SorobanSubmissionError,
    );
  });

  it('fails fast with a clear error when SOROBAN_RPC_URL is not configured', async () => {
    const noRpc = new StellarNetwork({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      networkPassphrase: passphrase,
    });
    jest
      .spyOn(noRpc.server, 'loadAccount')
      .mockResolvedValue(new Account(payer.publicKey(), '1') as never);

    await expect(
      noRpc.prepareSorobanSendTransaction({
        from: payer.publicKey(),
        to: payee.publicKey(),
        contractId: CONTRACT_ID,
        tokenAddress: network.sorobanTokenAddress('XLM'),
        amount: '1',
      }),
    ).rejects.toThrow(/SOROBAN_RPC_URL/);
  });
});

describe('StellarNetwork verifySignedPaymentMatchesIntent (anti-manipulation)', () => {
  const passphrase = Networks.TESTNET;
  const network = new StellarNetwork({
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: passphrase,
  });
  const payer = Keypair.random();
  const payee = Keypair.random();
  const other = Keypair.random();

  beforeEach(() => {
    jest
      .spyOn(network.server, 'loadAccount')
      .mockResolvedValue(new Account(payer.publicKey(), '1') as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function buildXdr(opts: {
    to?: string;
    amount?: string;
    assetCode?: string;
    assetIssuer?: string;
    memo?: string;
  }) {
    return network.buildPaymentTransaction({
      from: payer.publicKey(),
      to: opts.to ?? payee.publicKey(),
      amount: opts.amount ?? '50',
      assetCode: opts.assetCode ?? 'XLM',
      assetIssuer: opts.assetIssuer ?? undefined,
      memo: opts.memo,
      memoType: opts.memo ? 'text' : undefined,
    });
  }

  const expected = {
    amount: '50',
    assetCode: 'XLM',
    toPublicKey: payee.publicKey(),
    memo: 'pay-abc123',
  };

  it('accepts a signed XDR that matches the recorded intent', async () => {
    const xdrStr = await buildXdr({ memo: 'pay-abc123' });
    expect(network.verifySignedPaymentMatchesIntent(xdrStr, expected)).toEqual({ matches: true });
  });

  it('accepts a decimal amount that equals the intent amount (50 vs 50.0000000)', async () => {
    const xdrStr = await buildXdr({ amount: '50.0000000', memo: 'pay-abc123' });
    expect(network.verifySignedPaymentMatchesIntent(xdrStr, expected)).toEqual({ matches: true });
  });

  it('rejects an underpaid amount (the $1-for-$50 attack)', async () => {
    const xdrStr = await buildXdr({ amount: '1', memo: 'pay-abc123' });
    const result = network.verifySignedPaymentMatchesIntent(xdrStr, expected);
    expect(result.matches).toBe(false);
    expect((result as { reason: string }).reason).toContain('amount');
  });

  it('rejects a different recipient', async () => {
    const xdrStr = await buildXdr({ to: other.publicKey(), memo: 'pay-abc123' });
    const result = network.verifySignedPaymentMatchesIntent(xdrStr, expected);
    expect(result.matches).toBe(false);
    expect((result as { reason: string }).reason).toContain('recipient');
  });

  it('rejects a different asset', async () => {
    const issuer = Keypair.random().publicKey();
    // The signed XDR pays USDC while the recorded intent is XLM.
    const xdrStr = await buildXdr({
      assetCode: 'USDC',
      assetIssuer: issuer,
      memo: 'pay-abc123',
    });
    const result = network.verifySignedPaymentMatchesIntent(xdrStr, expected);
    expect(result.matches).toBe(false);
    expect((result as { reason: string }).reason).toContain('asset');
  });

  it('rejects a missing/mismatched memo when the intent carries one', async () => {
    const xdrStr = await buildXdr({}); // no memo
    const result = network.verifySignedPaymentMatchesIntent(xdrStr, expected);
    expect(result.matches).toBe(false);
    expect((result as { reason: string }).reason).toContain('memo');
  });

  it('rejects undecodable garbage', () => {
    const result = network.verifySignedPaymentMatchesIntent('not-an-xdr', expected);
    expect(result.matches).toBe(false);
  });

  it('skips the memo requirement when the intent has no memo', async () => {
    const xdrStr = await buildXdr({ amount: '9' });
    const result = network.verifySignedPaymentMatchesIntent(xdrStr, {
      amount: '9',
      assetCode: 'XLM',
      toPublicKey: payee.publicKey(),
    });
    expect(result).toEqual({ matches: true });
  });
});
