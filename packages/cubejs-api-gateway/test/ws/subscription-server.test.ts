import { SubscriptionServer } from '../../src/ws/subscription-server';
import { LocalSubscriptionStore } from '../../src/ws/local-subscription-store';

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
      if (savedLevel === undefined) delete process.env.CUBEJS_LOG_LEVEL; else process.env.CUBEJS_LOG_LEVEL = savedLevel;
    });

    // Finding (a) refuted end to end: zod coerces numeric messageId and unsubscribe id to strings
    it('REPRO type mismatch (refuted): numeric messageId then numeric or string unsubscribe is NOT unknown', async () => {
      const { server, store } = setup();
      await server.processMessage('c1', JSON.stringify({ authorization: 't' }));
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
});
