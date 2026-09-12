/**
 * Realtime notification client for the background service worker.
 *
 * The API's `/realtime` gateway is **Socket.IO** (not raw WebSocket): clients
 * authenticate with a JWT in the handshake (`auth.token`), join their private
 * `user:<id>` room server-side, and receive `transaction.updated`,
 * `payment.received` and `notification` events. This client speaks that
 * protocol with `socket.io-client` (websocket transport) and forwards events
 * to Chrome notifications and the popup via chrome.runtime messaging.
 */

import { io, type Socket } from 'socket.io-client';
import { getApiUrl, getToken } from './api';

let socket: Socket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;

export function connect(): void {
  disconnect();

  getToken()
    .then((token) => {
      if (!token) return;

      getApiUrl()
        .then((apiUrl) => {
          // The gateway is mounted at the `/realtime` namespace with the
          // default Socket.IO path. Auth goes in the handshake, never the URL
          // query string (which would leak the JWT into logs).
          try {
            socket = io(`${apiUrl}/realtime`, {
              transports: ['websocket'],
              auth: { token },
              reconnection: false, // we manage reconnects below (backoff)
              timeout: 10_000,
            });
          } catch {
            console.warn('[StellarPay] Socket.IO connection failed — retrying later');
            scheduleReconnect();
            return;
          }

          socket.on('connect', () => {
            console.log('[StellarPay] realtime connected');
            reconnectDelay = 1000;
            notifyPopup({ type: 'CONNECTION_STATUS', connected: true });
          });

          socket.on('connect_error', (err) => {
            // e.g. missing/expired token, or the server rejected the handshake.
            console.warn('[StellarPay] realtime connect_error:', err.message);
            notifyPopup({ type: 'CONNECTION_STATUS', connected: false });
            scheduleReconnect();
          });

          socket.on('disconnect', (reason) => {
            console.log('[StellarPay] realtime disconnected:', reason);
            notifyPopup({ type: 'CONNECTION_STATUS', connected: false });
            scheduleReconnect();
          });

          socket.on('transaction.updated', (payload) => handleTransactionUpdated(payload));
          socket.on('payment.received', (payload) => handlePaymentReceived(payload));
          socket.on('notification', (payload) => handleNotification(payload));
        })
        .catch(() => {
          scheduleReconnect();
        });
    })
    .catch(() => {
      scheduleReconnect();
    });
}

export function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  notifyPopup({ type: 'CONNECTION_STATUS', connected: false });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    connect();
  }, reconnectDelay);
}

function notifyPopup(message: unknown): void {
  try {
    chrome.runtime.sendMessage({ source: 'stellarpay-background', ...(message as object) });
  } catch {
    // popup not open — ignore
  }
}

// ── Event handlers ────────────────────────────────────────────
//
// Realtime payloads are untrusted network data, so handlers read the string
// fields they need instead of casting the event to an interface: a malformed or
// renamed field must not throw inside the service worker (which would kill the
// notification client silently).

/** Keep only the named string fields of an unknown payload. */
function pickStrings<T extends string>(
  payload: unknown,
  keys: readonly T[],
): Partial<Record<T, string>> {
  const picked: Partial<Record<T, string>> = {};
  if (typeof payload !== 'object' || payload === null) {
    return picked;
  }
  const source = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string') {
      picked[key] = value;
    }
  }
  return picked;
}

function handleTransactionUpdated(payload: unknown): void {
  const { id, status } = pickStrings(payload, ['id', 'status']);
  if (status === 'SUCCEEDED' || status === 'CONFIRMED') {
    showNotification('Payment Successful', `Transaction ${shortKey(id ?? '')} confirmed on-chain`);
  } else if (status === 'FAILED') {
    showNotification(
      'Payment Failed',
      `Transaction ${shortKey(id ?? '')} was rejected by the network`,
    );
  } else {
    showNotification(
      'Transaction Updated',
      `Transaction ${shortKey(id ?? '')} is ${status ?? 'processing'}`,
    );
  }
}

function handlePaymentReceived(payload: unknown): void {
  const { amount, assetCode, fromPublicKey } = pickStrings(payload, [
    'amount',
    'assetCode',
    'fromPublicKey',
  ]);
  const asset = assetCode ?? 'XLM';
  const from = shortKey(fromPublicKey ?? '');
  showNotification('Payment Received', `${amount ?? ''} ${asset} from ${from}`);
}

function handleNotification(payload: unknown): void {
  const { title, message, body } = pickStrings(payload, ['title', 'message', 'body']);
  const resolvedTitle = title ?? 'StellarPay Notification';
  const resolvedMessage = message ?? body ?? '';
  if (resolvedMessage) {
    showNotification(resolvedTitle, resolvedMessage);
  }
  notifyPopup({
    type: 'NOTIFICATION',
    payload: { title: resolvedTitle, message: resolvedMessage },
  });
}

function showNotification(title: string, message: string): void {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: 2,
  });
}

function shortKey(key: string): string {
  if (!key || key.length <= 12) return key;
  return key.slice(0, 6) + '…' + key.slice(-4);
}
