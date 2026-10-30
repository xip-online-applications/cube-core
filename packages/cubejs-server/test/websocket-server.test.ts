/* globals describe,test,expect,jest,beforeEach,afterEach */
import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import type { CubejsServerCore } from '@cubejs-backend/server-core';

import { WebSocketServer } from '../src/websocket-server';

class TestWebSocketServer extends WebSocketServer {
  public get sockets() {
    return this.connectionIdToSocket;
  }
}

const waitFor = async (predicate: () => boolean, timeout = 2000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeout) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const createServerCore = () => {
  let sendMessage: (connectionId: string, message: any) => Promise<void> = async () => undefined;
  const subscriptionServer = {
    processMessage: jest.fn(async () => undefined),
    processSubscriptions: jest.fn(async () => undefined),
    disconnect: jest.fn(async () => undefined),
    clear: jest.fn(),
  };
  const serverCore = {
    initSubscriptionServer: (fn: typeof sendMessage) => {
      sendMessage = fn;
      return subscriptionServer;
    },
    logger: jest.fn(),
  } as unknown as CubejsServerCore;

  return { serverCore, subscriptionServer, sendMessage: (connectionId: string, message: any) => sendMessage(connectionId, message) };
};

describe('WebSocketServer', () => {
  let httpServer: http.Server;
  let wsServer: TestWebSocketServer;
  let mocks: ReturnType<typeof createServerCore>;
  let url: string;

  const connect = async () => {
    const client = new WebSocket(url);
    await new Promise((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    return client;
  };

  beforeEach(async () => {
    mocks = createServerCore();
    httpServer = http.createServer();
    wsServer = new TestWebSocketServer(mocks.serverCore, { processSubscriptionsInterval: 60 * 1000 });
    wsServer.initServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    url = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await wsServer.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  test('removes a socket from the map when the client closes', async () => {
    const client = await connect();
    await waitFor(() => wsServer.sockets.size === 1);

    client.close();
    await waitFor(() => wsServer.sockets.size === 0);

    expect(mocks.subscriptionServer.disconnect).toHaveBeenCalledTimes(1);
  });

  test('removes a socket from the map when the socket errors', async () => {
    const client = await connect();
    await waitFor(() => wsServer.sockets.size === 1);

    const [[connectionId, socket]] = [...wsServer.sockets.entries()];
    socket.emit('error', new Error('boom'));
    await waitFor(() => wsServer.sockets.size === 0);

    expect(mocks.subscriptionServer.disconnect).toHaveBeenCalledWith(connectionId);
    client.terminate();
  });

  test('ignores messages sent to a connection that has closed', async () => {
    const client = await connect();
    await waitFor(() => wsServer.sockets.size === 1);
    const [connectionId] = [...wsServer.sockets.keys()];

    client.close();
    await waitFor(() => wsServer.sockets.size === 0);

    await expect(mocks.sendMessage(connectionId, { message: 'late result' })).resolves.toBeUndefined();
  });

  test('delivers messages to an open connection', async () => {
    const client = await connect();
    await waitFor(() => wsServer.sockets.size === 1);
    const [connectionId] = [...wsServer.sockets.keys()];

    const received = new Promise((resolve) => client.once('message', resolve));
    await mocks.sendMessage(connectionId, { message: 'hello' });

    expect(JSON.parse((await received) as string)).toEqual({ message: 'hello' });
    client.close();
  });
});
