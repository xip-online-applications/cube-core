import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';

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
