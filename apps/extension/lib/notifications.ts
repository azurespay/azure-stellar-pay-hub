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

          socket.on('transaction.updated', (payload: unknown) => handleTransactionUpdated(payload));
          socket.on('payment.received', (payload: unknown) => handlePaymentReceived(payload));
          socket.on('notification', (payload: unknown) => handleNotification(payload));
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

interface TransactionUpdated {
  id?: string;
  status?: string;
}

interface PaymentReceived {
  transactionId?: string;
  status?: string;
  fromPublicKey?: string;
  toPublicKey?: string;
  amount?: string;
  assetCode?: string;
}

interface Notification {
  title?: string;
  message?: string;
  body?: string;
  type?: string;
}

function handleTransactionUpdated(payload: TransactionUpdated): void {
  const { id, status } = payload;
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

function handlePaymentReceived(payload: PaymentReceived): void {
  const amount = payload.amount ?? '';
  const asset = payload.assetCode ?? 'XLM';
  const from = shortKey(payload.fromPublicKey ?? '');
  showNotification('Payment Received', `${amount} ${asset} from ${from}`);
}

function handleNotification(payload: Notification): void {
  const title = payload.title ?? 'StellarPay Notification';
  const message = payload.message ?? payload.body ?? '';
  if (message) {
    showNotification(title, message);
  }
  notifyPopup({ type: 'NOTIFICATION', payload });
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
