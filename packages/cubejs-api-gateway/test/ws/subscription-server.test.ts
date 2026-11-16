import { SubscriptionServer } from '../../src/ws/subscription-server';
import { LocalSubscriptionStore, LocalSubscriptionStoreConnection } from '../../src/ws/local-subscription-store';
import { ApiGateway } from '../../src/gateway';

jest.mock('@cubejs-backend/tracer', () => ({
  Tracer: { init: () => ({ get: () => ({ increment: jest.fn(), gauge: jest.fn() }) }) },
}));

// Each server runs a bufferTime timer and each real store a 60 s summary interval: both are
// closed after every test, so nothing keeps Jest alive or fires after its teardown
const servers: SubscriptionServer[] = [];
const track = (server: SubscriptionServer) => {
  servers.push(server);
  return server;
};

afterEach(() => {
  servers.splice(0).forEach(server => server.close());
});

class TestSubscriptionStore extends LocalSubscriptionStore {
  public connectionIds(): string[] {
    return [...this.connections.keys()];
  }
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  return { promise, resolve };
};

const noopEventEmitter = () => ({ on: jest.fn(), emit: jest.fn().mockReturnValue(true) });

const createMocks = () => {
  const sentMessages: any[] = [];

  const mockApiGateway: any = {
    checkAuthFn: jest.fn().mockResolvedValue(undefined),
    contextByReq: jest.fn().mockResolvedValue({ requestId: 'test-req' }),
    log: jest.fn(),
    handleError: jest.fn(),
    load: jest.fn().mockResolvedValue(undefined),
    sql: jest.fn().mockResolvedValue(undefined),
    dryRun: jest.fn().mockResolvedValue(undefined),
    meta: jest.fn().mockResolvedValue(undefined),
    metaExtended: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
  };

  const mockSubscriptionStore: any = {
    connect: jest.fn().mockReturnValue(new LocalSubscriptionStoreConnection()),
    setAuthContext: jest.fn().mockResolvedValue(undefined),
    getAuthContext: jest.fn().mockResolvedValue({ securityContext: {} }),
    subscribe: jest.fn().mockResolvedValue(undefined),
    unsubscribe: jest.fn().mockResolvedValue(undefined),
    getSubscription: jest.fn().mockResolvedValue(null),
  };

  const mockSendMessage = jest.fn().mockImplementation(async (_connId, msg) => {
    sentMessages.push(msg);
  });

  const mockContextAcceptor = jest.fn().mockResolvedValue({ accepted: true });

  const mockEventEmitterInterface = {
    on: jest.fn(),
    emit: jest.fn(),
  };

  return {
    mockApiGateway,
    mockSubscriptionStore,
    mockSendMessage,
    mockContextAcceptor,
    sentMessages,
    mockEventEmitterInterface,
  };
};

