import { v4 as uuidv4 } from 'uuid';
import { EventEmitterInterface } from '@cubejs-backend/event-emitter';
import { Subject } from 'rxjs';
import { map, filter, bufferTime, tap } from 'rxjs/operators';
import { UserError } from './UserError';
import type { ApiGateway } from './gateway';
import type { LocalSubscriptionStore } from './LocalSubscriptionStore';
import { ExtendedRequestContext, ContextAcceptorFn } from './interfaces';

const methodParams: Record<string, string[]> = {
  load: ['query', 'queryType'],
  sql: ['query'],
  'dry-run': ['query'],
  meta: [],
  subscribe: ['query', 'queryType'],
  unsubscribe: [],
  'subscribe.queue.events': []
};

const calcMessageLength = (message: unknown) => Buffer.byteLength(
  typeof message === 'string' ? message : JSON.stringify(message)
);

export type WebSocketSendMessageFn = (connectionId: string, message: any) => Promise<void>;

const ensureArray = (value: any) => (Array.isArray(value) ? value : [value]);

export class SubscriptionServer {
  readonly #cubeRenewSubject = new Subject<unknown>();

  readonly #cubeRenewedPipe = this.#cubeRenewSubject.pipe(
    map((val) => ensureArray(val)),
    // Map only the renewedCube property
    map((val) => val as Array<{ renewedCube: string | undefined }>),
    map((val) => val.map(v => v.renewedCube)),
    // Buffer the values for 300ms
    bufferTime(100),
    map((renewedCubes) => renewedCubes.flat()),
    map((val) => val.filter(v => v !== undefined)),
    // Filter out any empty arrays
    filter((renewedCubes) => renewedCubes.length > 0),
    // Convert the array of arrays to an array of unique arrays
    map((renewedCubes) => Array.from(new Set(renewedCubes))),
  );

  public constructor(
    protected readonly apiGateway: ApiGateway,
    protected readonly sendMessage: WebSocketSendMessageFn,
    protected readonly subscriptionStore: LocalSubscriptionStore,
    protected readonly contextAcceptor: ContextAcceptorFn,
    protected readonly eventEmitter: EventEmitterInterface
  ) {
    this.eventEmitter.on('cubeRenewed', (val: unknown) => this.#cubeRenewSubject.next(val));
    this.#cubeRenewedPipe.subscribe(this.renewCubes.bind(this));
  }

  public resultFn(connectionId: string, messageId: string, requestId: string | undefined) {
    return async (message, { status } = { status: 200 }) => {
      this.apiGateway.log({
        type: 'Outgoing network usage',
        service: 'api-ws',
        bytes: calcMessageLength(message),
      }, { requestId });
      return this.sendMessage(connectionId, { messageId, message, status });
    };
  }

  public async processMessage(connectionId: string, message, isSubscription) {
    let authContext: any = {};
    let context: Partial<ExtendedRequestContext> = {};

    const bytes = calcMessageLength(message);

    try {
      if (typeof message === 'string') {
        message = JSON.parse(message);
      }

      if (message.authorization) {
        authContext = { isSubscription: true, protocol: 'ws' };
        await this.apiGateway.checkAuthFn(authContext, message.authorization);
        const acceptanceResult = await this.contextAcceptor(authContext);
        if (!acceptanceResult.accepted) {
          this.sendMessage(connectionId, acceptanceResult.rejectMessage);
          return;
        }
        await this.subscriptionStore.setAuthContext(connectionId, authContext);
        this.sendMessage(connectionId, { handshake: true });
        return;
      }

      if (message.unsubscribe) {
        await this.subscriptionStore.unsubscribe(connectionId, message.unsubscribe);
        return;
      }

      if (!message.messageId) {
        throw new UserError('messageId is required');
      }

      authContext = await this.subscriptionStore.getAuthContext(connectionId);

      if (!authContext) {
        await this.sendMessage(
          connectionId,
          {
            messageId: message.messageId,
            message: { error: 'Not authorized' },
            status: 403
          }
        );
        return;
      }

      if (!message.method) {
        throw new UserError('method is required');
      }

      if (!methodParams[message.method]) {
        throw new UserError(`Unsupported method: ${message.method}`);
      }

      const baseRequestId = message.requestId || `${connectionId}-${message.messageId}`;
      const requestId = `${baseRequestId}-span-${uuidv4()}`;
      context = await this.apiGateway.contextByReq(message, authContext.securityContext, requestId);

      this.apiGateway.log({
        type: 'Incoming network usage',
        service: 'api-ws',
        bytes,
      }, context);

      const allowedParams = methodParams[message.method];
      const params = allowedParams.map(k => ({ [k]: (message.params || {})[k] }))
        .reduce((a, b) => ({ ...a, ...b }), {});

      const method = message.method.replace(/[^a-z]+(.)/g, (m, chr) => chr.toUpperCase());
      await this.apiGateway[method]({
        ...params,
        connectionId,
        context,
        signedWithPlaygroundAuthSecret: authContext.signedWithPlaygroundAuthSecret,
        isSubscription,
        apiType: 'ws',
        res: this.resultFn(connectionId, message.messageId, requestId),
        subscriptionState: async () => {
          const subscription = await this.subscriptionStore.getSubscription(connectionId, message.messageId);
          return subscription && subscription.state;
        },
        subscribe: async (state) => this.subscriptionStore.subscribe(connectionId, message.messageId, {
          message,
          state
        }),
        unsubscribe: async () => this.subscriptionStore.unsubscribe(connectionId, message.messageId)
      });

      await this.sendMessage(connectionId, { messageProcessedId: message.messageId });
    } catch (e) {
      this.apiGateway.handleError({
        e,
        query: message.query,
        res: this.resultFn(connectionId, message.messageId, context.requestId),
        context
      });
    }
  }

  public async processSubscriptions() {
    const allSubscriptions = await this.subscriptionStore.getAllSubscriptions();
    await Promise.all(allSubscriptions.map(async subscription => {
      await this.processMessage(subscription.connectionId, subscription.message, true);
    }));
  }

  public async disconnect(connectionId: string) {
    const authContext = await this.subscriptionStore.getAuthContext(connectionId);
    await this.apiGateway.unSubscribeQueueEvents({ context: authContext, connectionId });
    await this.subscriptionStore.cleanupSubscriptions(connectionId);
  }

  public clear() {
    this.subscriptionStore.clear();
  }

  public async renewCubes(cubes) {
    if (cubes.length === 0) {
      return;
    }

    const subs = await this.subscriptionStore.getSubscriptionsByCubeName(cubes);

    if (subs.length === 0) {
      return;
    }

    console.log('Renewing subs based on changed cubes', cubes, subs.length);
    subs.map(async subscription => {
      this.processMessage(subscription.connectionId, subscription.message, true);
    });
  }
}
