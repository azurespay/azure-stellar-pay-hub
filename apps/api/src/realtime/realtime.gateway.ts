import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayInit,
} from '@nestjs/websockets';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { ConfigService } from '@nestjs/config';
import { verifyAccessToken } from '@stellar-pay/authentication';
import Redis from 'ioredis';

/**
 * Socket.IO gateway. Clients authenticate via `auth.token` (JWT) in the
 * handshake; each user joins a private room named `user:<id>`.
 *
 * Uses the Socket.IO Redis adapter so events fan out across API instances:
 * the in-memory adapter would silently drop cross-instance deliveries as soon
 * as the API scales past one replica. If Redis is unreachable at boot the
 * gateway falls back to the in-memory adapter (single-instance operation)
 * rather than taking the process down.
 */
@WebSocketGateway({
  cors: { origin: true, credentials: true },
  namespace: '/realtime',
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, OnApplicationShutdown
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger('RealtimeGateway');

  private adapterClients: Redis[] = [];
  private adapterAttached = false;

  constructor(private readonly config: ConfigService) {}

  afterInit(server: Server): void {
    const redisUrl = this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    if (!redisUrl) {
      return;
    }
    try {
      const pubClient = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        // The ready check runs INFO, which ioredis forbids on a connection
        // that is in subscriber mode. With the check enabled on the subscriber
        // (duplicate() inherits these options), any reconnect re-runs INFO and
        // throws "Connection in subscriber mode, only subscriber commands may
        // be used" — a crash that took down the tier-3 e2e in CI. Subscribers
        // don't need a ready check, so disable it for both clients and attach
        // the adapter once both have connected.
        enableReadyCheck: false,
      });
      const subClient = pubClient.duplicate({ enableReadyCheck: false });
      this.adapterClients.push(pubClient, subClient);
      // Runtime errors are handled by ioredis auto-reconnect; log but never
      // tear down an already-attached adapter on a transient blip.
      const onError = (err: Error) =>
        this.logger.warn({ err: err.message }, 'socket.io redis adapter error');
      pubClient.on('error', onError);
      subClient.on('error', onError);
      let pubReady = false;
      let subReady = false;
      const attachAdapter = () => {
        if (!pubReady || !subReady || this.adapterAttached) {
          return;
        }
        try {
          // For a namespaced gateway Nest injects the Namespace, whose
          // `.adapter` is the current adapter object — the setter lives on the
          // underlying io Server (`namespace.server`). Setting it there also
          // re-initializes the namespace with the Redis adapter.
          const ioServer = (server as unknown as { server?: Server }).server ?? server;
          ioServer.adapter(createAdapter(pubClient, subClient));
          this.adapterAttached = true;
          this.logger.log('Socket.IO Redis adapter attached (multi-instance fan-out)');
        } catch (err) {
          this.logger.warn(`Failed to attach Socket.IO Redis adapter — ${(err as Error).message}`);
        }
      };
      pubClient.once('ready', () => {
        pubReady = true;
        attachAdapter();
      });
      subClient.once('ready', () => {
        subReady = true;
        attachAdapter();
      });
    } catch (err) {
      this.logger.warn(`Failed to attach Socket.IO Redis adapter — ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    // When the adapter never attached (e.g. Redis down at boot) there is no
    // adapter close to unwind, so disconnect here to avoid leaked handles.
    if (!this.adapterAttached) {
      this.disconnectAdapterClients();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    // Nest teardown order is: onModuleDestroy hooks → socketModule.close()
    // (closes the io server + Redis adapter) → onApplicationShutdown hooks.
    // The Socket.IO Redis adapter's close only unsubscribes — it never
    // disconnects the pub/sub clients — so disconnect them here, strictly
    // after the adapter's own close has run. Doing it in onModuleDestroy would
    // race the adapter close and throw "Connection is closed".
    if (this.adapterAttached) {
      this.disconnectAdapterClients();
    }
  }

  private disconnectAdapterClients(): void {
    if (this.adapterClients.length === 0) {
      return;
    }
    // disconnect() force-closes without waiting for a QUIT round-trip — safe
    // during shutdown and never hangs on a flaky connection.
    for (const client of this.adapterClients) {
      if (client.status !== 'end') {
        client.disconnect();
      }
    }
    this.adapterClients = [];
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) {
        throw new Error('missing token');
      }
      const payload = verifyAccessToken(token, this.config.get<string>('JWT_SECRET')!);
      await client.join(`user:${payload.sub}`);
      this.logger.log(`socket connected: user=${payload.sub} socket=${client.id}`);
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`socket disconnected: ${client.id}`);
  }

  /** Emit a live event to a user's room. */
  emitToUser(userId: string, event: string, payload: unknown): void {
    this.server.to(`user:${userId}`).emit(event, payload);
  }
}