describe('SubscriptionServer', () => {
  describe('Subscription tick', () => {
    // JSON.stringify throws on a BigInt on every Node.js version, unlike on deep nesting
    const unserializableQuery = { limit: BigInt(1) };

    const subscriptionMessage = (messageId: string, query: unknown) => ({
      method: 'subscribe',
      messageId,
      params: { query },
    });

    const createServer = () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor } = createMocks();
      mockSubscriptionStore.getAllSubscriptions = jest.fn().mockReturnValue([
        { connectionId: 'conn-1', message: subscriptionMessage('1', unserializableQuery) },
        { connectionId: 'conn-2', message: subscriptionMessage('2', { measures: ['Orders.count'] }) },
      ]);
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, noopEventEmitter()));

      return { server, mockApiGateway };
    };

    it('should route a message that cannot be measured to error handling', async () => {
      const { server, mockApiGateway } = createServer();

      await expect(server.processSubscriptions()).resolves.toBeUndefined();

      expect(mockApiGateway.handleError).toHaveBeenCalledTimes(1);
      expect(mockApiGateway.handleError.mock.calls[0][0].e).toBeInstanceOf(TypeError);
      expect(mockApiGateway.subscribe).toHaveBeenCalledTimes(1);
      expect(mockApiGateway.subscribe).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'conn-2' }));
    });

    it('should not abort the tick when error handling itself fails', async () => {
      const { server, mockApiGateway } = createServer();
      mockApiGateway.handleError.mockImplementation(() => {
        throw new RangeError('Maximum call stack size exceeded');
      });

      await expect(server.processSubscriptions()).resolves.toBeUndefined();

      expect(mockApiGateway.subscribe).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'conn-2' }));
      expect(mockApiGateway.log).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'WebSocket Subscription Error', connectionId: 'conn-1' })
      );
    });
  });

  describe('Disconnect during an in-flight handshake', () => {
    it('should not bring the connection back', async () => {
      const { mockApiGateway, mockSendMessage, mockContextAcceptor } = createMocks();
      const store = new TestSubscriptionStore();
      const auth = deferred();
      mockApiGateway.checkAuthFn = jest.fn(async (authContext: any) => {
        await auth.promise;
        authContext.securityContext = { userId: 42 };
      });
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, store, mockContextAcceptor, noopEventEmitter()));

      const inFlight = server.processMessage('conn-1', JSON.stringify({ authorization: 'token' }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockApiGateway.checkAuthFn).toHaveBeenCalledTimes(1);

      await server.disconnect('conn-1');

      auth.resolve();
      await inFlight;

      expect(store.connectionIds()).toEqual([]);
      expect(await store.getAuthContext('conn-1')).toBeUndefined();
    });
  });

  describe('Disconnect during an in-flight subscribe', () => {
    it('should not bring the connection back', async () => {
      const { mockApiGateway, mockContextAcceptor } = createMocks();
      const store = new TestSubscriptionStore();
      const sentMessages: any[] = [];
      // A closed socket: ws drops the message without throwing
      const sendToClosedSocket = jest.fn(async (_connectionId: string, message: any) => {
        sentMessages.push(message);
      });

      const load = deferred();
      // Mirrors the gateway: load, reply, then record the subscription
      mockApiGateway.subscribe = jest.fn(async ({ res, subscribe }) => {
        await load.promise;
        await res({ data: [] });
        await subscribe({ resultHash: 'hash' });
      });

      const server = track(new SubscriptionServer(mockApiGateway, sendToClosedSocket, store, mockContextAcceptor, noopEventEmitter()));

      await server.processMessage('conn-1', JSON.stringify({ authorization: 'token' }));
      const inFlight = server.processMessage('conn-1', JSON.stringify({
        method: 'subscribe',
        messageId: '1',
        params: { query: { measures: ['Orders.count'] } },
      }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockApiGateway.subscribe).toHaveBeenCalledTimes(1);

      await server.disconnect('conn-1');
      expect(store.connectionIds()).toEqual([]);

      load.resolve();
      await inFlight;

      expect(store.connectionIds()).toEqual([]);
      expect(store.getAllSubscriptions()).toEqual([]);

      sentMessages.length = 0;
      await server.processSubscriptions();

      expect(mockApiGateway.subscribe).toHaveBeenCalledTimes(1);
      expect(sentMessages).toEqual([]);
    });
  });

  describe('Message Validation', () => {
    it('should accept valid auth message', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface, sentMessages } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      await server.processMessage('conn-1', JSON.stringify({ authorization: 'token123' }));

      expect(mockApiGateway.checkAuthFn).toHaveBeenCalled();
      expect(sentMessages).toContainEqual({ handshake: true });
    });

    it('should accept valid unsubscribe message', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      await server.processMessage('conn-1', JSON.stringify({ unsubscribe: 'msg-1' }));

      expect(mockSubscriptionStore.unsubscribe).toHaveBeenCalledWith('conn-1', 'msg-1');
    });

    it('should convert numeric unsubscribe id to string', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      await server.processMessage('conn-1', JSON.stringify({ unsubscribe: 123 }));

      const callArgs = mockSubscriptionStore.unsubscribe.mock.calls[0];
      expect(typeof callArgs[1]).toBe('string');
      expect(callArgs[1]).toBe('123');
    });

    it('should accept valid load message', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface, sentMessages } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      const message = {
        method: 'load',
        messageId: '123',
        params: { query: { measures: ['Orders.count'] } }
      };
      await server.processMessage('conn-1', JSON.stringify(message));

      expect(mockApiGateway.load).toHaveBeenCalled();
      expect(sentMessages).toContainEqual({ messageProcessedId: '123' });
    });

    it('should convert numeric messageId to string', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface, sentMessages } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      const message = {
        method: 'load',
        messageId: 123,
        params: { query: { measures: ['Orders.count'] } }
      };
      await server.processMessage('conn-1', JSON.stringify(message));

      expect(mockApiGateway.load).toHaveBeenCalled();

      const processedMsg = sentMessages.find((m) => m.messageProcessedId !== undefined);
      expect(typeof processedMsg.messageProcessedId).toBe('string');
      expect(processedMsg.messageProcessedId).toBe('123');
    });

    it('should reject invalid JSON payload', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      await server.processMessage('conn-1', 'not valid json');

      expect(mockApiGateway.handleError).toHaveBeenCalled();
      const errorCall = mockApiGateway.handleError.mock.calls[0][0];
      expect(errorCall.e.type).toBe('Invalid JSON payload');
    });

    it('should reject a non-object JSON payload', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, noopEventEmitter()));

      for (const body of ['5', 'null', '"text"']) {
        await server.processMessage('conn-1', body);
      }

      expect(mockApiGateway.handleError).toHaveBeenCalledTimes(3);

      for (const [{ e }] of mockApiGateway.handleError.mock.calls) {
        expect(e.status).toBe(400);
        expect(e.type).toBe('Invalid message format');
      }
    });

    it('should reject message with unknown fields', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      const message = {
        method: 'load',
        messageId: '123',
        params: { query: { measures: ['Orders.count'] } },
        fieldIsNotAllowed: true,
      };
      await server.processMessage('conn-1', JSON.stringify(message));

      expect(mockApiGateway.load).not.toHaveBeenCalled();
      expect(mockApiGateway.handleError).toHaveBeenCalled();
    });

    it('should reject messageId & requestId', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      const message = {
        method: 'load',
        messageId: '12345678901234567', // 17 chars
        requestId: 'a'.repeat(65), // 65 chars
        params: { query: { measures: ['Orders.count'] } },
      };
      await server.processMessage('conn-1', JSON.stringify(message));

      expect(mockApiGateway.load).not.toHaveBeenCalled();
      expect(mockApiGateway.handleError).toHaveBeenCalled();
    });
  });

  describe('Request ID', () => {
    it('should reject a requestId with forbidden characters', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      await server.processMessage('conn-1', JSON.stringify({
        method: 'load',
        messageId: 'msg-1',
        requestId: 'my req\n',
        params: { query: { measures: ['Orders.count'] } },
      }));

      expect(mockApiGateway.contextByReq).not.toHaveBeenCalled();
      expect(mockApiGateway.load).not.toHaveBeenCalled();
      expect(mockApiGateway.handleError).toHaveBeenCalled();
    });

    it('should reject a messageId with forbidden characters when requestId is omitted', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      await server.processMessage('conn-1', JSON.stringify({
        method: 'load',
        messageId: "x' OR 1;--",
        params: { query: { measures: ['Orders.count'] } },
      }));

      expect(mockApiGateway.contextByReq).not.toHaveBeenCalled();
      expect(mockApiGateway.load).not.toHaveBeenCalled();
      expect(mockApiGateway.handleError).toHaveBeenCalled();
    });

    it('should accept a requestId of up to 128 characters', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      const send = (requestId: string) => server.processMessage('conn-1', JSON.stringify({
        method: 'load',
        messageId: 'msg-1',
        requestId,
        params: { query: { measures: ['Orders.count'] } },
      }));

      await send('a'.repeat(128));
      expect(mockApiGateway.contextByReq).toHaveBeenCalledTimes(1);

      await send('a'.repeat(129));
      expect(mockApiGateway.contextByReq).toHaveBeenCalledTimes(1);
      expect(mockApiGateway.handleError).toHaveBeenCalled();
    });

    it('should pass a valid requestId through', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      await server.processMessage('conn-1', JSON.stringify({
        method: 'load',
        messageId: 'msg-1',
        requestId: 'client-req-1',
        params: { query: { measures: ['Orders.count'] } },
      }));

      expect(mockApiGateway.contextByReq.mock.calls[0][2]).toMatch(/^client-req-1-span-[0-9a-f-]{36}$/);
    });
  });

  describe('Auth Flow', () => {
    it('should complete successful authorization handshake', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface, sentMessages } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));
      
      await server.processMessage('conn-1', JSON.stringify({ authorization: 'valid-token' }));

      expect(mockApiGateway.checkAuthFn).toHaveBeenCalledWith(
        expect.objectContaining({ protocol: 'ws' }),
        'valid-token'
      );
      expect(mockSubscriptionStore.setAuthContext).toHaveBeenCalled();
      expect(sentMessages).toContainEqual({ handshake: true });
    });

    it('should reject an authorization while another one is in progress', async () => {
      const { mockApiGateway, mockSendMessage, mockContextAcceptor, sentMessages } = createMocks();
      const store = new TestSubscriptionStore();
      const auth = deferred();
      mockApiGateway.checkAuthFn = jest.fn(async (authContext: any, token: string) => {
        await auth.promise;
        authContext.securityContext = { token };
      });
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, store, mockContextAcceptor, noopEventEmitter()));

      const first = server.processMessage('conn-1', JSON.stringify({ authorization: 'first' }));
      await server.processMessage('conn-1', JSON.stringify({ authorization: 'second' }));

      expect(mockApiGateway.checkAuthFn).toHaveBeenCalledTimes(1);
      expect(mockApiGateway.handleError).toHaveBeenCalledTimes(1);
      expect(mockApiGateway.handleError.mock.calls[0][0].e).toMatchObject({
        status: 409,
        message: 'Authorization is already in progress for this connection',
      });

      auth.resolve();
      await first;

      expect(sentMessages).toEqual([{ handshake: true }]);
      expect(await store.getAuthContext('conn-1')).toMatchObject({ securityContext: { token: 'first' } });
    });

    it('should not block an authorization on another connection', async () => {
      const { mockApiGateway, mockSendMessage, mockContextAcceptor } = createMocks();
      const store = new TestSubscriptionStore();
      const auth = deferred();
      mockApiGateway.checkAuthFn = jest.fn(async () => auth.promise);
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, store, mockContextAcceptor, noopEventEmitter()));

      const first = server.processMessage('conn-1', JSON.stringify({ authorization: 'token' }));
      const second = server.processMessage('conn-2', JSON.stringify({ authorization: 'token' }));

      expect(mockApiGateway.checkAuthFn).toHaveBeenCalledTimes(2);

      auth.resolve();
      await Promise.all([first, second]);

      expect(mockApiGateway.handleError).not.toHaveBeenCalled();
    });

    it('should allow a new authorization after a failed one', async () => {
      const { mockApiGateway, mockSendMessage, mockContextAcceptor, sentMessages } = createMocks();
      const store = new TestSubscriptionStore();
      mockApiGateway.checkAuthFn = jest.fn()
        .mockRejectedValueOnce(new Error('Invalid token'))
        .mockResolvedValue(undefined);
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, store, mockContextAcceptor, noopEventEmitter()));

      await server.processMessage('conn-1', JSON.stringify({ authorization: 'bad' }));
      await server.processMessage('conn-1', JSON.stringify({ authorization: 'good' }));

      expect(mockApiGateway.checkAuthFn).toHaveBeenCalledTimes(2);
      expect(sentMessages).toEqual([{ handshake: true }]);
    });

    it('should reject when contextAcceptor rejects', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface, sentMessages } = createMocks();
      mockContextAcceptor.mockResolvedValue({ accepted: false, rejectMessage: { error: 'Rejected' } });
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      await server.processMessage('conn-1', JSON.stringify({ authorization: 'token' }));

      expect(mockSubscriptionStore.setAuthContext).not.toHaveBeenCalled();
      expect(sentMessages).toContainEqual({ error: 'Rejected' });
    });

    it('should return 403 for unauthorized method call', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface, sentMessages } = createMocks();
      mockSubscriptionStore.getAuthContext.mockResolvedValue(null);
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      const message = {
        method: 'load',
        messageId: '123',
        params: { query: {} }
      };
      await server.processMessage('conn-1', JSON.stringify(message));

      expect(mockApiGateway.load).not.toHaveBeenCalled();
      expect(sentMessages).toContainEqual({
        messageId: '123',
        message: { error: 'Not authorized' },
        status: 403
      });
    });
  });

  describe('Completion logging', () => {
    it('records one failure for an unauthorized method call', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      mockApiGateway.recordRequestFailure = jest.fn();
      mockSubscriptionStore.getAuthContext.mockResolvedValue(null);
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      await server.processMessage('conn-1', JSON.stringify({ method: 'load', messageId: '123', params: { query: {} } }));

      expect(mockApiGateway.recordRequestFailure).toHaveBeenCalledTimes(1);
      const [arg] = mockApiGateway.recordRequestFailure.mock.calls[0];
      expect(arg).toMatchObject({ endpoint: 'load', method: 'WS' });
      expect(arg.e.status).toBe(403);
    });

    it('does not record when the gateway method was dispatched', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      mockApiGateway.recordRequestFailure = jest.fn();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      await server.processMessage('conn-1', JSON.stringify({ method: 'load', messageId: '123', params: { query: {} } }));

      expect(mockApiGateway.load).toHaveBeenCalled();
      expect(mockApiGateway.recordRequestFailure).not.toHaveBeenCalled();
    });

    it('a throwing recorder does not break the 403 response', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface, sentMessages } = createMocks();
      mockApiGateway.recordRequestFailure = jest.fn(() => { throw new Error('boom'); });
      mockSubscriptionStore.getAuthContext.mockResolvedValue(null);
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      await server.processMessage('conn-1', JSON.stringify({ method: 'load', messageId: '123', params: { query: {} } }));

      expect(sentMessages).toContainEqual({ messageId: '123', message: { error: 'Not authorized' }, status: 403 });
    });

    // handleError writes cube.error unless completionLogged: each failure visible exactly once
    const completionLoggedFor = async (message: object, setupMocks: (m: any) => void = () => undefined) => {
      const m = createMocks();
      m.mockApiGateway.recordRequestFailure = jest.fn(({ endpoint }) => Boolean(endpoint));
      setupMocks(m);
      const server = track(new SubscriptionServer(m.mockApiGateway, m.mockSendMessage, m.mockSubscriptionStore, m.mockContextAcceptor, m.mockEventEmitterInterface));
      await server.processMessage('conn-1', JSON.stringify(message));
      expect(m.mockApiGateway.handleError).toHaveBeenCalledTimes(1);
      return m.mockApiGateway.handleError.mock.calls[0][0].completionLogged;
    };

    it('a wired method failing before dispatch is covered by its completion line', async () => {
      expect(await completionLoggedFor(
        { method: 'load', messageId: '1', params: { query: {} } },
        (m) => m.mockApiGateway.contextByReq.mockRejectedValue(new Error('context failed')),
      )).toBe(true);
    });

    it('an unwired method failing before dispatch is not covered (cube.error)', async () => {
      expect(await completionLoggedFor(
        { method: 'dry-run', messageId: '1', params: { query: {} } },
        (m) => m.mockApiGateway.contextByReq.mockRejectedValue(new Error('context failed')),
      )).toBe(false);
    });

    it('an error escaping a dispatched wired method is covered; an unwired one is not', async () => {
      expect(await completionLoggedFor(
        { method: 'load', messageId: '1', params: { query: {} } },
        (m) => m.mockApiGateway.load.mockRejectedValue(new Error('escaped')),
      )).toBe(true);
      expect(await completionLoggedFor(
        { method: 'dry-run', messageId: '1', params: { query: {} } },
        (m) => m.mockApiGateway.dryRun.mockRejectedValue(new Error('escaped')),
      )).toBe(false);
    });

    it('an auth message failure and an unparsable message are not covered (cube.error)', async () => {
      expect(await completionLoggedFor(
        { authorization: 't' },
        (m) => m.mockApiGateway.checkAuthFn.mockRejectedValue(new Error('bad token')),
      )).toBe(false);

      const m = createMocks();
      const server = track(new SubscriptionServer(m.mockApiGateway, m.mockSendMessage, m.mockSubscriptionStore, m.mockContextAcceptor, m.mockEventEmitterInterface));
      await server.processMessage('conn-1', '{not json');
      expect(m.mockApiGateway.handleError.mock.calls[0][0].completionLogged).toBeFalsy();
    });
  });

  describe('Method Dispatch', () => {
    it('should call load method correctly', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      const message = {
        method: 'load',
        messageId: '123',
        params: { query: { measures: ['Orders.count'] }, queryType: 'multi' }
      };
      await server.processMessage('conn-1', JSON.stringify(message));

      expect(mockApiGateway.load).toHaveBeenCalledWith(
        expect.objectContaining({
          query: { measures: ['Orders.count'] },
          queryType: 'multi',
          connectionId: 'conn-1',
          apiType: 'ws',
        })
      );
    });

    it('should call sql method correctly', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      const message = {
        method: 'sql',
        messageId: '123',
        params: { query: { measures: ['Orders.count'] } }
      };
      await server.processMessage('conn-1', JSON.stringify(message));

      expect(mockApiGateway.sql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: { measures: ['Orders.count'] },
          connectionId: 'conn-1',
        })
      );
    });

    it('should call meta method correctly', async () => {
      // The fork always routes the WS 'meta' method to apiGateway.metaExtended so that
      // preAggregations are included in the response (see gateway.ts metaExtended).
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      const message = {
        method: 'meta',
        messageId: '123',
      };
      await server.processMessage('conn-1', JSON.stringify(message));

      expect(mockApiGateway.metaExtended).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: 'conn-1',
          apiType: 'ws',
        })
      );
    });

    it('should forward onlyViews param for meta', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      const message = {
        method: 'meta',
        messageId: '123',
        params: { onlyViews: true }
      };
      await server.processMessage('conn-1', JSON.stringify(message));

      expect(mockApiGateway.handleError).not.toHaveBeenCalled();
      expect(mockApiGateway.metaExtended).toHaveBeenCalledWith(
        expect.objectContaining({
          onlyViews: true,
          connectionId: 'conn-1',
          apiType: 'ws',
        })
      );
    });

    it('should reject a non-boolean onlyViews param for meta', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      const message = {
        method: 'meta',
        messageId: '123',
        params: { onlyViews: 'true' }
      };
      await server.processMessage('conn-1', JSON.stringify(message));

      expect(mockApiGateway.meta).not.toHaveBeenCalled();
      expect(mockApiGateway.handleError).toHaveBeenCalled();
    });

    it('should still reject unknown meta params', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      const message = {
        method: 'meta',
        messageId: '123',
        params: { somethingElse: true }
      };
      await server.processMessage('conn-1', JSON.stringify(message));

      expect(mockApiGateway.meta).not.toHaveBeenCalled();
      expect(mockApiGateway.handleError).toHaveBeenCalled();
    });

    it('should forward cache param as cacheMode for load', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      const message = {
        method: 'load',
        messageId: '123',
        params: { query: { measures: ['Orders.count'] }, cache: 'no-cache' }
      };
      await server.processMessage('conn-1', JSON.stringify(message));

      expect(mockApiGateway.load).toHaveBeenCalledWith(
        expect.objectContaining({
          query: { measures: ['Orders.count'] },
          cacheMode: 'no-cache',
          connectionId: 'conn-1',
          apiType: 'ws',
        })
      );
      // cache should be remapped, not passed through as-is
      expect(mockApiGateway.load).not.toHaveBeenCalledWith(
        expect.objectContaining({ cache: 'no-cache' })
      );
    });

    it('should forward cache param as cacheMode for subscribe', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      const message = {
        method: 'subscribe',
        messageId: '123',
        params: { query: { measures: ['Orders.count'] }, cache: 'no-cache' }
      };
      await server.processMessage('conn-1', JSON.stringify(message));

      expect(mockApiGateway.subscribe).toHaveBeenCalledWith(
        expect.objectContaining({
          query: { measures: ['Orders.count'] },
          cacheMode: 'no-cache',
          connectionId: 'conn-1',
        })
      );
    });

    it('should call subscribe method correctly', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, mockEventEmitterInterface } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, mockEventEmitterInterface));

      const message = {
        method: 'subscribe',
        messageId: '123',
        params: { query: { measures: ['Orders.count'] } }
      };
      await server.processMessage('conn-1', JSON.stringify(message));

      expect(mockApiGateway.subscribe).toHaveBeenCalledWith(
        expect.objectContaining({
          query: { measures: ['Orders.count'] },
          connectionId: 'conn-1',
        })
      );
    });
  });

  describe('WebSocket subscription logging and unsubscribe flow (real store)', () => {
    // Real stores start a 60 s summary interval: closed after each test, so it can never fire
    // after the Jest environment is torn down
    const stores: LocalSubscriptionStore[] = [];
    const setup = (subscribeImpl?: (args: any) => Promise<void>) => {
      const m = createMocks();
      const store = new LocalSubscriptionStore();
      stores.push(store);
      m.mockApiGateway.subscribe = jest.fn(subscribeImpl || (async (args: any) => { await args.subscribe({ result: 1 }); }));
      const server = track(new SubscriptionServer(m.mockApiGateway, m.mockSendMessage, store, m.mockContextAcceptor, m.mockEventEmitterInterface));
      return { ...m, store, server };
    };
    const unknownEvents = (spy: jest.SpyInstance) => spy.mock.calls
      .map(c => String(c[0]))
      .filter(l => l.includes('cube.ws.unsubscribe_unknown'));
    let stdout: jest.SpyInstance;
    let logSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;
    const savedLevel = process.env.CUBEJS_LOG_LEVEL;

    beforeEach(() => {
      process.env.CUBEJS_LOG_LEVEL = 'debug';
      stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      stores.splice(0).forEach(store => store.close());
      stdout.mockRestore();
      logSpy.mockRestore();
      warnSpy.mockRestore();
      if (savedLevel === undefined) {
        delete process.env.CUBEJS_LOG_LEVEL;
      } else {
        process.env.CUBEJS_LOG_LEVEL = savedLevel;
      }
    });

    // Finding (a) refuted end to end: zod coerces numeric messageId and unsubscribe id to strings
    it('REPRO type mismatch (refuted): numeric messageId then numeric or string unsubscribe is NOT unknown', async () => {
      const { server, store } = setup();
      await server.processMessage('c1', JSON.stringify({ authorization: 't' }));
      store.connect('c1');
      await store.setAuthContext('c1', { securityContext: { tenantId: 't1' } });
      await server.processMessage('c1', JSON.stringify({ method: 'subscribe', messageId: 7, params: { query: {} } }));
      expect(await store.getSubscription('c1', '7')).toBeDefined();

      await server.processMessage('c1', JSON.stringify({ unsubscribe: 7 }));
      expect(await store.getSubscription('c1', '7')).toBeUndefined();
      expect(unknownEvents(stdout)).toHaveLength(0);

      await server.processMessage('c1', JSON.stringify({ method: 'subscribe', messageId: 8, params: { query: {} } }));
      await server.processMessage('c1', JSON.stringify({ unsubscribe: '8' }));
      expect(unknownEvents(stdout)).toHaveLength(0);
    });

    // Finding (e): unsubscribe arrives while the first poll is still in flight; the late subscribe() resurrects it
    it('REPRO in-flight race: unsubscribe during a pending subscribe is unknown and the subscription is then re-created', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>(r => { release = r; });
      const { server, store } = setup(async (args: any) => { await gate; await args.subscribe({ result: 1 }); });
      store.connect('c1');
      await store.setAuthContext('c1', { securityContext: { tenantId: 't1' } });
      await store.subscribe('c1', 'placeholder', { message: {}, state: {} }); // connection exists

      const pending = server.processMessage('c1', JSON.stringify({ method: 'subscribe', messageId: 'm1', params: { query: {} } }));
      await new Promise(r => setImmediate(r));
      await server.processMessage('c1', JSON.stringify({ unsubscribe: 'm1' }));
      expect(unknownEvents(stdout)).toHaveLength(1);

      release();
      await pending;
      expect(await store.getSubscription('c1', 'm1')).toBeDefined();
    });

    // A disconnect (e.g. the keepalive terminating a dead connection) while a poll is in flight: the late
    // subscribe() re-creates the connection without an auth context. The next poll cycle must clean it up
    // quietly instead of answering 'Not authorized' (403) and recording an error every 5 s until eviction
    it('a late subscribe() after a disconnect does not leave a zombie that answers 403s', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>(r => { release = r; });
      const { server, store, mockApiGateway, mockSendMessage } = setup(async (args: any) => {
        await gate;
        await args.subscribe({ result: 1 });
      });
      mockApiGateway.recordRequestFailure = jest.fn();
      await server.processMessage('c1', JSON.stringify({ authorization: 't' }));

      const pending = server.processMessage('c1', JSON.stringify({ method: 'subscribe', messageId: 'm1', params: { query: {} } }));
      await new Promise(r => setImmediate(r));
      await server.disconnect('c1');
      release();
      await pending;

      await server.processSubscriptions();
      await server.processSubscriptions();

      expect(mockSendMessage.mock.calls.filter(c => c[1]?.status === 403)).toHaveLength(0);
      expect(mockApiGateway.recordRequestFailure).not.toHaveBeenCalled();
      expect(store.getAllSubscriptions()).toHaveLength(0);
    });

    it('renewCubes records the renew on the store and writes nothing via console', async () => {
      const { server, store } = setup();
      store.connect('c1');
      await store.setAuthContext('c1', { securityContext: { tenantId: 't1' } });
      await store.subscribe('c1', 'm1', {
        message: { method: 'subscribe', messageId: 'm1', params: { query: { measures: ['Orders.count'] } } },
        state: {},
      });
      const spy = jest.spyOn(store, 'recordRenew');

      await server.renewCubes([{ tenantId: 't1', cubes: ['Orders'] }]);

      expect(spy).toHaveBeenCalledWith(1, 't1', ['Orders']);
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('Unsubscribe method', () => {
    const createServer = () => {
      const { mockApiGateway, mockSendMessage, mockContextAcceptor, sentMessages } = createMocks();
      mockApiGateway.unsubscribe = ApiGateway.prototype.unsubscribe;
      const store = new LocalSubscriptionStore();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, store, mockContextAcceptor, noopEventEmitter()));

      return { server, store, mockApiGateway, sentMessages };
    };

    it('should drop the subscription with the same messageId', async () => {
      const { server, store, mockApiGateway, sentMessages } = createServer();

      await server.processMessage('conn-1', JSON.stringify({ authorization: 'token' }));
      await store.subscribe('conn-1', 'sub-1', { message: {}, state: {} });
      await store.subscribe('conn-1', 'sub-2', { message: {}, state: {} });

      await server.processMessage('conn-1', JSON.stringify({ method: 'unsubscribe', messageId: 'sub-1' }));

      expect(await store.getSubscription('conn-1', 'sub-1')).toBeUndefined();
      expect(await store.getSubscription('conn-1', 'sub-2')).toBeDefined();
      expect(sentMessages).toContainEqual({ messageProcessedId: 'sub-1' });
      expect(mockApiGateway.handleError).not.toHaveBeenCalled();
    });

    it('should require authorization', async () => {
      const { server, store, sentMessages } = createServer();

      store.connect('conn-1');
      await store.subscribe('conn-1', 'sub-1', { message: {}, state: {} });

      await server.processMessage('conn-1', JSON.stringify({ method: 'unsubscribe', messageId: 'sub-1' }));

      expect(await store.getSubscription('conn-1', 'sub-1')).toBeDefined();
      expect(sentMessages).toContainEqual({
        messageId: 'sub-1',
        message: { error: 'Not authorized' },
        status: 403,
      });
    });
  });

  describe('Error replies', () => {
    const deepArray = (depth: number) => `${'['.repeat(depth)}0${']'.repeat(depth)}`;

    it('should not echo an invalid nested messageId', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, sentMessages } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, noopEventEmitter()));

      await server.processMessage('conn-1', `{"method":"meta","messageId":${deepArray(12000)}}`);

      expect(mockApiGateway.handleError).toHaveBeenCalledTimes(1);
      const { res } = mockApiGateway.handleError.mock.calls[0][0];
      await res({ error: 'Invalid message format' }, { status: 400 });

      expect(sentMessages).toEqual([{ messageId: undefined, message: { error: 'Invalid message format' }, status: 400 }]);
    });

    it('should echo a valid messageId of an otherwise invalid message', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor, sentMessages } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, noopEventEmitter()));

      await server.processMessage('conn-1', JSON.stringify({ method: 'meta', messageId: 7, unknown: true }));

      const { res } = mockApiGateway.handleError.mock.calls[0][0];
      await res({ error: 'Invalid message format' }, { status: 400 });

      expect(sentMessages).toEqual([{ messageId: '7', message: { error: 'Invalid message format' }, status: 400 }]);
    });

    it('should not pass an unvalidated top-level query to error handling', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockSendMessage, mockContextAcceptor } = createMocks();
      const server = track(new SubscriptionServer(mockApiGateway, mockSendMessage, mockSubscriptionStore, mockContextAcceptor, noopEventEmitter()));

      await server.processMessage('conn-1', `{"method":"meta","messageId":"1","query":${deepArray(12000)}}`);

      expect(mockApiGateway.handleError.mock.calls[0][0].query).toBeUndefined();
    });

    it('should contain a failed error reply instead of rejecting', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockContextAcceptor } = createMocks();
      const failingSend = jest.fn().mockRejectedValue(new RangeError('Maximum call stack size exceeded'));
      const server = track(new SubscriptionServer(mockApiGateway, failingSend, mockSubscriptionStore, mockContextAcceptor, noopEventEmitter()));

      await server.processMessage('conn-1', 'not valid json');

      const { res } = mockApiGateway.handleError.mock.calls[0][0];
      await expect(res({ error: 'Invalid JSON payload' }, { status: 400 })).resolves.toBeUndefined();
      expect(mockApiGateway.log).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'WebSocket Send Error' }),
        expect.anything()
      );
    });

    it('should contain a failed handshake reply', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockContextAcceptor } = createMocks();
      const sendError = new Error('Socket for conn-1 is not found');
      const failingSend = jest.fn().mockRejectedValue(sendError);
      const server = track(new SubscriptionServer(mockApiGateway, failingSend, mockSubscriptionStore, mockContextAcceptor, noopEventEmitter()));

      await server.processMessage('conn-1', JSON.stringify({ authorization: 'token' }));

      expect(failingSend).toHaveBeenCalledTimes(1);
      expect(failingSend).toHaveBeenCalledWith('conn-1', { handshake: true });
      expect(mockApiGateway.handleError).toHaveBeenCalledTimes(1);
      const { e, res } = mockApiGateway.handleError.mock.calls[0][0];
      expect(e).toBe(sendError);

      await expect(res({ error: 'Internal Server Error' }, { status: 500 })).resolves.toBeUndefined();
      expect(failingSend).toHaveBeenLastCalledWith(
        'conn-1',
        { messageId: undefined, message: { error: 'Internal Server Error' }, status: 500 }
      );
      expect(mockApiGateway.log).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'WebSocket Send Error', error: sendError.stack }),
        expect.anything()
      );
    });

    it('should contain a failed reply from a gateway method', async () => {
      const { mockApiGateway, mockSubscriptionStore, mockContextAcceptor } = createMocks();
      const failingSend = jest.fn().mockRejectedValue(new Error('Socket is gone'));
      const replies: Promise<string>[] = [];
      const settle = (reply: Promise<unknown>) => reply.then(() => 'resolved', () => 'rejected');
      // Mirrors the gateway: await `res`, then pass the same `res` to error handling without awaiting it
      mockApiGateway.load = jest.fn(async ({ res }) => {
        try {
          const reply = res({ data: [] });
          replies.push(settle(reply));
          await reply;
        } catch (e: any) {
          replies.push(settle(res({ error: e.message }, { status: 500 })));
        }
      });
      const server = track(new SubscriptionServer(mockApiGateway, failingSend, mockSubscriptionStore, mockContextAcceptor, noopEventEmitter()));

      await server.processMessage('conn-1', JSON.stringify({
        method: 'load',
        messageId: '1',
        params: { query: { measures: ['Orders.count'] } },
      }));

      expect(mockApiGateway.load).toHaveBeenCalledTimes(1);
      // A rejecting `res` would take the catch branch and leave a second, un-awaited rejection
      expect(await Promise.all(replies)).toEqual(['resolved']);
      expect(mockApiGateway.log).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'WebSocket Send Error' }),
        expect.anything()
      );
    });
  });
});
