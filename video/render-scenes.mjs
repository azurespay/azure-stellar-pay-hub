/**
 * Renders every scene in video/scenes.mjs to a 3200x1800 PNG using headless
 * Chromium. Composition happens in HTML/CSS — typography, the browser frame
 * around real screenshots, callout chips, diagrams, syntax-highlighted source —
 * and the resulting still is animated by ffmpeg in video/build-video.mjs. That
 * keeps the design system in one place instead of scattering it across filter
 * graphs.
 *
 * Usage: node video/render-scenes.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { scenes } from './scenes.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORK = path.join(ROOT, 'video', '.work');
const OUT = path.join(WORK, 'scenes');
const FONTS = path.join(WORK, 'fonts');
const ASSETS = path.join(ROOT, 'video', 'assets');

// 1920x1080 CSS at this scale factor gives exactly 3200x1800 device pixels:
// crisp enough to zoom into during the video without softening text.
/** Content must finish above this line; the video's progress bar sits below it. */
const SAFE_BOTTOM = 1010;

const WIDTH = 1920;
const HEIGHT = 1080;
const DSF = 3200 / WIDTH;

fs.mkdirSync(OUT, { recursive: true });

const b64 = (file) => fs.readFileSync(file).toString('base64');
const dataUri = (file, mime) => `data:${mime};base64,${b64(file)}`;
const png = (name) => dataUri(path.join(ASSETS, name), 'image/png');

const FONT_FACES = [
  ['Inter', 400, 'inter-400.woff2'],
  ['Inter', 600, 'inter-600.woff2'],
  ['Inter', 700, 'inter-700.woff2'],
  ['Inter', 800, 'inter-800.woff2'],
  ['JetBrains Mono', 400, 'jbmono-400.woff2'],
  ['JetBrains Mono', 600, 'jbmono-600.woff2'],
]
  .map(
    ([family, weight, file]) =>
      `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;src:url(${dataUri(path.join(FONTS, file), 'font/woff2')}) format('woff2');}`,
  )
  .join('\n');

const ACCENTS = {
  violet: { a: '#8B5CF6', b: '#6D28D9', rgb: '139,92,246' },
  mint: { a: '#34D399', b: '#059669', rgb: '52,211,153' },
};

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const BASE_CSS = `
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}
  body{
    font-family:'Inter',system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;
    color:#EAEEFB;
    background:#05070F;
  }
  .stage{position:relative;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;
    background:
      radial-gradient(1200px 620px at 12% -8%, rgba(109,40,217,.45), transparent 62%),
      radial-gradient(1000px 560px at 105% 8%, rgba(37,99,235,.30), transparent 60%),
      radial-gradient(900px 700px at 82% 108%, rgba(52,211,153,.16), transparent 62%),
      linear-gradient(180deg,#070B18 0%,#05070F 55%,#04060D 100%);
  }
  .grid{position:absolute;inset:0;
    background-image:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),
      linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px);
    background-size:96px 96px;
    mask-image:radial-gradient(1200px 800px at 50% 40%,#000 20%,transparent 78%);
  }
  .grain{position:absolute;inset:0;opacity:.05;mix-blend-mode:overlay;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)'/%3E%3C/svg%3E");}
  .vignette{position:absolute;inset:0;background:radial-gradient(1400px 900px at 50% 45%,transparent 45%,rgba(0,0,0,.55) 100%)}
  .pad{position:relative;width:100%;height:100%;padding:104px 120px;display:flex;flex-direction:column}

  .kicker{display:inline-flex;align-items:center;gap:16px;font-size:23px;font-weight:600;
    letter-spacing:.24em;text-transform:uppercase;color:var(--acc)}
  .kicker::before{content:'';width:52px;height:3px;border-radius:3px;background:linear-gradient(90deg,var(--acc),transparent)}
  h1{font-size:104px;line-height:1.03;font-weight:800;letter-spacing:-.035em}
  h1.sm{font-size:82px}
  .sub{margin-top:30px;font-size:31px;line-height:1.45;color:#A6B0D0;max-width:1400px;font-weight:400}
  /* The bottom 70px is kept clear: the video draws its own progress bar along
     the very bottom edge, and scene content must not sit on top of it. The
     section name already appears as the kicker, so there is no second label. */
  .brand{position:absolute;right:120px;bottom:34px;display:flex;align-items:center;gap:14px;
    font-size:22px;color:rgba(255,255,255,.42);font-weight:600;letter-spacing:.02em}
  .brand .dot{width:13px;height:13px;border-radius:50%;background:linear-gradient(135deg,#8B5CF6,#34D399)}

  /* syntax tokens for the code scene */
  .cm{color:#6B7EA8;font-style:italic}
  .st{color:#F0B37E}
  .nu{color:#FDBA74}
  .mc{color:#7DD3FC}
  .kw{color:#C4B5FD}
  .ty{color:#86EFAC}
`;

