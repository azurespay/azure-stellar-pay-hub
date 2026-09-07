import { Account, Asset, Keypair, Networks, StrKey, xdr } from '@stellar/stellar-sdk';
import { StellarNetwork } from './stellar';
import { toStroops } from '@stellar-pay/shared';

describe('StellarNetwork Soroban helpers', () => {
  const passphrase = Networks.TESTNET;
  const network = new StellarNetwork({
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: passphrase,
  });
  const payer = Keypair.random();
  const payee = Keypair.random();

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
      tokenAddress: token,
      amount,
      memo,
    });

    const invoke = decodeInvoke(xdrStr);
    expect(invoke.opSwitch).toBe('invokeHostFunction');
    expect(invoke.hostFunctionSwitch).toBe('hostFunctionTypeInvokeContract');
    expect(invoke.functionName).toBe('send');
    expect(invoke.contractBytes.equals(StrKey.decodeContract(token))).toBe(true);
    expect(invoke.args.length).toBe(5);

    // args[0]=from, args[1]=to, args[2]=token (accounts vs contract address).
    expect(invoke.args[0].address().switch().name).toBe('scAddressTypeAccount');
    expect(
      invoke.args[0]
        .address()
        .accountId()
        .ed25519()
        .equals(StrKey.decodeEd25519PublicKey(payer.publicKey())),
    ).toBe(true);
    expect(invoke.args[2].address().switch().name).toBe('scAddressTypeContract');

    // args[3] = amount in stroops as i128.
    expect(invoke.args[3].switch().name).toBe('scvI128');
    expect(invoke.args[3].i128().lo().toString()).toBe(toStroops(amount).toString());
    expect(invoke.args[3].i128().hi().toString()).toBe('0');

    // args[4] = correlation memo (Option<String> → the string itself).
    expect(invoke.args[4].switch().name).toBe('scvString');
    expect(invoke.args[4].str().toString()).toBe(memo);
  });

  it('encodes a missing memo as scvVoid', async () => {
    const token = network.sorobanTokenAddress('XLM');
    const xdrStr = await network.buildSorobanSendTransaction({
      from: payer.publicKey(),
      to: payee.publicKey(),
      tokenAddress: token,
      amount: '1',
    });

    const invoke = decodeInvoke(xdrStr);
    expect(invoke.args[4].switch().name).toBe('scvVoid');
  });
});
