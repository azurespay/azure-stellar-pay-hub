/**
 * Background service worker for the StellarPay Hub extension.
 * Manages WebSocket connection for real-time notifications and
 * handles messages from the popup.
 */

import { connect, disconnect } from './lib/notifications';
import { getToken, setToken, setPublicKey } from './lib/api';

// ── Lifecycle ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[StellarPay] Extension installed');
  // Attempt to connect if already authenticated
  getToken().then((token) => {
    if (token) connect();
  });
});

chrome.runtime.onStartup.addListener(() => {
  getToken().then((token) => {
    if (token) connect();
  });
});

// Keep service worker alive with a periodic alarm
chrome.alarms.create('keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // heartbeat — keeps the worker alive for WebSocket
  }
});

// ── Message handlers from popup ──────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse);
  return true; // async response
});

async function handleMessage(message: { type: string; payload?: unknown }) {
  switch (message.type) {
    case 'GET_CONNECTION_STATUS': {
      const token = await getToken();
      return { connected: !!token };
    }
    case 'LOGIN_SUCCESS': {
      const { token, publicKey } = message.payload as { token: string; publicKey: string };
      await setToken(token);
      await setPublicKey(publicKey);
      connect();
      return { ok: true };
    }
    case 'LOGOUT': {
      await setToken(null);
      await setPublicKey(null);
      disconnect();
      return { ok: true };
    }
    case 'RECONNECT': {
      const token = await getToken();
      if (token) connect();
      return { ok: true };
    }
    default:
      return { error: 'Unknown message type' };
  }
}

export {};