function shell(scene, accent, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${FONT_FACES}
  :root{--acc:${accent.a};--acc2:${accent.b};--accrgb:${accent.rgb}}
  ${BASE_CSS}</style></head><body><div class="stage"><div class="grid"></div><div class="grain"></div>
  ${body}
  <div class="vignette"></div>
  <div class="brand"><span class="dot"></span>Stellar Pay Hub</div>
  </div></body></html>`;
}

// ---------------------------------------------------------------- statement

function renderStatement(scene) {
  const accent = ACCENTS[scene.accent ?? 'violet'];
  const lines = String(scene.headline).split('\n');
  const headline = lines
    .map((line, i) =>
      i === lines.length - 1
        ? `<span style="background:linear-gradient(100deg,#fff 20%,${accent.a});-webkit-background-clip:text;background-clip:text;color:transparent">${esc(line)}</span>`
        : esc(line),
    )
    .join('<br>');
  return shell(
    scene,
    accent,
    `<div class="pad" style="justify-content:center">
      <div class="kicker">${esc(scene.kicker)}</div>
      <h1 style="margin-top:44px">${headline}</h1>
      ${scene.sub ? `<div class="sub">${esc(scene.sub)}</div>` : ''}
      <div style="margin-top:56px;display:flex;gap:14px">
        ${Array.from({ length: 3 }, (_, i) => `<span style="width:${i === 0 ? 120 : 34}px;height:5px;border-radius:4px;background:${i === 0 ? accent.a : 'rgba(255,255,255,.16)'}"></span>`).join('')}
      </div>
    </div>`,
  );
}

// ------------------------------------------------------------------ compare

function renderCompare(scene) {
  const accent = ACCENTS.mint;
  const card = (col, i) => {
    const good = i === 1;
    const tint = good ? '52,211,153' : '148,163,184';
    const mark = good
      ? `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#34D399" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="rgba(148,163,184,.75)" stroke-width="2"/><path d="M8.5 12h7" stroke="rgba(148,163,184,.75)" stroke-width="2" stroke-linecap="round"/></svg>`;
    return `<div style="flex:1;border-radius:26px;padding:44px 46px;border:1px solid rgba(${tint},${good ? '.34' : '.16'});
      background:linear-gradient(180deg,rgba(${tint},${good ? '.10' : '.045'}),rgba(255,255,255,.015));
      ${good ? 'box-shadow:0 30px 90px -40px rgba(52,211,153,.55)' : ''}">
      <div style="font-size:27px;font-weight:700;color:${good ? '#8EF0C8' : '#C3CCE2'};letter-spacing:.01em;margin-bottom:30px">${esc(col.title)}</div>
      ${col.items
        .map(
          (item) =>
            `<div style="display:flex;gap:18px;align-items:flex-start;padding:15px 0;border-top:1px solid rgba(255,255,255,.07)">
              <span style="flex:none;margin-top:2px">${i === 1 ? mark.replace('#34D399', accent.a) : mark}</span>
              <span style="font-size:29px;line-height:1.35;color:${i === 1 ? '#EAEEFB' : '#9AA6C4'}">${esc(item)}</span>
            </div>`,
        )
        .join('')}
    </div>`;
  };
  return shell(
    scene,
    accent,
    `<div class="pad">
      <div class="kicker">${esc(scene.kicker)}</div>
      <h1 class="sm" style="margin-top:36px;max-width:1500px">${esc(scene.headline)}</h1>
      <div style="display:flex;gap:36px;margin-top:64px;flex:1;align-items:stretch">
        ${card(scene.left, 0)}${card(scene.right, 1)}
      </div>
    </div>`,
  );
}

