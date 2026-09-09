'use client';

import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL, getToken } from './api';

function getWsUrl(): string {
  // In development, Next.js proxies /socket.io/* → API, so use relative URL
  if (typeof window !== 'undefined' && API_URL === '') {
    return window.location.origin;
  }
  return API_URL;
}

/** Connect to the realtime gateway and subscribe to live events. */
export function useRealtime(onEvent: (event: string, payload: unknown) => void): void {
  const callbackRef = useRef(onEvent);
  callbackRef.current = onEvent;

  useEffect(() => {
    const token = getToken();
    if (!token) {
      return;
    }

    let socket: Socket;
    try {
      socket = io(`${getWsUrl()}/realtime`, {
        auth: { token },
        transports: ['websocket'],
        autoConnect: true,
        timeout: 10000,
        reconnectionAttempts: 5,
        reconnectionDelay: 2000,
      });
    } catch {
      // API not reachable — fail silently, will retry on next render
      return;
    }

    const onNotification = (payload: unknown) => callbackRef.current('notification', payload);
    const onTx = (payload: unknown) => callbackRef.current('transaction.updated', payload);
    const onPaymentReceived = (payload: unknown) =>
      callbackRef.current('payment.received', payload);

    socket.on('connect_error', () => {
      // Silently handle connection failures — API may be starting up
    });

    socket.on('notification', onNotification);
    socket.on('transaction.updated', onTx);
    socket.on('payment.received', onPaymentReceived);

    return () => {
      socket.off('notification', onNotification);
      socket.off('transaction.updated', onTx);
      socket.off('payment.received', onPaymentReceived);
      socket.disconnect();
    };
  }, [getToken]);
}
