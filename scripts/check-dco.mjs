#!/usr/bin/env node
/**
 * Enforce the Contributor Certificate of Origin on every commit in a range.
 *
 * This backs `.github/workflows/dco.yml` and is runnable locally:
 *
 *   node scripts/check-dco.mjs                          # origin/main..HEAD
 *   node scripts/check-dco.mjs origin/main..HEAD        # explicit range
 *   DCO_BASE_SHA=<sha> DCO_HEAD_SHA=<sha> node scripts/check-dco.mjs
 *
 * A commit passes when its message carries a `Signed-off-by: Name <email>`
 * trailer whose address matches the commit's author or committer — the trailer
 * is the contributor's certification that they wrote the contribution and may
 * submit it under the project's license (see CONTRIBUTING.md).
 *
 * Skipped by design:
 *   - merge commits (GitHub creates them with no trailer, and the project
 *     squash-merges anyway);
 *   - commits authored by dependency bots, which cannot be asked to sign off.
 *
 * Exit code 0 = every checked commit passes, 1 = at least one does not.
 */
import { execFileSync } from 'node:child_process';

/** Authors whose commits are exempt: bots acting on the project's behalf. */
const DEFAULT_BOT_ALLOWLIST = [
  'dependabot[bot]',
  'renovate[bot]',
  'github-actions[bot]',
  'codecov[bot]',
];

const SIGN_OFF_RE = /^[ \t]*signed-off-by:[ \t]*(\S.*?)[ \t]*<([^>]+)>[ \t]*$/gim;

/**
 * Extract the `Signed-off-by` trailers from a commit message.
 * Exported so the parsing can be exercised without shelling out to git.
 */
export function parseSignOffs(message) {
  const signOffs = [];
  for (const match of message.matchAll(SIGN_OFF_RE)) {
    signOffs.push({ name: match[1].trim(), email: match[2].trim().toLowerCase() });
  }
  return signOffs;
}

/** A commit is exempt when a bot authored it. */
export function isExemptAuthor(name, email, allowlist) {
  const authorName = (name ?? '').toLowerCase();
  const authorEmail = (email ?? '').toLowerCase();
  if (/\[bot\]$/.test(authorName)) return true;
  if (/\[bot\]@/.test(authorEmail)) return true;
  return allowlist.includes(authorName) || allowlist.includes(authorEmail);
}

/**
 * Validate one commit. Returns null when it passes, otherwise a reason string.
 */
export function checkCommit({ authorName, authorEmail, committerEmail, message, allowlist }) {
  if (isExemptAuthor(authorName, authorEmail, allowlist)) return null;

  const signOffs = parseSignOffs(message);
  if (signOffs.length === 0) {
    return 'no `Signed-off-by:` trailer in the commit message';
  }

  const matches = new Set(
    [authorEmail, committerEmail].filter(Boolean).map((e) => e.toLowerCase()),
  );
  if (!signOffs.some((signOff) => matches.has(signOff.email))) {
    const found = signOffs.map((s) => `${s.name} <${s.email}>`).join(', ');
    return `sign-off (${found}) does not match the commit author <${authorEmail}>`;
  }
  return null;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function gitOrNull(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function resolveRange(argv) {
  const explicit = argv[2] ?? process.env.DCO_RANGE;
  if (explicit) return { range: explicit, source: 'argument' };

  const base = process.env.DCO_BASE_SHA ?? process.env.GITHUB_BASE_SHA;
  const head = process.env.DCO_HEAD_SHA ?? process.env.GITHUB_HEAD_SHA ?? 'HEAD';
  // A base of all zeroes means "no previous commit" (initial push).
  if (base && !/^0+$/.test(base)) return { range: `${base}..${head}`, source: 'base/head SHAs' };

  for (const candidate of ['origin/main', 'main', 'origin/master', 'master']) {
    if (gitOrNull(['rev-parse', '--verify', '--quiet', candidate])) {
      return { range: `${candidate}..HEAD`, source: `merge base with ${candidate}` };
    }
  }
  return { range: 'HEAD^!', source: 'tip commit only (no base branch found)' };
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(
      'Usage: node scripts/check-dco.mjs [<git-range>]\n' +
        '  Checks that every non-merge commit in <git-range> carries a signed-off-by\n' +
        '  trailer. Defaults to origin/main..HEAD, or the DCO_BASE_SHA / DCO_HEAD_SHA\n' +
        '  environment variables when set.',
    );
    return 0;
  }

  if (gitOrNull(['rev-parse', '--is-shallow-repository']) === 'true') {
    console.warn(
      'warning: this is a shallow clone, so the commit range may be incomplete — ' +
        'use a full checkout (actions/checkout with fetch-depth: 0).',
    );
  }

  const { range, source } = resolveRange(process.argv);
  let shas;
  try {
    shas = git(['rev-list', '--no-merges', range]).split('\n').filter(Boolean);
  } catch {
    console.error(`error: cannot resolve the commit range "${range}" (from ${source}).`);
    return 1;
  }

  const allowlist = [...DEFAULT_BOT_ALLOWLIST];
  for (const extra of (process.env.DCO_BOT_ALLOWLIST ?? '').split(',')) {
    const entry = extra.trim().toLowerCase();
    if (entry) allowlist.push(entry);
  }

  const failures = [];
  const skipped = [];

  for (const sha of shas) {
    const record = git(['log', '-1', '--format=%an%x1f%ae%x1f%ce%x1f%B', sha]);
    const [authorName, authorEmail, committerEmail, ...rest] = record.split('\x1f');
    const message = rest.join('\x1f');

    if (isExemptAuthor(authorName, authorEmail, allowlist)) {
      skipped.push({ sha, who: authorName });
      continue;
    }

    const reason = checkCommit({ authorName, authorEmail, committerEmail, message, allowlist });
    if (reason) {
      const subject = git(['log', '-1', '--format=%s', sha]);
      failures.push({ sha, subject, reason });
    }
  }

  console.log(`DCO check — range ${range} (from ${source}): ${shas.length} commit(s).`);

  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} bot-authored commit(s):`);
    for (const { sha, who } of skipped) console.log(`  ${sha.slice(0, 12)}  ${who}`);
  }

  if (failures.length === 0) {
    console.log(`\nOK — every checked commit carries a valid sign-off.`);
    return 0;
  }

  console.error(`\nFAIL — ${failures.length} of ${shas.length} commit(s) are not signed off:\n`);
  for (const { sha, subject, reason } of failures) {
    console.error(`  ${sha.slice(0, 12)}  ${subject}`);
    console.error(`               ${reason}`);
  }
  console.error(
    '\nEvery commit must certify the Developer Certificate of Origin ' +
      '(https://developercertificate.org/).\n' +
      'Fix the whole branch at once, then force-push it:\n\n' +
      '    git rebase --signoff main\n' +
      '    git push --force-with-lease\n\n' +
      'For future commits use `git commit -s`. See CONTRIBUTING.md for the full policy.\n',
  );
  return 1;
}

// Only run when executed as a script, so the exported helpers stay importable.
if (process.argv[1] && process.argv[1].endsWith('check-dco.mjs')) {
  process.exit(main());
}

export default main;
