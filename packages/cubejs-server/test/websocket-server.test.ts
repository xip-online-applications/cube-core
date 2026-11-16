import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import type { CubejsServerCore } from '@cubejs-backend/server-core';
import { LocalSubscriptionStore, SubscriptionServer } from '@cubejs-backend/api-gateway';
import type { WebSocketSendMessageFn } from '@cubejs-backend/api-gateway';

import { WebSocketServer } from '../src/websocket-server';
import { WebSocketKeepAlive } from '../src/ws-keepalive';

const mockStatsd = { increment: jest.fn(), gauge: jest.fn() };
let mockTracerThrows = false;

jest.mock('@cubejs-backend/tracer', () => ({
  Tracer: {
    init: () => ({
      get: () => {
        if (mockTracerThrows) {
          throw new Error('statsd down');
        }

        return mockStatsd;
      },
    }),
  },
}));

const waitFor = async (condition: () => boolean, timeoutMs = 3000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('waitFor timed out');
    }

    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

class TestWebSocketServer extends WebSocketServer {
  public get sockets() {
    return this.connectionIdToSocket;
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type SendMessage = (connectionId: string, message: any) => Promise<void>;

describe('WebSocketServer keepalive and cleanup', () => {
  let httpServer: http.Server;
  let wsServer: WebSocketServer;
  let sendMessage: SendMessage;
  let subscriptionServer: any;
  let clients: WebSocket[];
  let stdout: jest.SpyInstance;
  let logLines: any[];

  const setup = async (pingSeconds: number | undefined) => {
    subscriptionServer = {
      processMessage: jest.fn(async () => undefined),
      disconnect: jest.fn(async () => undefined),
      processSubscriptions: jest.fn(async () => undefined),
      clear: jest.fn(),
    };
    const serverCore: any = {
      initSubscriptionServer: jest.fn((fn: SendMessage) => {
        sendMessage = fn;

        return subscriptionServer;
      }),
      logger: jest.fn(),
    };
    httpServer = http.createServer();
    await new Promise<void>(resolve => { httpServer.listen(0, '127.0.0.1', resolve); });
    wsServer = new WebSocketServer(serverCore, {
      webSocketsPingInterval: pingSeconds,
      processSubscriptionsInterval: 60_000,
    });
    wsServer.initServer(httpServer);
  };

  // Connects a client, sends one message so the server registers it and returns its connection id
  const connect = async (): Promise<{ client: WebSocket, connectionId: string }> => {
    const { port } = httpServer.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });
    const before = subscriptionServer.processMessage.mock.calls.length;
    client.send('hello');
    await waitFor(() => subscriptionServer.processMessage.mock.calls.length > before);

    return { client, connectionId: subscriptionServer.processMessage.mock.calls[before][0] };
  };

  // The client stops reading from its TCP socket: it never answers pings, the connection stays open
  const goHalfOpen = (client: WebSocket) => {
    (client as any)._socket.pause();
  };

  beforeEach(() => {
    clients = [];
    logLines = [];
    mockTracerThrows = false;
    mockStatsd.increment.mockClear();
    mockStatsd.gauge.mockClear();
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      const text = String(chunk).trim();
      if (text.startsWith('{')) {
        try {
          logLines.push(JSON.parse(text));
        } catch {
          // not a JSON log line
        }
      }

      return true;
    });
  });

  afterEach(async () => {
    stdout.mockRestore();
    clients.forEach(client => client.terminate());
    // a test may already have closed the server
    await wsServer.close().catch(() => undefined);
    await new Promise<void>(resolve => { httpServer.close(() => resolve()); });
  });

  test('terminates a half-open client, counts it and logs it', async () => {
    await setup(0.1);
    const { client, connectionId } = await connect();
    goHalfOpen(client);

    await waitFor(() => subscriptionServer.disconnect.mock.calls.length > 0);

    expect(subscriptionServer.disconnect).toHaveBeenCalledTimes(1);
    expect(subscriptionServer.disconnect).toHaveBeenCalledWith(connectionId);
    expect(mockStatsd.increment).toHaveBeenCalledWith('ws.connections_terminated', 1, { pod: expect.any(String) });
    expect(logLines.find(l => l.event === 'cube.ws.connection_terminated')).toMatchObject({
      level: 'info',
      connectionId,
    });
  });

  test('a healthy client stays connected across several intervals', async () => {
    await setup(0.1);
    const { client } = await connect();

    await sleep(600);

    expect(subscriptionServer.disconnect).not.toHaveBeenCalled();
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  test('an interval of 0 disables the keepalive', async () => {
    await setup(0);
    const { client } = await connect();
    goHalfOpen(client);

    await sleep(400);

    expect(subscriptionServer.disconnect).not.toHaveBeenCalled();
  });

  test('disconnect runs on close and later sends to that connection are dropped', async () => {
    await setup(0);
    const { client, connectionId } = await connect();

    client.close();
    await waitFor(() => subscriptionServer.disconnect.mock.calls.length > 0);

    expect(subscriptionServer.disconnect).toHaveBeenCalledWith(connectionId);
    await expect(sendMessage(connectionId, { messageId: 1 })).resolves.toBeUndefined();
  });

  test('a send to an unknown connection is dropped without logging', async () => {
    await setup(0);

    await expect(sendMessage('does-not-exist', { messageId: 1 })).resolves.toBeUndefined();

    expect(logLines).toHaveLength(0);
  });

  test('in-flight sends after a termination do not log errors', async () => {
    await setup(0.1);
    const { client, connectionId } = await connect();
    goHalfOpen(client);
    await waitFor(() => subscriptionServer.disconnect.mock.calls.length > 0);

    await expect(sendMessage(connectionId, { messageId: 2 })).resolves.toBeUndefined();

    expect(logLines.filter(l => l.level === 'error' || l.event === 'cube.error')).toHaveLength(0);
  });

  test('a throwing tracer does not break termination', async () => {
    mockTracerThrows = true;
    await setup(0.1);
    const { client } = await connect();
    goHalfOpen(client);

    await waitFor(() => subscriptionServer.disconnect.mock.calls.length > 0);

    expect(subscriptionServer.disconnect).toHaveBeenCalledTimes(1);
  });

  test('the ws.connections gauge is emitted each tick with the pod tag', async () => {
    await setup(0.1);
    await connect();

    await waitFor(() => mockStatsd.gauge.mock.calls.length >= 2);

    expect(mockStatsd.gauge).toHaveBeenCalledWith('ws.connections', 1, { pod: expect.any(String) });
  });

  test('close() stops the keepalive', async () => {
    const closeSpy = jest.spyOn(WebSocketKeepAlive.prototype, 'close');
    await setup(0.1);

    await wsServer.close();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(subscriptionServer.clear).toHaveBeenCalledTimes(1);
    closeSpy.mockRestore();
  });
});

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

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  return { promise, resolve };
};