// ----------------------------------------------------------------- stats

function renderStats(scene) {
  const accent = ACCENTS.violet;
  return shell(
    scene,
    accent,
    `<div class="pad">
      <div class="kicker">${esc(scene.kicker)}</div>
      <h1 class="sm" style="margin-top:36px">${esc(scene.headline)}</h1>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:34px;margin-top:66px;flex:1">
        ${scene.stats
          .map(
            (
              s,
              i,
            ) => `<div style="border-radius:26px;padding:50px 52px;border:1px solid rgba(255,255,255,.12);
            background:linear-gradient(180deg,rgba(${i % 2 ? '52,211,153' : accent.rgb},.12),rgba(255,255,255,.015));
            display:flex;flex-direction:column;justify-content:center">
            <div style="font-size:96px;font-weight:800;letter-spacing:-.04em;line-height:1;
              background:linear-gradient(120deg,#fff,${i % 2 ? '#34D399' : accent.a});
              -webkit-background-clip:text;background-clip:text;color:transparent">${esc(s.value)}</div>
            <div style="margin-top:22px;font-size:29px;color:#A9B3CE;line-height:1.35">${esc(s.label)}</div>
          </div>`,
          )
          .join('')}
      </div>
    </div>`,
  );
}

// --------------------------------------------------------------- diagrams

function renderDiagram(scene) {
  const accent = ACCENTS.violet;
  if (scene.variant === 'contracts') {
    const cards = scene.cards
      .map(
        (
          c,
          i,
        ) => `<div style="border-radius:22px;padding:34px 34px;border:1px solid rgba(255,255,255,.12);
        background:linear-gradient(180deg,rgba(139,92,246,.14),rgba(255,255,255,.015))">
        <div style="display:flex;align-items:center;gap:16px">
          <span style="width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;
            font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:600;color:#0A0F1E;
            background:linear-gradient(135deg,#C4B5FD,#8B5CF6)">${i + 1}</span>
          <span style="font-family:'JetBrains Mono',monospace;font-size:31px;font-weight:600;color:#EDE9FE">${esc(c.name)}</span>
        </div>
        <div style="margin-top:18px;font-size:26px;color:#A9B3CE;line-height:1.35">${esc(c.detail)}</div>
      </div>`,
      )
      .join('');
    return shell(
      scene,
      accent,
      `<div class="pad">
        <div class="kicker">${esc(scene.kicker)}</div>
        <h1 class="sm" style="margin-top:34px">${esc(scene.headline)}</h1>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:30px;margin-top:60px;flex:1">${cards}</div>
      </div>`,
    );
  }

  // architecture
  const rows = scene.layers
    .map(
      (l, i) => `<div style="display:flex;align-items:center;gap:34px;padding:22px 0;
        ${i ? 'border-top:1px solid rgba(255,255,255,.08)' : ''}">
        <div style="width:210px;flex:none;font-size:25px;letter-spacing:.16em;text-transform:uppercase;color:rgba(255,255,255,.42);font-weight:600">${esc(l.label)}</div>
        <div style="display:flex;gap:20px;flex-wrap:wrap">
          ${l.nodes
            .map(
              (
                n,
              ) => `<span style="padding:16px 28px;border-radius:14px;font-size:27px;font-weight:600;
              border:1px solid rgba(255,255,255,.14);
              background:linear-gradient(180deg,rgba(${i === 3 ? '52,211,153' : accent.rgb},.16),rgba(255,255,255,.02));
              color:#E6EBFA">${esc(n)}</span>`,
            )
            .join('')}
        </div>
      </div>`,
    )
    .join('');
  return shell(
    scene,
    accent,
    `<div class="pad">
      <div class="kicker">${esc(scene.kicker)}</div>
      <h1 class="sm" style="margin-top:34px">${esc(scene.headline)}</h1>
      <div style="margin-top:56px;flex:1;border-radius:26px;padding:26px 44px;
        border:1px solid rgba(255,255,255,.12);background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.012))">
        ${rows}
      </div>
    </div>`,
  );
}

// -------------------------------------------------------------------- ui

/**
 * A real screenshot inside a browser frame. The frame is sized to the source's
 * true 16:9 aspect so the capture is shown whole — no crop, no squeezed rows —
 * which matters when the screenshot is the evidence for a claim.
 */
function renderUi(scene) {
  const accent = ACCENTS.violet;
  const FRAME_W = 1440;
  const CHROME_H = 46;
  const SHOT_H = Math.round((FRAME_W * 9) / 16); // 810 — the full 16:9 viewport
  const callouts = (scene.callouts ?? [])
    .map(
      (
        c,
      ) => `<div style="position:absolute;left:${c.x}%;top:${c.y}%;transform:translate(-16px,-50%);
        display:flex;align-items:center;gap:14px;
        padding:15px 26px;border-radius:999px;font-size:23px;font-weight:600;white-space:nowrap;
        color:#0A0F1E;background:linear-gradient(120deg,#EFEFff,#BFD4FF);
        box-shadow:0 18px 46px -14px rgba(0,0,0,.85),0 0 0 1px rgba(255,255,255,.5)">
        <span style="width:11px;height:11px;border-radius:50%;background:#5B4CF5;flex:none"></span>${esc(c.label)}</div>`,
    )
    .join('');
  return shell(
    scene,
    accent,
    `<div class="pad" style="padding:58px 120px 0">
      <div style="display:flex;align-items:baseline;justify-content:space-between">
        <div class="kicker">${esc(scene.kicker ?? 'Product')}</div>
        <div style="font-size:23px;color:rgba(255,255,255,.42);font-family:'JetBrains Mono',monospace">${esc(scene.url ?? '')}</div>
      </div>
      <div style="margin-top:10px;font-size:26px;color:#9FB0D2;max-width:1440px">${esc(scene.caption ?? '')}</div>
      <div style="position:relative;margin-top:14px;width:${FRAME_W}px;border-radius:22px;
        background:#0B0F1C;border:1px solid rgba(255,255,255,.16);overflow:hidden;
        box-shadow:0 60px 140px -50px rgba(0,0,0,.95),0 0 0 1px rgba(255,255,255,.05) inset">
        <div style="height:${CHROME_H}px;display:flex;align-items:center;gap:12px;padding:0 22px;
          background:linear-gradient(180deg,rgba(255,255,255,.10),rgba(255,255,255,.03));
          border-bottom:1px solid rgba(255,255,255,.09)">
          <span style="width:13px;height:13px;border-radius:50%;background:#FF5F57"></span>
          <span style="width:13px;height:13px;border-radius:50%;background:#FEBC2E"></span>
          <span style="width:13px;height:13px;border-radius:50%;background:#28C840"></span>
          <span style="margin-left:18px;flex:1;height:26px;border-radius:13px;background:rgba(255,255,255,.07);
            display:flex;align-items:center;padding:0 18px;font-size:17px;color:rgba(255,255,255,.45);font-family:'JetBrains Mono',monospace">
            ${esc(scene.url ?? '')}</span>
        </div>
        <img src="${png(scene.asset)}" style="display:block;width:${FRAME_W}px;height:${SHOT_H}px;object-fit:cover;object-position:top center"/>
        ${callouts}
      </div>
    </div>`,
  );
}

// ---------------------------------------------------------------- gallery

/**
 * A hero screenshot with supporting shots beside it, each carrying a label —
 * for showing a whole product surface without shrinking the hero to illegibility.
 */
function renderGallery(scene) {
  const accent = ACCENTS.violet;
  const shot = (asset, height) =>
    `<img src="${png(asset)}" style="display:block;width:100%;height:${height}px;object-fit:cover;object-position:top center"/>`;
  const chip = (label) =>
    `<div style="display:flex;align-items:center;gap:12px;padding:16px 24px;border-bottom:1px solid rgba(255,255,255,.09);
      background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.02))">
      <span style="width:10px;height:10px;border-radius:50%;background:${accent.a};flex:none"></span>
      <span style="font-size:22px;font-weight:600;color:#D8DFF2;white-space:nowrap">${esc(label)}</span>
    </div>`;
  const card = (asset, label, width, shotH) =>
    `<div style="width:${width}px;border-radius:20px;overflow:hidden;background:#0B0F1C;
      border:1px solid rgba(255,255,255,.14);box-shadow:0 40px 110px -50px rgba(0,0,0,.95)">
      ${chip(label)}${shot(asset, shotH)}
    </div>`;

  const HERO_W = 1000;
  const SIDE_W = 620;
  // The side column is sized so it ends level with the hero card.
  const HERO_H = 600;
  const SIDE_H = Math.round((HERO_H - 87) / 2);
  return shell(
    scene,
    accent,
    `<div class="pad" style="padding:80px 120px 0">
      <div class="kicker">${esc(scene.kicker)}</div>
      <h1 class="sm" style="margin-top:28px">${esc(scene.headline)}</h1>
      <div style="display:flex;gap:34px;margin-top:46px;align-items:flex-start">
        ${card(scene.hero.asset, scene.hero.label, HERO_W, HERO_H)}
        <div style="display:flex;flex-direction:column;gap:32px">
          ${scene.cards.map((c) => card(c.asset, c.label, SIDE_W, SIDE_H)).join('')}
        </div>
      </div>
    </div>`,
  );
}

// ----------------------------------------------------------------- code

const RUST_KEYWORDS =
  'pub|fn|let|mut|if|else|return|match|impl|use|mod|struct|enum|for|in|while|loop|self|Self|crate|as|ref|where|const|static|trait|type|move|async|await|dyn|unsafe';

const TOKEN_RE = new RegExp(
  [
    '(\\/\\/.*$)', // 1 comment
    '("(?:[^"\\\\]|\\\\.)*")', // 2 string
    '(\\b\\d[\\d_]*(?:\\.\\d+)?\\b)', // 3 number
    '([a-z_][A-Za-z0-9_]*!)(?!=)', // 4 macro
    `(\\b(?:${RUST_KEYWORDS})\\b)`, // 5 keyword
    '(\\b[A-Z][A-Za-z0-9_]*\\b)', // 6 type / variant
  ].join('|'),
  'g',
);

const TOKEN_CLASS = ['', 'cm', 'st', 'nu', 'mc', 'kw', 'ty'];

/** Minimal Rust tokeniser — enough for an authentic, legible excerpt. */
function highlight(line) {
  let out = '';
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(line); m; m = TOKEN_RE.exec(line)) {
    out += esc(line.slice(last, m.index));
    const group = m.slice(1).findIndex((g) => g !== undefined) + 1;
    out += `<span class="${TOKEN_CLASS[group]}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
    if (m[0].length === 0) TOKEN_RE.lastIndex += 1;
  }
  out += esc(line.slice(last));
  return out || '&nbsp;';
}

