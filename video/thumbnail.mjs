/**
 * Renders the thumbnail used in the README to link the pitch video.
 *
 * It is a real 16:9 card rather than a frame grabbed from the video, so the
 * headline stays legible at README width. Written as a 4K JPEG: it stays crisp
 * on a retina display at ~400 KB, where the same PNG is over four times larger.
 *
 * Writes video/thumbnail.jpg.
 *
 * Usage: node video/thumbnail.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, WORK } from './tools.mjs';

const WIDTH = 1920;
const HEIGHT = 1080;
const DSF = 2; // 3840x2160, so it stays crisp when a README scales it up

const FONTS = path.join(WORK, 'fonts');
const ASSETS = path.join(ROOT, 'video', 'assets');
const OUT = path.join(ROOT, 'video', 'thumbnail.jpg');

const dataUri = (file, mime) => `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
const png = (name) => dataUri(path.join(ASSETS, name), 'image/png');

const FONT_FACES = [
  ['Inter', 400, 'inter-400.woff2'],
  ['Inter', 600, 'inter-600.woff2'],
  ['Inter', 700, 'inter-700.woff2'],
  ['Inter', 800, 'inter-800.woff2'],
  ['JetBrains Mono', 500, 'jbmono-400.woff2'],
]
  .map(
    ([family, weight, file]) =>
      `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;src:url(${dataUri(path.join(FONTS, file), 'font/woff2')}) format('woff2');}`,
  )
  .join('\n');

const shot = (asset, w, h, rotate, dx, dy, z) => `
  <div style="position:absolute;right:${dx}px;top:${dy}px;width:${w}px;z-index:${z};
    transform:rotate(${rotate}deg);border-radius:18px;overflow:hidden;background:#0B0F1C;
    border:1px solid rgba(255,255,255,.22);
    box-shadow:0 60px 140px -40px rgba(0,0,0,.95),0 0 0 1px rgba(255,255,255,.06) inset">
    <div style="height:38px;display:flex;align-items:center;gap:10px;padding:0 16px;
      background:linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,.04));
      border-bottom:1px solid rgba(255,255,255,.1)">
      <span style="width:11px;height:11px;border-radius:50%;background:#FF5F57"></span>
      <span style="width:11px;height:11px;border-radius:50%;background:#FEBC2E"></span>
      <span style="width:11px;height:11px;border-radius:50%;background:#28C840"></span>
    </div>
    <img src="${png(asset)}" style="display:block;width:${w}px;height:${h}px;object-fit:cover;object-position:top center"/>
  </div>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${FONT_FACES}
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}
  body{font-family:'Inter',system-ui,sans-serif;-webkit-font-smoothing:antialiased;color:#EAEEFB;background:#05070F}
  .stage{position:relative;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;
    background:
      radial-gradient(1100px 640px at 8% -10%, rgba(109,40,217,.55), transparent 64%),
      radial-gradient(1000px 600px at 108% 6%, rgba(37,99,235,.34), transparent 62%),
      radial-gradient(900px 700px at 76% 112%, rgba(52,211,153,.2), transparent 64%),
      linear-gradient(180deg,#070B18 0%,#05070F 55%,#04060D 100%);}
  .grid{position:absolute;inset:0;
    background-image:linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px),
      linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px);
    background-size:88px 88px;
    mask-image:radial-gradient(1100px 760px at 42% 44%,#000 18%,transparent 76%);}
  .vignette{position:absolute;inset:0;background:radial-gradient(1300px 860px at 46% 46%,transparent 46%,rgba(0,0,0,.62) 100%)}
  .kicker{display:inline-flex;align-items:center;gap:16px;font-size:24px;font-weight:600;
    letter-spacing:.26em;text-transform:uppercase;color:#C4B5FD}
  .kicker::before{content:'';width:52px;height:3px;border-radius:3px;
    background:linear-gradient(90deg,#8B5CF6,transparent)}
  h1{font-size:112px;line-height:1.02;font-weight:800;letter-spacing:-.038em;margin-top:38px}
  .sub{margin-top:30px;font-size:33px;line-height:1.42;color:#A6B0D0;max-width:900px}
  .chip{padding:14px 24px;border-radius:999px;font-size:23px;color:#D7DEF2;
    border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05)}
  .play{width:80px;height:80px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(135deg,#8B5CF6,#34D399);
    box-shadow:0 24px 60px -16px rgba(139,92,246,.9),0 0 0 1px rgba(255,255,255,.22) inset}
</style></head><body><div class="stage">
  <div class="grid"></div>

  ${shot('admin-dashboard.png', 760, 428, -3.2, -46, 96, 1)}
  ${shot('web-checkout-link.png', 700, 394, 3.6, 150, 496, 2)}

  <div style="position:absolute;left:104px;top:0;height:${HEIGHT}px;display:flex;flex-direction:column;justify-content:center;max-width:905px;z-index:5">
    <div class="kicker">Product pitch</div>
    <h1>Stellar Pay Hub</h1>
    <div class="sub">Cross-border payments,<br/><span style="background:linear-gradient(100deg,#fff,#8B5CF6);-webkit-background-clip:text;background-clip:text;color:transparent">settled in seconds.</span></div>

    <div style="display:flex;gap:16px;margin-top:44px;flex-wrap:wrap">
      <span class="chip">6 Soroban contracts</span>
      <span class="chip">446 tests</span>
      <span class="chip">Stellar testnet</span>
    </div>

    <div style="display:flex;align-items:center;gap:26px;margin-top:56px">
      <span class="play">
        <svg width="30" height="34" viewBox="0 0 30 34" fill="none">
          <path d="M2 2.6v28.8c0 1.9 2.1 3 3.7 2l22-14.4c1.5-1 1.5-3.1 0-4.1L5.7.6C4.1-.4 2 .7 2 2.6Z" fill="#0A0F1E"/>
        </svg>
      </span>
      <span>
        <span style="display:block;font-size:34px;font-weight:700;letter-spacing:-.01em">Watch the pitch</span>
        <span style="display:block;margin-top:6px;font-family:'JetBrains Mono',monospace;font-size:22px;color:#8FA0C8">5 minutes &middot; problem, product, proof</span>
      </span>
    </div>
  </div>

  <div class="vignette"></div>
  <div style="position:absolute;right:104px;bottom:38px;display:flex;align-items:center;gap:14px;
    font-size:22px;color:rgba(255,255,255,.42);font-weight:600;z-index:6">
    <span style="width:13px;height:13px;border-radius:50%;background:linear-gradient(135deg,#8B5CF6,#34D399)"></span>Stellar Pay Hub
  </div>
</div></body></html>`;

const htmlFile = path.join(WORK, 'thumbnail.html');
fs.writeFileSync(htmlFile, html);

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
});
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: DSF,
});
await page.goto(`file://${htmlFile}`, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);
await page.screenshot({ path: OUT, type: 'jpeg', quality: 92 });
await browser.close();

const [w, h] = [WIDTH * DSF, HEIGHT * DSF];
console.log(
  `thumbnail  ${w}x${h}  ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB  -> ${path.relative(ROOT, OUT)}`,
);
