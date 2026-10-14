import http from 'http';
import { AddressInfo } from 'net';

import { WebSocketServer } from '../src/websocket-server';

jest.mock('@cubejs-backend/tracer', () => ({
  Tracer: { init: () => ({ get: () => ({ increment: jest.fn(), gauge: jest.fn() }) }) },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { run } = require('../../scripts/ws-half-open-check.js');

type SendMessage = (connectionId: string, message: any) => Promise<void>;

describe('ws-half-open-check script', () => {
  let httpServer: http.Server;
  let wsServer: WebSocketServer;
  let stdout: jest.SpyInstance;

  // A server whose subscription server answers the authorization message with a handshake and
  // a subscribe message with a first result, like the real one
  const setup = async (pingSeconds: number) => {
    let sendMessage: SendMessage = async () => undefined;
    const subscriptionServer = {
      processMessage: jest.fn(async (connectionId: string, raw: string) => {
        if (String(raw).includes('authorization')) {
          await sendMessage(connectionId, { handshake: true });
        } else if (String(raw).includes('subscribe')) {
          await sendMessage(connectionId, { messageId: JSON.parse(String(raw)).messageId, message: {} });
        }
      }),
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

    return `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  };

  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    stdout.mockRestore();
    if (wsServer) {
      await wsServer.close().catch(() => undefined);
    }

    if (httpServer) {
      await new Promise<void>(resolve => { httpServer.close(() => resolve()); });
    }
  });

  test('PASS when the server terminates the frozen client', async () => {
    const url = await setup(0.1);

    const outcome = await run({ url, token: 't', query: { measures: ['Orders.count'] }, freezeSeconds: 1, log: () => undefined });

    expect(outcome.result).toBe('PASS');
    expect(typeof outcome.closeCode).toBe('number');
  });

  test('FAIL when the keepalive is disabled', async () => {
    const url = await setup(0);

    const outcome = await run({
      url,
      token: 't',
      query: { measures: ['Orders.count'] },
      freezeSeconds: 0.5,
      closeWaitSeconds: 0.5,
      log: () => undefined,
    });

    expect(outcome.result).toBe('FAIL');
  });

  test('rejects when the server is unreachable', async () => {
    await expect(run({ url: 'ws://127.0.0.1:1', token: 't', query: {}, freezeSeconds: 0.1, log: () => undefined })).rejects.toThrow();
  });

  test('rejects when the query is missing', async () => {
    await expect(run({ url: 'ws://127.0.0.1:1', token: 't', freezeSeconds: 0.1, log: () => undefined })).rejects.toThrow(/query/);
  });
});
