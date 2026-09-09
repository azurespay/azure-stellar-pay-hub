// init-contracts.mjs — Initialize + allowlist deployed Soroban contracts on Stellar testnet.
//
// After `scripts/deploy-contracts.mjs` (or `deploy-testnet.sh`) uploads the
// contracts, they are inert: none are initialized and the payment contract's
// SAC allowlist was never set (the audit found zero on-chain events for all 8
// contracts). This script closes that gap:
//
//   1. Reads contract addresses from .deployed-contracts.env
//   2. Calls `initialize(...)` on every contract that requires it
//   3. Calls `set_allowed(admin, <XLM SAC>, true)` on payment + treasury
//      (multi-asset allowlisting is supported via ALLOWLIST_TOKENS env var)
//   4. Verifies on-chain storage afterwards (Admin / Paused / Allowed keys)
//
// Usage:
//   export STELLAR_SECRET_KEY=S...            # deployer (admin) secret key
//   node scripts/init-contracts.mjs
//
// Optional:
//   ALLOWLIST_TOKENS="C... C..."              # extra SAC addresses to allowlist
//   MULTISIG_SIGNERS="G... G..." MULTISIG_THRESHOLD=2   # override multisig setup
//   SKIP_INIT=stellar_pay_invoices,stellar_pay_subscriptions  # skip contracts
import {
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const NETWORK = Networks.TESTNET;
const SECRET_KEY = process.env.STELLAR_SECRET_KEY;
if (!SECRET_KEY) {
  console.error('Set STELLAR_SECRET_KEY (deployer/admin secret key)');
  process.exit(1);
}

const keypair = Keypair.fromSecret(SECRET_KEY);
const adminPublic = keypair.publicKey();
const server = new rpc.Server(RPC_URL);

// ── Load contract addresses ────────────────────────────────────────────────
const envFile = resolve(process.cwd(), '.deployed-contracts.env');
const addresses = {};
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^CONTRACT_STELLAR_PAY_([A-Z_]+)=([CA-G][A-Z0-9]{55})$/);
  if (m) addresses[m[1].toLowerCase()] = m[2];
}
const payment = addresses['payment'];
const escrow = addresses['escrow'];
const multisig = addresses['multisig'];
const treasury = addresses['treasury'];
const merchant = addresses['merchant'];
const rewards = addresses['rewards'];
for (const [name, addr] of Object.entries({
  payment,
  escrow,
  multisig,
  treasury,
  merchant,
  rewards,
})) {
  if (!addr) {
    console.error(`Missing CONTRACT_STELLAR_PAY_${name.toUpperCase()} in ${envFile}`);
    process.exit(1);
  }
}
console.log('Contract addresses loaded from', envFile);

// The XLM Stellar Asset Contract (native token SAC) — the allowlist default.
const xlmSac = Asset.native().contractId(NETWORK);
console.log('XLM SAC:', xlmSac);

const extraTokens = (process.env.ALLOWLIST_TOKENS ?? '').split(/\s+/).filter(Boolean);

// ── Helpers ────────────────────────────────────────────────────────────────

function accountScVal(address) {
  return xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeAccount(
      xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(address)),
    ),
  );
}

function contractScVal(address) {
  return xdr.ScVal.scvAddress(xdr.ScAddress.scAddressTypeContract(StrKey.decodeContract(address)));
}

async function getAccount() {
  try {
    return await server.getAccount(adminPublic);
  } catch {
    console.error(
      `Account ${adminPublic} not found on testnet — fund it first ` +
        '(https://laboratory.stellar.org/#create-account?network=test)',
    );
    process.exit(1);
  }
}

