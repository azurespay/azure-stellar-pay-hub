// contracts-verify.mjs — build every Soroban contract for the deployed target
// and run the Rust unit tests.
//
// This is the single entry point shared by local `pnpm test` and CI's
// `build-contracts` job, so the two cannot drift. CI sets
// REQUIRE_RUST_TOOLCHAIN=1, which turns a missing toolchain into a failure
// instead of a skip; locally the toolchain is optional so JS-only contributors
// can still run `pnpm test` (set SKIP_CONTRACTS=1 to skip it deliberately).
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

const MANIFEST = 'contracts/Cargo.toml';
const WASM_TARGET = 'wasm32v1-none';
const IS_WINDOWS = process.platform === 'win32';
const EXE = IS_WINDOWS ? '.exe' : '';

const requireToolchain =
  process.argv.includes('--require-toolchain') || process.env.REQUIRE_RUST_TOOLCHAIN === '1';

if (process.env.SKIP_CONTRACTS === '1') {
  console.log('Skipping Soroban contracts (SKIP_CONTRACTS=1).');
  process.exit(0);
}

function probe(command, args) {
  return spawnSync(command, args, { stdio: 'ignore', shell: IS_WINDOWS });
}

/** Locate cargo: $CARGO, then PATH, then the default rustup install directory. */
function resolveCargo() {
  if (process.env.CARGO) {
    return process.env.CARGO;
  }
  const onPath = probe(`cargo${EXE}`, ['--version']);
  if (!onPath.error && onPath.status === 0) {
    return `cargo${EXE}`;
  }
  const viaRustup = join(homedir(), '.cargo', 'bin', `cargo${EXE}`);
  return existsSync(viaRustup) ? viaRustup : null;
}

const cargo = resolveCargo();
if (!cargo) {
  const message =
    'Soroban contracts skipped: no Rust toolchain found.\n' +
    '  Install it from https://rustup.rs, then add the deployed target:\n' +
    `    rustup target add ${WASM_TARGET}\n` +
    '  CI verifies the contracts in the `build-contracts` job, which installs\n' +
    '  the toolchain.';
  if (requireToolchain) {
    console.error(`ERROR: a Rust toolchain is required here but was not found.\n${message}`);
    process.exit(1);
  }
  console.log(`\n${message}\n`);
  process.exit(0);
}

/**
 * The deployed artifacts target wasm32v1-none, so building for the host
 * instead would silently verify the wrong thing. A missing target is a real
 * setup gap — fail with the fix rather than skip.
 */
function assertWasmTarget() {
  const candidates = [join(dirname(cargo), `rustup${EXE}`), `rustup${EXE}`];
  for (const rustup of candidates) {
    const result = spawnSync(rustup, ['target', 'list', '--installed'], {
      encoding: 'utf8',
      shell: IS_WINDOWS,
    });
    if (result.error || result.status !== 0) {
      continue;
    }
    const installed = result.stdout.split(/\r?\n/).map((line) => line.trim());
    if (!installed.includes(WASM_TARGET)) {
      console.error(
        `\nERROR: the ${WASM_TARGET} target is not installed.\n` +
          `  Fix: rustup target add ${WASM_TARGET}\n`,
      );
      process.exit(1);
    }
    return;
  }
  // No rustup available (e.g. a distro-packaged cargo) — let cargo report any
  // missing-target error itself.
}

function runCargo(args, label) {
  console.log(`\n▶ ${label}`);
  console.log(`  cargo ${args.join(' ')}`);
  const result = spawnSync(cargo, args, { stdio: 'inherit' });
  if (result.error) {
    console.error(`Failed to run cargo: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

assertWasmTarget();
runCargo(
  ['build', '--manifest-path', MANIFEST, '--workspace', '--release', '--target', WASM_TARGET],
  'Soroban contracts — wasm release build',
);
runCargo(['test', '--manifest-path', MANIFEST, '--workspace'], 'Soroban contracts — unit tests');
console.log('\nSoroban contracts: build + tests passed.\n');
