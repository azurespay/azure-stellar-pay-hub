// deploy-contracts.mjs — Deploy Soroban contracts to Stellar testnet
//
// Uploads each contract's WASM and creates the contract instance from the
// deployer account (ContractIdPreimageFromAddress with a per-contract salt,
// the standard CREATE_CONTRACT_V2 pattern), then writes the addresses to
// .deployed-contracts.env.
//
// After deploying, run `pnpm contracts:init` to initialize each contract and
// set the token allowlists (the deployed contracts are inert until then).
import {
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const SECRET_KEY = process.env.STELLAR_SECRET_KEY;
if (!SECRET_KEY) {
  console.error('Set STELLAR_SECRET_KEY environment variable');
  process.exit(1);
}

const RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const NETWORK = Networks.TESTNET;
const keypair = Keypair.fromSecret(SECRET_KEY);
const publicKey = keypair.publicKey();
const server = new rpc.Server(RPC_URL);

const CONTRACTS = [
  'stellar_pay_payment',
  'stellar_pay_escrow',
  'stellar_pay_multisig',
  'stellar_pay_treasury',
  'stellar_pay_subscriptions',
  'stellar_pay_invoices',
  'stellar_pay_merchant',
  'stellar_pay_rewards',
];

// The repo's canonical contract target is wasm32v1-none (see deploy-testnet.sh
// and docs/contracts.md); wasm32-unknown-unknown is kept as a fallback for
// older local builds.
const WASM_CANDIDATES = [
  resolve(process.cwd(), 'contracts/target/wasm32v1-none/release'),
  resolve(process.cwd(), 'contracts/target/wasm32-unknown-unknown/release'),
];
const WASM_DIR = WASM_CANDIDATES.find((dir) => existsSync(dir)) ?? WASM_CANDIDATES[0];
const OUTPUT_FILE = resolve(process.cwd(), '.deployed-contracts.env');

async function getAccount() {
  try {
    return await server.getAccount(publicKey);
  } catch {
    console.error(
      `Account ${publicKey} not found on testnet — fund it first ` +
        '(https://laboratory.stellar.org/#create-account?network=test)',
    );
    process.exit(1);
  }
}

async function deploy(name, wasmPath) {
  console.log(`\n📦 ${name}...`);
  const wasmBytes = readFileSync(wasmPath);
  console.log(`   WASM: ${(wasmBytes.length / 1024).toFixed(1)} KB`);

  const account = await getAccount();

  // Salt for the create-contract preimage. By default it is random per run
  // (a fresh deployment each time); set DEPLOY_SALT to a fixed value for
  // reproducible addresses. The per-contract component keeps the 8 addresses
  // distinct within one run while a fresh DEPLOY_SALT rotates the whole set.
  const runSalt =
    process.env.DEPLOY_SALT ??
    createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex');
  const salt = createHash('sha256').update(`${runSalt}:${name}`).digest();

  // Upload WASM first, then create the contract instance.
  const uploadOp = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeUploadContractWasm(wasmBytes),
    auth: [],
  });
  const createOp = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeCreateContractV2(
      new xdr.CreateContractArgsV2({
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
          new xdr.ContractIdPreimageFromAddress({
            address: xdr.ScAddress.scAddressTypeAccount(
              xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(publicKey)),
            ),
            salt,
          }),
        ),
        executable: xdr.ContractExecutable.contractExecutableWasm(
          xdr.Hash.fromXDR(createHash('sha256').update(wasmBytes).digest()),
        ),
        // CreateContractArgsV2 requires the constructor-args field; these
        // contracts take no constructor args (state is set via initialize()).
        constructorArgs: [],
      }),
    ),
    auth: [],
  });

  // Soroban transactions carry exactly ONE invokeHostFunction operation, so
  // upload and create are two sequential transactions (each simulated,
  // assembled with its footprint, signed, submitted and confirmed).
  console.log('   Uploading WASM...');
  await runSingleOp(account, uploadOp);

  console.log('   Creating contract...');
  const info = await runSingleOp(account, createOp);
  const contractId = extractContractId(info);
  if (!contractId) {
    throw new Error(`Transaction succeeded but no contract id in result (${info.hash})`);
  }
  console.log(`   ✅ ${contractId}`);
  return contractId;
}

/**
 * Simulate → assemble → sign → submit a single invokeHostFunction op and wait
 * for the ledger result. Returns the confirmed getTransaction response.
 */
