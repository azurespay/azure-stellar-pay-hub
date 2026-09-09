# StellarPay Hub — Chrome Extension

A Chrome browser extension companion for the Azure StellarPay Hub platform.

## Features

- **Balance check** — View your XLM and asset balances at a glance
- **Quick-send** — Send payments without opening the full web app
- **Realtime notification client** — background service worker that connects to the API
  and maps payment events to Chrome desktop notifications (see note below on verification)
- **Wallet integration** — Connects directly to Freighter wallet for signing
- **Transaction history** — See your 5 most recent transactions in the popup

## Install (Development)

1. Build the extension:

   ```bash
   cd apps/extension
   pnpm install
   pnpm build
   ```

2. Load in Chrome:
   - Go to `chrome://extensions/`
   - Enable "Developer mode" (toggle top-right)
   - Click "Load unpacked"
   - Select the `apps/extension/` directory

3. The StellarPay Hub icon will appear in your Chrome toolbar.

## Usage

1. Click the extension icon to open the popup
2. Click **Connect Freighter** — this will prompt your Freighter wallet
3. Once connected, you'll see your balance and can send payments
4. Notifications appear automatically for incoming payments
5. Right-click the icon → **Options** to change the API URL

## Icons

Replace the placeholder icon files in `icons/` with actual PNGs:

- `icon16.png` (16×16)
- `icon48.png` (48×48)
- `icon128.png` (128×128)

## Architecture

```
popup.ts         ←→  background.ts     ←→  StellarPay API
(UI)                  (Socket.IO)           (NestJS /realtime)

lib/api.ts            lib/notifications.ts
(HTTP client)         (Socket.IO client + Chrome notifications)
```

The popup communicates with the background service worker via `chrome.runtime.sendMessage`.
The background worker maintains a persistent **Socket.IO** connection (`socket.io-client`,
websocket transport) to the API's `/realtime` gateway — authenticating with the JWT in the
`auth: { token }` handshake and joining the user's private room — and displays Chrome
desktop notifications for incoming payments, transaction status changes, and in-app
notifications. Reconnects with exponential backoff (1s → 30s).
