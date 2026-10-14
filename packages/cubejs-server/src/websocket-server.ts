import WebSocket from 'ws';
import crypto from 'crypto';
import util from 'util';
import {
  CancelableInterval,
  createCancelableInterval,
  emitLogRateLimited,
  getEnv,
  getPodName,
} from '@cubejs-backend/shared';
import { Tracer } from '@cubejs-backend/tracer';

import type { CubejsServerCore } from '@cubejs-backend/server-core';
import type http from 'http';
import type https from 'https';
import { SubscriptionServer } from '@cubejs-backend/api-gateway';

import { WebSocketKeepAlive } from './ws-keepalive';

export interface WebSocketServerOptions {
  processSubscriptionsInterval?: number,
  webSocketsBasePath?: string,
  // Seconds between pings, 0 disables the keepalive; defaults to CUBEJS_WEB_SOCKETS_PING_INTERVAL
  webSocketsPingInterval?: number,
}

export class WebSocketServer {
  protected subscriptionsTimer: CancelableInterval | null = null;

  protected keepAlive: WebSocketKeepAlive | null = null;

  protected wsServer: WebSocket.Server | null = null;

  protected subscriptionServer: SubscriptionServer | null = null;

  public constructor(
    protected readonly serverCore: CubejsServerCore,
    protected readonly options: WebSocketServerOptions = {},
  ) { }

  public initServer(server: http.Server | https.Server) {
    this.wsServer = new WebSocket.Server({
      server,
      path: this.options.webSocketsBasePath,
      maxPayload: getEnv('maxRequestSize'),
    });

    const connectionIdToSocket: Record<string, any> = {};

    const pingSeconds = this.options.webSocketsPingInterval ?? getEnv('webSocketsPingInterval');
    this.keepAlive = pingSeconds > 0
      ? new WebSocketKeepAlive({
        intervalMs: pingSeconds * 1000,
        onTerminate: (connectionId) => {
          try {
            Tracer.init().get().increment('ws.connections_terminated', 1, { pod: getPodName() });
          } catch {
            // metrics must never break the keepalive
          }

          emitLogRateLimited('ws.connection_terminated', 60_000, 'info', 'cube.ws.connection_terminated', { connectionId });
        },
        onTick: (connectionCount) => {
          try {
            Tracer.init().get().gauge('ws.connections', connectionCount, { pod: getPodName() });
          } catch {
            // metrics must never break the keepalive
          }
        },
      })
      : null;

    this.subscriptionServer = this.serverCore.initSubscriptionServer(async (connectionId: string, message: any) => {
      const socket = connectionIdToSocket[connectionId];
      // The connection is gone (closed or terminated by the keepalive): late results of in-flight
      // polls are dropped instead of raising errors
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      let messageStr: string;

      if (message.message && message.message.isWrapper) {
        // In case we have a wrapped query result, we don't want to parse/stringify
        // it again - it's too expensive, instead we serialize the rest of the message and then
        // inject query result json into message.
        const resMsg = new TextDecoder().decode(await message.message.getFinalResult());
        delete message.message;
        messageStr = JSON.stringify(message);

        if (messageStr === '{}') {
          messageStr = `{"message":${resMsg}}`;
        } else {
          messageStr = `${messageStr.slice(0, -1)},"message":${resMsg}}`;
        }
      } else {
        messageStr = JSON.stringify(message);
      }

      socket.send(messageStr);
    });

    this.wsServer.on('connection', (ws) => {
      const connectionId = crypto.randomBytes(8).toString('hex');
      connectionIdToSocket[connectionId] = ws;
      this.keepAlive?.add(ws, connectionId);

      ws.on('message', async (message) => {
        await this.subscriptionServer!.processMessage(connectionId, message as string);
      });

      ws.on('close', async () => {
        delete connectionIdToSocket[connectionId];
        await this.subscriptionServer!.disconnect(connectionId);
      });

      ws.on('error', async () => {
        delete connectionIdToSocket[connectionId];
        await this.subscriptionServer!.disconnect(connectionId);
      });
    });

    const processSubscriptionsInterval = this.options.processSubscriptionsInterval || 5 * 1000;

    this.subscriptionsTimer = createCancelableInterval(
      async () => {
        await this.subscriptionServer!.processSubscriptions();
      },
      {
        interval: processSubscriptionsInterval,
        onDuplicatedExecution: (intervalId) => this.serverCore.logger('WebSocket Server Interval Error', {
          error: `Previous interval #${intervalId} was not finished with ${processSubscriptionsInterval} interval`
        }),
      }
    );
  }

  public async close() {
    if (this.subscriptionsTimer) {
      await this.subscriptionsTimer.cancel();
    }

    this.keepAlive?.close();

    if (this.wsServer) {
      const close = util.promisify(this.wsServer.close.bind(this.wsServer));
      await close();
    }

    if (this.subscriptionServer) {
      this.subscriptionServer.clear();
    }
  }
}