async function invokeContract(contractId, functionName, args) {
  const account = await getAccount();
  const hostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: xdr.ScAddress.scAddressTypeContract(StrKey.decodeContract(contractId)),
      functionName,
      args,
    }),
  );
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(Operation.invokeHostFunction({ func: hostFunction, auth: [] }))
    .setTimeout(300)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    const detail = sim.error ?? JSON.stringify(sim).slice(0, 300);
    throw new Error(`${functionName} simulation failed: ${detail}`);
  }

  const assembled = rpc.assembleTransaction(tx, sim).build();
  // Fill soroban-auth address credentials so `admin.require_auth()` passes.
  const op = assembled.operations[0];
  const entries = op.auth ?? [];
  const latest = await server.getLatestLedger();
  const validUntil = latest.sequence + 100;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const creds = entry.credentials();
    if (
      creds.switch().name === 'sorobanCredentialsAddress' &&
      creds.address().signature().switch().name === 'scvVoid'
    ) {
      entries[i] = await authorizeEntry(entry, keypair, validUntil, NETWORK);
    }
  }
  assembled.sign(keypair);

  const sent = await server.sendTransaction(assembled);
  if (sent.status === 'ERROR') {
    throw new Error(
      `${functionName} sendTransaction rejected: ${sent.errorResult?.result() ?? 'ERROR'}`,
    );
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await server.getTransaction(sent.hash);
    if (res.status === 'SUCCESS') return { hash: sent.hash, status: 'SUCCESS' };
    if (res.status === 'FAILED') {
      throw new Error(`${functionName} failed on-chain (hash ${sent.hash})`);
    }
  }
  throw new Error(`${functionName} timed out waiting for confirmation`);
}

/**
 * Read a key from the contract's INSTANCE storage map.
 *
 * Instance storage on protocol 22+ lives inside a single ContractData entry
 * keyed by the contract-instance marker (an ScMap of ScVal→ScVal), not as one
 * ledger entry per key. Keys written by `#[contracttype]` enums are ScVecs,
 * e.g. DataKey::Admin → scvVec([scvSymbol('Admin')]),
 * DataKey::Allowed(token) → scvVec([scvSymbol('Allowed'), scvAddress(token)]).
 */
async function readContractData(contractId, keyScVal) {
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: xdr.ScAddress.scAddressTypeContract(StrKey.decodeContract(contractId)),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const res = await server.getLedgerEntries(ledgerKey);
  if (!res.entries || res.entries.length === 0) return undefined;
  const entry = res.entries[0];
  const instance = entry.val.value().val().value(); // ScContractInstance
  const map = instance.storage() ?? [];
  const want = keyScVal.toXDR('base64');
  for (const kv of map) {
    if (kv.key().toXDR('base64') === want) return kv.val();
  }
  return undefined;
}

/** Human-readable summary of an ScVal (for verification output). */
function describeScVal(v) {
  if (!v || !v.switch) return String(v);
  switch (v.switch().name) {
    case 'scvAddress': {
      const a = v.value();
      if (a.switch().name === 'scAddressTypeAccount') {
        return StrKey.encodeEd25519PublicKey(a.value().value());
      }
      return StrKey.encodeContract(a.value());
    }
    case 'scvBool':
      return v.value();
    case 'scvU32':
      return v.value();
    case 'scvI32':
      return v.value();
    case 'scvVec':
      return `vec[${v
        .value()
        .map((el) => describeScVal(el))
        .join(', ')}]`;
    case 'scvSymbol':
      return v.symbol?.() ?? String(v.value());
    default:
      return v.switch().name;
  }
}

/** DataKey::Admin → scvVec([scvSymbol('Admin')]) and friends. */
function dataKeyScVal(...parts) {
  return xdr.ScVal.scvVec(parts);
}
const adminKey = () => dataKeyScVal(xdr.ScVal.scvSymbol('Admin'));
const pausedKey = () => dataKeyScVal(xdr.ScVal.scvSymbol('Paused'));
const allowedKey = (tokenId) =>
  dataKeyScVal(xdr.ScVal.scvSymbol('Allowed'), contractScVal(tokenId));
const signersKey = () => dataKeyScVal(xdr.ScVal.scvSymbol('Signers'));
const thresholdKey = () => dataKeyScVal(xdr.ScVal.scvSymbol('Threshold'));

