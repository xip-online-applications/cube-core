import WebSocket from 'ws';
import crypto from 'crypto';
import util from 'util';
import { CancelableInterval, createCancelableInterval, getEnv } from '@cubejs-backend/shared';

import type { CubejsServerCore } from '@cubejs-backend/server-core';
import type http from 'http';
import type https from 'https';
import { SubscriptionServer } from '@cubejs-backend/api-gateway';

export interface WebSocketServerOptions {
  processSubscriptionsInterval?: number,
  webSocketsBasePath?: string,
}

export class WebSocketServer {
  protected subscriptionsTimer: CancelableInterval | null = null;

  protected wsServer: WebSocket.Server | null = null;

  protected subscriptionServer: SubscriptionServer | null = null;

  protected readonly connectionIdToSocket = new Map<string, WebSocket>();

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

    this.subscriptionServer = this.serverCore.initSubscriptionServer(async (connectionId: string, message: any) => {
      const socket = this.connectionIdToSocket.get(connectionId);
      // A query may finish after its client disconnected; there is no one left to send the result to
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
      this.connectionIdToSocket.set(connectionId, ws);

      // 'close' follows 'error', so this runs twice for an errored socket; both steps are idempotent
      const cleanup = async () => {
        this.connectionIdToSocket.delete(connectionId);
        await this.subscriptionServer!.disconnect(connectionId);
      };

      ws.on('message', async (message) => {
        await this.subscriptionServer!.processMessage(connectionId, message as string);
      });

      ws.on('close', cleanup);

      ws.on('error', cleanup);
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

    if (this.wsServer) {
      const close = util.promisify(this.wsServer.close.bind(this.wsServer));
      await close();
    }

    if (this.subscriptionServer) {
      this.subscriptionServer.clear();
    }
  }
}