class TestSubscriptionStore extends LocalSubscriptionStore {
  public connectionIds(): string[] {
    return [...this.connections.keys()];
  }
}

describe('WebSocketServer error containment', () => {
  let httpServer: http.Server;
  let wsServer: WebSocketServer;
  let logger: jest.Mock;
  let processMessage: jest.Mock;
  let disconnect: jest.Mock;

  beforeEach(async () => {
    logger = jest.fn();
    processMessage = jest.fn();
    disconnect = jest.fn().mockResolvedValue(undefined);

    const serverCore: any = {
      logger,
      initSubscriptionServer: (sendMessage: WebSocketSendMessageFn) => ({
        processMessage: (connectionId: string, body: string) => processMessage(sendMessage, connectionId, body),
        processSubscriptions: async () => undefined,
        disconnect,
        clear: () => undefined,
      }),
    };

    httpServer = http.createServer();
    wsServer = new WebSocketServer(serverCore, { processSubscriptionsInterval: 60 * 1000 });
    wsServer.initServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await wsServer.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  const exchange = (body: string) => new Promise<{ code: number, messages: string[] }>((resolve, reject) => {
    const { port } = httpServer.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const messages: string[] = [];

    ws.on('open', () => ws.send(body));
    ws.on('message', (data) => {
      messages.push(data.toString());
      ws.close();
    });
    ws.on('close', (code) => resolve({ code, messages }));
    ws.on('error', reject);
  });

  test('closes only the affected connection when a reply cannot be serialized', async () => {
    let sendError: unknown;
    // JSON.stringify throws on a BigInt on every Node.js version, unlike on deep nesting
    processMessage.mockImplementation(async (sendMessage: WebSocketSendMessageFn, connectionId: string) => {
      try {
        await sendMessage(connectionId, { messageId: BigInt(1), message: { error: 'Invalid message format' }, status: 400 });
      } catch (e) {
        sendError = e;
      }
    });

    const { code } = await exchange('{}');

    expect(code).toBe(1011);
    expect(sendError).toBeInstanceOf(TypeError);
    expect(logger).toHaveBeenCalledWith('WebSocket Send Error', expect.objectContaining({ error: expect.any(String) }));

    processMessage.mockImplementation(async (sendMessage: WebSocketSendMessageFn, connectionId: string) => {
      await sendMessage(connectionId, { handshake: true });
    });

    await expect(exchange('{}')).resolves.toEqual({ code: 1005, messages: ['{"handshake":true}'] });
  });

  test('contains an exception thrown while processing a message', async () => {
    processMessage.mockRejectedValue(new Error('boom'));

    const { code } = await exchange('{}');

    expect(code).toBe(1011);
    expect(logger).toHaveBeenCalledWith('WebSocket Message Error', expect.objectContaining({ error: expect.stringContaining('boom') }));
  });

  test('drops a reply to a client that has already disconnected', async () => {
    let send: (() => Promise<void>) | undefined;
    processMessage.mockImplementation(async (sendMessage: WebSocketSendMessageFn, connectionId: string) => {
      send = () => sendMessage(connectionId, { messageId: '1', message: {}, status: 200 });
      await send();
    });

    const disconnected = new Promise((resolve) => disconnect.mockImplementation(async () => resolve(undefined)));
    await exchange('{}');
    await disconnected;

    await expect(send!()).resolves.toBeUndefined();
    expect(logger).not.toHaveBeenCalled();
  });
});

describe('WebSocketServer with SubscriptionServer', () => {
  let httpServer: http.Server;
  let wsServer: WebSocketServer;
  let store: TestSubscriptionStore;
  let gateway: any;
  let disconnected: Promise<void>;

  beforeEach(async () => {
    store = new TestSubscriptionStore();
    gateway = {
      checkAuthFn: jest.fn().mockResolvedValue(undefined),
      contextByReq: jest.fn().mockResolvedValue({ requestId: 'test-req' }),
      log: jest.fn(),
      handleError: jest.fn(),
    };

    let subscriptionServer: SubscriptionServer;
    const serverCore: any = {
      logger: jest.fn(),
      initSubscriptionServer: (sendMessage: WebSocketSendMessageFn) => {
        subscriptionServer = new SubscriptionServer(
          gateway,
          sendMessage,
          store,
          async () => ({ accepted: true }),
          { on: jest.fn(), emit: jest.fn().mockReturnValue(true) },
        );
        disconnected = new Promise((resolve) => {
          const disconnect = subscriptionServer.disconnect.bind(subscriptionServer);
          subscriptionServer.disconnect = async (connectionId: string) => {
            await disconnect(connectionId);
            resolve();
          };
        });

        return subscriptionServer;
      },
    };

    httpServer = http.createServer();
    wsServer = new WebSocketServer(serverCore, { processSubscriptionsInterval: 60 * 1000 });
    wsServer.initServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await wsServer.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  test('does not bring the connection back when a subscribe finishes after the disconnect', async () => {
    const load = deferred();
    const started = deferred();
    const finished = deferred();
    // Mirrors the gateway: load, reply, then record the subscription
    gateway.subscribe = jest.fn(async ({ res, subscribe }) => {
      started.resolve();
      await load.promise;
      await res({ data: [] });
      await subscribe({ resultHash: 'hash' });
      finished.resolve();
    });

    const { port } = httpServer.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const received: any[] = [];
    ws.on('open', () => ws.send(JSON.stringify({ authorization: 'token' })));
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      received.push(message);

      if (message.handshake) {
        ws.send(JSON.stringify({ method: 'subscribe', messageId: '1', params: { query: { measures: ['Orders.count'] } } }));
      }
    });

    await started.promise;
    expect(store.connectionIds()).toHaveLength(1);

    ws.close();
    await disconnected;
    expect(store.connectionIds()).toEqual([]);

    load.resolve();
    await finished.promise;

    expect(store.connectionIds()).toEqual([]);
    expect(store.getAllSubscriptions()).toEqual([]);
    expect(received).toEqual([{ handshake: true }]);
    expect(gateway.handleError).not.toHaveBeenCalled();
  });
});
