/**
 * Shared helpers for the video pipeline: locating ffmpeg/ffprobe and probing
 * media. Every script resolves the toolchain the same way so a build behaves
 * identically on a fresh machine and in CI.
 *
 * Resolution order:
 *   1. $FFMPEG / $FFPROBE (explicit override)
 *   2. video/.work/bin/<tool>   (a static build fetched by `pnpm video:setup`)
 *   3. <tool> on PATH           (a system install)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const WORK = path.join(ROOT, 'video', '.work');
export const BIN = path.join(WORK, 'bin');
export const AUDIO = path.join(WORK, 'audio');
export const SCENES_OUT = path.join(WORK, 'scenes');
export const SEGMENTS = path.join(WORK, 'segments');

function resolve(envVar, name) {
  const candidates = [process.env[envVar], path.join(BIN, name)];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      `Could not find ${name}. Run \`pnpm video:setup\` (downloads a static build into ` +
        `video/.work/bin) or set ${envVar} to an existing binary.`,
    );
  }
}

export const ffmpeg = () => resolve('FFMPEG', 'ffmpeg');
export const ffprobe = () => resolve('FFPROBE', 'ffprobe');

/** Duration in seconds, read from the container rather than inferred. */
export function probeDuration(file) {
  const out = execFileSync(
    ffprobe(),
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  const seconds = Number(out.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Could not read a duration from ${file} (got "${out.trim()}")`);
  }
  return seconds;
}

/** Stream summary, used by the final verification pass. */
export function probeStreams(file) {
  const out = execFileSync(
    ffprobe(),
    [
      '-v',
      'error',
      '-show_entries',
      'stream=index,codec_type,codec_name,width,height,r_frame_rate,channels:format=duration,size,bit_rate',
      '-of',
      'json',
      file,
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
}

export function run(bin, args, { label } = {}) {
  try {
    execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  } catch (err) {
    // Keep the raw output for inspection: a summarised message is enough to act
    // on, but the whole report is what you need when the message is ambiguous.
    const raw = err.stderr ?? '';
    const log = path.join(WORK, 'last-error.log');
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(log, `${bin} ${args.join(' ')}\n\n${raw}\n`);
    const how = err.signal
      ? `killed by ${err.signal}`
      : `exited with status ${err.status ?? 'unknown'}`;
    throw new Error(
      `${label ?? bin} failed (${how}); full output in ${path.relative(ROOT, log)}:\n` +
        summarise(raw || err.message || ''),
    );
  }
}

/**
 * ffmpeg reports progress with carriage returns rather than newlines, so a naive
 * "last few lines" of stderr is one enormous line that buries the error. Normalise
 * the separators, drop the progress stream, and keep what is left.
 */
function summarise(stderr) {
  const lines = stderr
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^frame=\s*\d+/.test(line));
  return lines.slice(-12).join('\n') || '(no output on stderr)';
}