function renderCode(scene) {
  const accent = ACCENTS.violet;
  const LINE_H = 29;
  const FONT = 20;
  const notesByLine = new Map((scene.notes ?? []).map((n, i) => [n.line, { ...n, index: i + 1 }]));

  const rows = scene.lines
    .map((line, i) => {
      const n = i + 1;
      const note = notesByLine.get(n);
      const bg = note ? 'background:rgba(139,92,246,.14);box-shadow:inset 3px 0 0 #8B5CF6' : '';
      return `<div style="display:flex;gap:26px;height:${LINE_H}px;line-height:${LINE_H}px;${bg}">
        <span style="flex:none;width:42px;text-align:right;color:#4E5A80;user-select:none">${n}</span>
        <span style="flex:none;width:26px;text-align:center">
          ${note ? `<span style="display:inline-block;width:20px;height:20px;line-height:20px;border-radius:50%;font-size:13px;font-weight:700;color:#0A0F1E;background:#C4B5FD;vertical-align:middle">${note.index}</span>` : ''}
        </span>
        <span style="white-space:pre">${highlight(line)}</span>
      </div>`;
    })
    .join('');

  const notes = (scene.notes ?? [])
    .map(
      (
        n,
        i,
      ) => `<div style="flex:1;display:flex;gap:18px;align-items:flex-start;padding:16px 24px;border-radius:18px;
        border:1px solid rgba(255,255,255,.12);background:linear-gradient(180deg,rgba(139,92,246,.12),rgba(255,255,255,.015))">
        <span style="flex:none;width:28px;height:28px;line-height:28px;text-align:center;border-radius:50%;
          font-size:15px;font-weight:700;color:#0A0F1E;background:#C4B5FD">${i + 1}</span>
        <span>
          <span style="display:block;font-size:23px;font-weight:700;color:#EDE9FE">${esc(n.title)}</span>
          <span style="display:block;margin-top:5px;font-size:20px;color:#A9B3CE;line-height:1.3">${esc(n.detail)}</span>
        </span>
      </div>`,
    )
    .join('');

  return shell(
    scene,
    accent,
    `<div class="pad" style="padding:56px 120px 0">
      <div style="display:flex;align-items:baseline;justify-content:space-between">
        <div class="kicker">${esc(scene.kicker)}</div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:21px;color:rgba(255,255,255,.42)">${esc(scene.file)}</div>
      </div>
      <h1 class="sm" style="margin-top:20px;font-size:60px">${esc(scene.headline)}</h1>
      <div style="margin-top:20px;border-radius:20px;overflow:hidden;border:1px solid rgba(255,255,255,.14);
        background:#080B16;box-shadow:0 50px 130px -60px rgba(0,0,0,.95)">
        <div style="display:flex;align-items:center;gap:14px;height:50px;padding:0 24px;
          background:linear-gradient(180deg,rgba(255,255,255,.09),rgba(255,255,255,.025));
          border-bottom:1px solid rgba(255,255,255,.09)">
          <span style="width:12px;height:12px;border-radius:50%;background:#FF5F57"></span>
          <span style="width:12px;height:12px;border-radius:50%;background:#FEBC2E"></span>
          <span style="width:12px;height:12px;border-radius:50%;background:#28C840"></span>
          <span style="margin-left:12px;font-family:'JetBrains Mono',monospace;font-size:19px;color:#8FA0C8">${esc(scene.file)}</span>
          <span style="margin-left:auto;font-size:16px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;
            color:#C4B5FD;border:1px solid rgba(196,181,253,.35);border-radius:999px;padding:5px 14px">${esc(scene.lang)}</span>
        </div>
        <div style="padding:18px 26px 22px;font-family:'JetBrains Mono',monospace;font-size:${FONT}px;color:#DCE3F5">
          ${rows}
        </div>
      </div>
      <div style="display:flex;gap:24px;margin-top:20px">${notes}</div>
    </div>`,
  );
}

