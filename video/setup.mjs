/**
 * Provisions everything the video pipeline needs, without touching the
 * repository's own dependency graph.
 *
 * The video tooling is deliberately *not* a workspace dependency: it would pull
 * an ~80 MB ffmpeg binary and a browser into every `pnpm install` (including
 * CI), and pnpm's `onlyBuiltDependencies` allow-list would have to be widened to
 * let ffmpeg-static's download script run. Instead both tools live under
 * video/.work/, which is gitignored, and the pipeline scripts find them there.
 *
 * Installs:
 *   video/.work/bin/ffmpeg, ffprobe   — static builds (libx264, libmp3lame, libwebp, libass)
 *   video/.work/tools/node_modules    — Playwright, used to rasterise the scenes
 *   video/node_modules                — symlink so `import 'playwright'` resolves
 *
 * Usage: node video/setup.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, WORK, BIN } from './tools.mjs';

const TOOLS = path.join(WORK, 'tools');
const RELEASE = 'b6.0';
const BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}`;

const platform = { linux: 'linux', darwin: 'darwin', win32: 'win32' }[process.platform];
const arch = { x64: 'x64', arm64: 'arm64', ia32: 'ia32' }[process.arch];
if (!platform || !arch)
  throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
if (platform === 'win32' && arch === 'arm64')
  throw new Error('No static Windows/arm64 build is published');

const suffix = platform === 'win32' ? '.exe' : '';

async function download(url, destination) {
  process.stdout.write(`  ${path.basename(destination)} … `);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, bytes);
  if (platform !== 'win32') fs.chmodSync(destination, 0o755);
  console.log(`${(bytes.length / 1024 / 1024).toFixed(0)} MB`);
}

console.log(`Provisioning the video toolchain for ${platform}/${arch}`);

// ------------------------------------------------------------------ ffmpeg

fs.mkdirSync(BIN, { recursive: true });
for (const tool of ['ffmpeg', 'ffprobe']) {
  const target = path.join(BIN, `${tool}${suffix}`);
  if (fs.existsSync(target)) {
    console.log(`  ${tool}: already present`);
    continue;
  }
  await download(`${BASE}/${tool}-${platform}-${arch}${suffix}`, target);
}

for (const tool of ['ffmpeg', 'ffprobe']) {
  const bin = path.join(BIN, `${tool}${suffix}`);
  const version = execFileSync(bin, ['-version'], { encoding: 'utf8' }).split('\n')[0];
  console.log(`  ${version}`);
}
// The still/animation stages need a full build; Playwright's bundled ffmpeg is
// a stripped webm-only binary and cannot encode the deliverable.
const encoders = execFileSync(path.join(BIN, `ffmpeg${suffix}`), ['-hide_banner', '-encoders'], {
  encoding: 'utf8',
});
for (const encoder of ['libx264', 'aac']) {
  if (!encoders.includes(encoder)) {
    throw new Error(`The ffmpeg build is missing ${encoder}; it cannot produce the video`);
  }
}

// --------------------------------------------------------------- playwright

fs.mkdirSync(TOOLS, { recursive: true });
const toolsPackage = path.join(TOOLS, 'package.json');
if (!fs.existsSync(toolsPackage)) {
  fs.writeFileSync(
    toolsPackage,
    `${JSON.stringify({ name: 'video-tools', private: true, type: 'module' }, null, 2)}\n`,
  );
}

console.log('  installing Playwright into video/.work/tools');
execFileSync('npm', ['install', '--no-audit', '--no-fund', 'playwright'], {
  cwd: TOOLS,
  stdio: ['ignore', 'ignore', 'inherit'],
});

const browserCache =
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
  path.join(process.env.HOME ?? '', '.cache', 'ms-playwright');
const browsers = JSON.parse(
  fs.readFileSync(path.join(TOOLS, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'),
).browsers;
const chromium = browsers.find((b) => b.name === 'chromium');
const cached = fs.existsSync(path.join(browserCache, `chromium-${chromium.revision}`));
console.log(
  `  chromium ${chromium.revision} ${cached ? 'already cached' : `not found in ${browserCache} — downloading`}`,
);
if (!cached) {
  execFileSync(path.join(TOOLS, 'node_modules', '.bin', 'playwright'), ['install', 'chromium'], {
    cwd: TOOLS,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

// `import 'playwright'` from video/*.mjs resolves through video/node_modules, so
// point it at the isolated install. The symlink is inside the ignored .work tree.
const link = path.join(ROOT, 'video', 'node_modules');
if (!fs.existsSync(link)) fs.symlinkSync(path.join('.work', 'tools', 'node_modules'), link, 'dir');

console.log('\nReady. Next:');
console.log('  python3 -m pip install edge-tts     # narration');
console.log('  node video/synthesize.mjs           # narration + timings');
console.log('  node video/render-scenes.mjs        # scene stills');
console.log('  node video/build-video.mjs          # mp4 + captions + preview');