async function readAdmin(contractId) {
  const v = await readContractData(contractId, adminKey());
  if (!v) return undefined;
  return describeScVal(v);
}

async function readAllowed(contractId, tokenId) {
  const v = await readContractData(contractId, allowedKey(tokenId));
  if (!v) return undefined;
  return v.switch().name === 'scvBool' ? v.value() : describeScVal(v);
}

async function readPaused(contractId) {
  const v = await readContractData(contractId, pausedKey());
  if (!v) return undefined;
  return v.switch().name === 'scvBool' ? v.value() : describeScVal(v);
}

// ── 1. Initialize contracts ────────────────────────────────────────────────

const skip = new Set(
  (process.env.SKIP_INIT ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const results = [];

/**
 * Initialize one contract, skipping cleanly when it is already initialized.
 * `probe` must resolve to truthy when the contract already carries its init
 * state (checked BEFORE invoking, and again AFTER a failed invoke so numeric
 * AlreadyInitialized errors — e.g. `Error(Contract, #9)` — are treated as the
 * idempotent no-op they are).
 */
async function init(name, fn, probe) {
  if (skip.has(name)) {
    console.log(`⏭  skipping ${name} (SKIP_INIT)`);
    return;
  }
  try {
    const already = probe ? await probe() : undefined;
    if (already) {
      results.push([name, 'OK (already initialized)']);
      console.log(`ℹ️  ${name} already initialized — skipping`);
      return;
    }
    await fn();
    results.push([name, 'OK']);
    console.log(`✅ ${name} initialized`);
  } catch (err) {
    const msg = String(err.message ?? err);
    // Already-initialized is a no-op success (idempotent re-runs).
    if (msg.includes('AlreadyInitialized') || msg.includes('already initialized')) {
      results.push([name, 'OK (already initialized)']);
      console.log(`ℹ️  ${name} already initialized — skipping`);
      return;
    }
    const alreadyAfter = probe ? await probe().catch(() => false) : false;
    if (alreadyAfter) {
      results.push([name, 'OK (already initialized)']);
      console.log(`ℹ️  ${name} already initialized — skipping`);
      return;
    }
    results.push([name, 'FAIL']);
    console.error(`❌ ${name}: ${msg}`);
  }
}

console.log('\n── Initializing contracts ──');

const adminProbe = (id) => async () => (await readAdmin(id)) !== undefined;

await init(
  'payment',
  () => invokeContract(payment, 'initialize', [accountScVal(adminPublic)]),
  adminProbe(payment),
);
await init(
  'escrow',
  () => invokeContract(escrow, 'initialize', [accountScVal(adminPublic)]),
  adminProbe(escrow),
);
await init(
  'merchant',
  () => invokeContract(merchant, 'initialize', [accountScVal(adminPublic)]),
  adminProbe(merchant),
);
await init(
  'treasury',
  () => invokeContract(treasury, 'initialize', [accountScVal(adminPublic)]),
  adminProbe(treasury),
);

// Rewards needs a reward token at init — default to the XLM SAC.
await init(
  'rewards',
  () => invokeContract(rewards, 'initialize', [accountScVal(adminPublic), contractScVal(xlmSac)]),
  adminProbe(rewards),
);

// Multisig: signers + threshold (default: single signer = the deployer).
const multisigSigners = (process.env.MULTISIG_SIGNERS ?? adminPublic).split(/\s+/).filter(Boolean);
const multisigThreshold = Number(process.env.MULTISIG_THRESHOLD ?? '1');
await init(
  'multisig',
  () =>
    invokeContract(multisig, 'initialize', [
      xdr.ScVal.scvVec(multisigSigners.map(accountScVal)),
      xdr.ScVal.scvU32(multisigThreshold),
    ]),
  async () => (await readContractData(multisig, signersKey())) !== undefined,
);

// ── 2. Allowlist tokens ────────────────────────────────────────────────────

console.log('\n── Setting token allowlists ──');

const tokensToAllow = [xlmSac, ...extraTokens];
for (const token of tokensToAllow) {
  for (const [label, contractId] of [
    ['payment', payment],
    ['treasury', treasury],
  ]) {
    if (skip.has(label)) continue;
    try {
      await invokeContract(contractId, 'set_allowed', [
        accountScVal(adminPublic),
        contractScVal(token),
        xdr.ScVal.scvBool(true),
      ]);
      console.log(`✅ ${label} allowlisted ${token}`);
    } catch (err) {
      const msg = String(err.message ?? err);
      if (msg.includes('Unauthorized')) {
        console.error(`❌ ${label} set_allowed failed: unauthorized (wrong admin?)`);
        results.push([`${label}.allowlist`, 'FAIL']);
      } else {
        console.error(`❌ ${label} set_allowed failed: ${msg}`);
        results.push([`${label}.allowlist`, 'FAIL']);
      }
    }
  }
}

// ── 3. Verify on-chain state ───────────────────────────────────────────────

console.log('\n── Verifying on-chain state ──');

// Admin check (multisig stores Signers + Threshold instead of an Admin key).
for (const [label, contractId] of [
  ['payment', payment],
  ['escrow', escrow],
  ['merchant', merchant],
  ['treasury', treasury],
  ['rewards', rewards],
]) {
  try {
    const admin = await readAdmin(contractId);
    const ok = typeof admin === 'string' && admin === adminPublic;
    console.log(`${ok ? '✅' : '⚠️'} ${label}.Admin = ${admin ?? '<missing>'}`);
    if (!ok) results.push([`${label}.Admin`, 'FAIL']);
  } catch (err) {
    console.error(`⚠️  could not read ${label}.Admin: ${err.message}`);
  }
}

try {
  const signers = await readContractData(multisig, signersKey());
  const threshold = await readContractData(multisig, thresholdKey());
  const ok = signers !== undefined && threshold !== undefined;
  console.log(
    `${ok ? '✅' : '⚠️'} multisig.Signers = ${signers ? describeScVal(signers) : '<missing>'}`,
  );
  console.log(
    `${ok ? '✅' : '⚠️'} multisig.Threshold = ${threshold ? describeScVal(threshold) : '<missing>'}`,
  );
  if (!ok) results.push(['multisig.Signers/Threshold', 'FAIL']);
} catch (err) {
  console.error(`⚠️  could not read multisig state: ${err.message}`);
}

for (const [label, contractId] of [
  ['payment', payment],
  ['treasury', treasury],
]) {
  try {
    const allowed = await readAllowed(contractId, xlmSac);
    console.log(`${allowed === true ? '✅' : '⚠️'} ${label}.Allowed(XLM) = ${allowed}`);
    if (allowed !== true) results.push([`${label}.Allowed(XLM)`, 'FAIL']);
  } catch (err) {
    console.error(`⚠️  could not read ${label}.Allowed(XLM): ${err.message}`);
  }
}

try {
  const paused = await readPaused(payment);
  console.log(`${paused === false ? '✅' : '⚠️'} payment.Paused = ${paused}`);
  if (paused !== false) results.push(['payment.Paused', 'FAIL']);
} catch (err) {
  console.error(`⚠️  could not read payment.Paused: ${err.message}`);
}

// ── Summary ────────────────────────────────────────────────────────────────

const failed = results.filter(([, s]) => s.startsWith('FAIL'));
console.log('\n── Summary ──');
for (const [name, status] of results)
  console.log(
    `  ${status === 'OK' ? '✅' : status.startsWith('OK') ? 'ℹ️' : '❌'} ${name}: ${status}`,
  );
if (failed.length > 0) {
  console.error(`\n❌ ${failed.length} step(s) failed — see messages above`);
  process.exit(1);
}
console.log('\n✅ All contracts initialized, allowlisted and verified on-chain.');
console.log(`   Payment contract: ${payment}`);