// ------------------------------------------------------------------- outro

function renderOutro(scene) {
  const accent = ACCENTS.mint;
  return shell(
    scene,
    accent,
    `<div class="pad" style="justify-content:center;align-items:center;text-align:center">
      <div class="kicker" style="justify-content:center">${esc(scene.kicker)}</div>
      <h1 style="margin-top:42px">${esc(scene.headline)}</h1>
      <div style="margin-top:44px;font-family:'JetBrains Mono',monospace;font-size:27px;color:#B9C4E0;
        padding:26px 40px;border-radius:16px;border:1px solid rgba(255,255,255,.16);background:rgba(6,10,22,.75)">
        <span style="color:${accent.a}">$</span> ${esc(scene.sub)}
      </div>
      <div style="margin-top:50px;display:flex;gap:22px">
        ${scene.points
          .map(
            (p) => `<span style="padding:18px 30px;border-radius:999px;font-size:26px;color:#D7DEF2;
            border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05)">${esc(p)}</span>`,
          )
          .join('')}
      </div>
    </div>`,
  );
}

const RENDERERS = {
  statement: renderStatement,
  compare: renderCompare,
  stats: renderStats,
  ui: renderUi,
  gallery: renderGallery,
  code: renderCode,
  diagram: renderDiagram,
  outro: renderOutro,
};

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
});
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: DSF,
});

let overflows = 0;
for (const scene of scenes) {
  const render = RENDERERS[scene.kind];
  if (!render) throw new Error(`No renderer for scene kind "${scene.kind}" (${scene.id})`);
  const html = render(scene);
  const htmlFile = path.join(WORK, `${scene.id}.html`);
  fs.writeFileSync(htmlFile, html);
  await page.goto(`file://${htmlFile}`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);

  // Anything taller than the stage is silently clipped, and the video draws a
  // progress bar along the bottom edge — so check both that nothing is cut off
  // and that content stays clear of the bar.
  const fit = await page.evaluate((safeBottom) => {
    const stage = document.querySelector('.stage');
    const children = [...document.querySelector('.pad').children];
    const bottom = Math.round(Math.max(...children.map((el) => el.getBoundingClientRect().bottom)));

    // Overflow is invisible here — the stage clips and inner panels hide it — so
    // walk the tree looking for content wider or taller than its box.
    const clipped = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.clientWidth === 0) continue;
      if (el.scrollWidth > el.clientWidth + 2) {
        clipped.push(`wider by ${el.scrollWidth - el.clientWidth}px (${el.tagName.toLowerCase()})`);
      }
    }
    return { bottom, stageHeight: stage.clientHeight, clipped: clipped.slice(0, 3) };
  }, SAFE_BOTTOM);

  if (fit.bottom > fit.stageHeight) {
    overflows += 1;
    console.warn(`  ! ${scene.id} overflows the stage by ${fit.bottom - fit.stageHeight}px`);
  } else if (fit.bottom > SAFE_BOTTOM) {
    overflows += 1;
    console.warn(
      `  ! ${scene.id} reaches y=${fit.bottom}, into the progress-bar safe zone (max ${SAFE_BOTTOM})`,
    );
  }
  if (fit.clipped.length) {
    overflows += 1;
    console.warn(`  ! ${scene.id} has clipped content: ${fit.clipped.join('; ')}`);
  }

  const file = path.join(OUT, `${scene.id}.png`);
  await page.screenshot({ path: file });
  console.log(`${scene.id.padEnd(18)} ${scene.kind.padEnd(10)} -> ${path.relative(ROOT, file)}`);
}

await browser.close();
console.log(
  `\nRendered ${scenes.length} scenes into video/.work/scenes/ (${overflows} overflowing)`,
);
if (overflows > 0) process.exitCode = 1;
