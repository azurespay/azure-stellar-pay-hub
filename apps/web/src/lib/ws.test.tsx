import { renderHook } from '@testing-library/react';
import { io } from 'socket.io-client';
import { getToken } from './api';
import { useRealtime } from './ws';

jest.mock('socket.io-client', () => ({ io: jest.fn() }));
jest.mock('./api', () => ({ API_URL: '', getToken: jest.fn() }));

const mockIo = io as unknown as jest.Mock;
const mockGetToken = getToken as unknown as jest.Mock;

type Handler = (payload?: unknown) => void;

/** A minimal stand-in for the Socket.IO client, with its handlers wired up. */
function fakeSocket() {
  const handlers = new Map<string, Handler>();
  return {
    on: jest.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    }),
    off: jest.fn(),
    disconnect: jest.fn(),
    emitFromServer: (event: string, payload?: unknown) => handlers.get(event)?.(payload),
    handlers,
  };
}

describe('useRealtime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not open a socket without a token', () => {
    mockGetToken.mockReturnValue(null);
    renderHook(() => useRealtime(jest.fn()));

    expect(mockIo).not.toHaveBeenCalled();
  });

  it('authenticates the realtime channel with the bearer token', () => {
    mockGetToken.mockReturnValue('jwt-token');
    mockIo.mockReturnValue(fakeSocket());

    renderHook(() => useRealtime(jest.fn()));

    expect(mockIo).toHaveBeenCalledTimes(1);
    const [url, options] = mockIo.mock.calls[0];
    expect(url).toBe(`${window.location.origin}/realtime`);
    expect(options).toMatchObject({ auth: { token: 'jwt-token' }, transports: ['websocket'] });
  });

  it('forwards each gateway event to the caller', () => {
    const onEvent = jest.fn();
    const socket = fakeSocket();
    mockGetToken.mockReturnValue('jwt-token');
    mockIo.mockReturnValue(socket);

    renderHook(() => useRealtime(onEvent));

    socket.emitFromServer('notification', { id: 'n1' });
    socket.emitFromServer('transaction.updated', { id: 'tx1' });
    socket.emitFromServer('payment.received', { id: 'p1' });

    expect(onEvent).toHaveBeenCalledWith('notification', { id: 'n1' });
    expect(onEvent).toHaveBeenCalledWith('transaction.updated', { id: 'tx1' });
    expect(onEvent).toHaveBeenCalledWith('payment.received', { id: 'p1' });
  });

  it('always calls the latest callback, without reconnecting', () => {
    const first = jest.fn();
    const second = jest.fn();
    const socket = fakeSocket();
    mockGetToken.mockReturnValue('jwt-token');
    mockIo.mockReturnValue(socket);

    const { rerender } = renderHook(
      ({ cb }: { cb: (event: string, payload: unknown) => void }) => useRealtime(cb),
      {
        initialProps: { cb: first },
      },
    );
    rerender({ cb: second });

    socket.emitFromServer('notification', { id: 'n1' });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('notification', { id: 'n1' });
    expect(mockIo).toHaveBeenCalledTimes(1);
  });

  it('unbinds its handlers and disconnects on unmount', () => {
    const socket = fakeSocket();
    mockGetToken.mockReturnValue('jwt-token');
    mockIo.mockReturnValue(socket);

    const { unmount } = renderHook(() => useRealtime(jest.fn()));
    unmount();

    for (const event of ['notification', 'transaction.updated', 'payment.received']) {
      expect(socket.off).toHaveBeenCalledWith(event, expect.any(Function));
    }
    expect(socket.disconnect).toHaveBeenCalled();
  });
});