async function runSingleOp(account, hostFunctionOp) {
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(hostFunctionOp)
    .setTimeout(300)
    .build();

  console.log('   Simulating...');
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error ?? JSON.stringify(sim).slice(0, 300)}`);
  }
  const assembled = rpc.assembleTransaction(tx, sim).build();

  console.log('   Sending...');
  assembled.sign(keypair);
  const sent = await server.sendTransaction(assembled);
  if (sent.status === 'ERROR') {
    throw new Error(
      `Transaction rejected: ${sent.errorResult?.result()?.switch().name ?? JSON.stringify(sent)}`,
    );
  }

  // Wait for confirmation.
  console.log('   Waiting for confirmation...');
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const info = await server.getTransaction(sent.hash);
    if (info.status === 'SUCCESS') {
      return info;
    }
    if (info.status === 'FAILED') {
      throw new Error(`Transaction failed on-chain (${sent.hash})`);
    }
  }
  throw new Error(`Timeout waiting for confirmation (${sent.hash})`);
}

/**
 * Pull the created contract id out of a successful create-contract tx.
 *
 * The authoritative source is the transaction META: the create writes the
 * contract instance entry (LedgerKey::ContractData with the contract-instance
 * marker key), whose `contract` field is the new contract's id. The tx RESULT
 * is not usable for this — the invokeHostFunction success arm in protocol 28
 * does not carry the contract id (verified live on testnet: reading it yields
 * unrelated bytes, and the derived-from-preimage id must match the meta).
 */
function extractContractId(info) {
  try {
    const meta = info.resultMetaXdr;
    const ops = meta.value().operations();
    for (const op of ops) {
      for (const ch of op.changes()) {
        const created = ch.created?.();
        if (!created) continue;
        const data = created.data();
        if (data.switch().name !== 'contractData') continue;
        const cd = data.value();
        if (cd.key().switch().name !== 'scvLedgerKeyContractInstance') continue;
        const contract = cd.contract().value();
        if (Buffer.isBuffer(contract) && contract.length === 32) {
          return StrKey.encodeContract(contract);
        }
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function main() {
  console.log(`🚀 Deploying 8 Soroban contracts to testnet`);
  console.log(`   Deployer: ${publicKey}\n`);

  // Idempotency: when DEPLOY_SALT is fixed, an existing output file lets a
  // re-run reuse the same addresses instead of hitting ExistingValue. With a
  // random salt (fresh deployment) the previous file is ignored.
  const existing = existsSync(OUTPUT_FILE) ? readFileSync(OUTPUT_FILE, 'utf8').split('\n') : [];
  const seen = new Map(
    existing
      .map((l) => l.match(/^CONTRACT_STELLAR_PAY_([A-Z_]+)=([CA-G][A-Z0-9]{55})$/))
      .filter(Boolean)
      .map((m) => [m[1].toLowerCase(), m[2]]),
  );

  const lines = [
    `# Deployed contract addresses — ${new Date().toISOString()}`,
    `# Account: ${publicKey}`,
  ];

  for (const name of CONTRACTS) {
    const wasmPath = resolve(WASM_DIR, `${name}.wasm`);
    if (!existsSync(wasmPath)) {
      console.error(`   ❌ WASM not found: ${wasmPath} — run contracts:build first`);
      lines.push(`# CONTRACT_${name.toUpperCase()}=MISSING_WASM`);
      continue;
    }
    const key = name.replace(/^stellar_pay_/, '');
    const already = process.env.DEPLOY_SALT ? seen.get(key) : undefined;
    if (already) {
      console.log(`⏭  ${name} already deployed: ${already} (fixed DEPLOY_SALT → reuse)`);
      lines.push(`CONTRACT_${name.toUpperCase()}=${already}`);
      continue;
    }
    try {
      const address = await deploy(name, wasmPath);
      lines.push(`CONTRACT_${name.toUpperCase()}=${address}`);
    } catch (err) {
      console.error(`   ❌ ${err.message}`);
      lines.push(`# CONTRACT_${name.toUpperCase()}=FAILED`);
    }
  }

  writeFileSync(OUTPUT_FILE, lines.join('\n') + '\n');
  console.log(`\n📝 ${OUTPUT_FILE}`);
  console.log(`\nNext: pnpm contracts:init  (initialize + allowlist the deployed contracts)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
