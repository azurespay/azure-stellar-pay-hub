/**
 * Captures the product UI for the pitch video from the *local* stack
 * (API :4000, web :3000, admin :3001), authenticated with real tokens obtained
 * through the real auth flows, against the demo dataset.
 *
 * Screenshots are 1600x900 CSS at deviceScaleFactor 2 (3200x1800 px) so the
 * video can zoom in without softening the text.
 *
 * Pre-requisites:
 *   - `pnpm docker:up`, migrate, seed, then `video/build-demo-data.ts`
 *   - API on :4000, web on :3000, admin on :3001
 *   - `node video/get-tokens.mjs` has written .work/web-auth.json + admin-auth.json
 *
 * Usage: node video/capture.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'video', 'assets');
const WORK = path.join(ROOT, 'video', '.work');
const VIEWPORT = { width: 1600, height: 900 };
const DSF = 2;

const webAuth = JSON.parse(fs.readFileSync(path.join(WORK, 'web-auth.json'), 'utf8'));
const adminAuth = JSON.parse(fs.readFileSync(path.join(WORK, 'admin-auth.json'), 'utf8'));

const WEB = 'http://localhost:3000';
const ADMIN = 'http://localhost:3001';

fs.mkdirSync(OUT, { recursive: true });

// The apps persist sessions in localStorage; write the tokens before app code
// runs so every captured page renders in its signed-in state.
//
// The web dashboard additionally gates on `useWallet()`, which normally talks to
// the Freighter browser extension. Headless Chromium has no extension, so we
// install a test-double that speaks the extension's own postMessage protocol
// (`FREIGHTER_EXTERNAL_MSG_REQUEST` -> `FREIGHTER_EXTERNAL_MSG_RESPONSE`).
// No app code is modified: this is purely a browser-side stub of an external
// dependency, which is why the recorded UI is the real one.
const WALLET_STORAGE_KEY = 'stellar-pay:wallet';

async function webSession(browser, publicKey, colorScheme = 'dark') {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DSF,
    colorScheme,
  });
  await context.addInitScript(
    ([access, refresh, key, storageKey]) => {
      localStorage.setItem('stellar-pay:token', access);
      localStorage.setItem('stellar-pay:refresh', refresh);
      // Pre-seeded wallet => the provider's auto-reconnect path marks it connected.
      localStorage.setItem(storageKey, JSON.stringify({ provider: 'FREIGHTER', publicKey: key }));

      const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
      // `isConnected()` short-circuits to this global when it is truthy.
      window.freighter = { isConnected: true, publicKey: key };

      window.addEventListener('message', (event) => {
        const data = event.data;
        if (!data || data.source !== 'FREIGHTER_EXTERNAL_MSG_REQUEST') return;
        const respond = (payload) =>
          window.postMessage(
            { source: 'FREIGHTER_EXTERNAL_MSG_RESPONSE', messagedId: data.messageId, ...payload },
            window.location.origin,
          );
        switch (data.type) {
          case 'REQUEST_CONNECTION_STATUS':
            return respond({ isConnected: true });
          case 'REQUEST_PUBLIC_KEY':
          case 'REQUEST_ACCESS':
            return respond({ publicKey: key });
          case 'REQUEST_NETWORK':
            return respond({ network: NETWORK_PASSPHRASE });
          case 'REQUEST_NETWORK_DETAILS':
            return respond({
              networkDetails: {
                network: 'TESTNET',
                networkName: 'Testnet',
                networkUrl: 'https://horizon-testnet.stellar.org',
                networkPassphrase: NETWORK_PASSPHRASE,
              },
            });
          case 'SUBMIT_TRANSACTION':
            return respond({ signedTransaction: data.transactionXdr });
          default:
            return respond({});
        }
      });
    },
    [webAuth.accessToken, webAuth.refreshToken, publicKey, WALLET_STORAGE_KEY],
  );
  return context.newPage();
}

async function adminSession(browser, colorScheme = 'dark') {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DSF,
    colorScheme,
  });
  await context.addInitScript(
    ([access]) => localStorage.setItem('stellar-pay:admin-token', access),
    [adminAuth.accessToken],
  );
  return context.newPage();
}

async function shoot(
  page,
  name,
  url,
  { full = false, settle = 1600, width = VIEWPORT.width, height = VIEWPORT.height } = {},
) {
  await page.setViewportSize({ width, height });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(settle);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  const size = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));
  const text = (await page.evaluate(() => document.body.innerText))
    .replace(/\s+/g, ' ')
    .slice(0, 110);
  console.log(
    `${name.padEnd(24)} ${String(size.width).padStart(5)}x${String(size.height).padEnd(5)} "${text}"`,
  );
  return { file, ...size };
}

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
});

const demoKey = JSON.parse(fs.readFileSync(path.join(WORK, 'demo-key.json'), 'utf8'));
const web = await webSession(browser, demoKey.publicKey);
const admin = await adminSession(browser);

const WEB_PAGES = [
  ['web-landing', `${WEB}/`],
  ['web-dashboard', `${WEB}/dashboard`],
  ['web-send', `${WEB}/send`],
  ['web-receive', `${WEB}/receive`],
  ['web-history', `${WEB}/history`],
  ['web-contracts', `${WEB}/contracts`],
  ['web-merchant', `${WEB}/merchant`],
  ['web-settings', `${WEB}/settings`],
  ['web-checkout-link', `${WEB}/pay/demo-coffee`],
  ['web-checkout-invoice', `${WEB}/checkout/invoice/INV-2026-1002`],
];

const ADMIN_PAGES = [
  ['admin-login', `${ADMIN}/login`],
  ['admin-dashboard', `${ADMIN}/`],
  ['admin-transactions', `${ADMIN}/transactions`],
  ['admin-merchants', `${ADMIN}/merchants`],
  ['admin-users', `${ADMIN}/users`],
  ['admin-audit', `${ADMIN}/audit`],
  ['admin-assets', `${ADMIN}/assets`],
  ['admin-notifications', `${ADMIN}/notifications`],
  ['admin-settings', `${ADMIN}/settings`],
];

const manifest = {};
for (const [name, url] of WEB_PAGES) {
  manifest[name] = await shoot(web, name, url);
}
for (const [name, url] of ADMIN_PAGES) {
  manifest[name] = await shoot(admin, name, url);
}
manifest['web-dashboard-full'] = await shoot(web, 'web-dashboard-full', `${WEB}/dashboard`, {
  full: true,
});
manifest['web-merchant-full'] = await shoot(web, 'web-merchant-full', `${WEB}/merchant`, {
  full: true,
});

fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, 'ui-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nCaptured ${Object.keys(manifest).length} screenshots into video/assets/`);
await browser.close();
