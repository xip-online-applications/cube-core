import { v4 as uuidv4 } from 'uuid';
import type { ZodError } from 'zod';
import { EventEmitterInterface } from '@cubejs-backend/event-emitter';
import { Subject } from 'rxjs';
import { map, bufferTime } from 'rxjs/operators';
import { isValidRequestId } from '@cubejs-backend/shared';

import { UserError } from '../user-error';
import { ExtendedRequestContext, ContextAcceptorFn } from '../interfaces';
import { CubejsHandlerError } from '../cubejs-handler-error';
import { Endpoint, endpointForWsMethod } from '../query-completion-logger';
import {
  authMessageSchema,
  unsubscribeMessageSchema,
  methodMessageSchema,
  WsMessage,
} from './message-schema';

import type { ApiGateway } from '../gateway';
import type { LocalSubscriptionStore } from './local-subscription-store';

const ensureArray = (value: any) => (Array.isArray(value) ? value : [value]);

const combineByTenant = (values: Array<{ tenantId: string, cube: string }>): Array<{ tenantId: string, cubes: Array<string> }> => {
  const result: Record<string, Set<string>> = {};

  for (const { tenantId, cube } of values) {
    if (!result[tenantId]) {
      result[tenantId] = new Set();
    }
    result[tenantId].add(cube);
  }
  return Object.entries(result).map(([tenantId, cubes]) => ({ tenantId, cubes: Array.from(cubes) }));
};

const methodParams: Record<string, string[]> = Object.freeze({
  load: ['query', 'queryType', 'cache'],
  sql: ['query'],
  'dry-run': ['query'],
  meta: ['onlyViews'],
  subscribe: ['query', 'queryType', 'cache'],
  unsubscribe: [],
});

const calcMessageLength = (message: unknown) => Buffer.byteLength(
  typeof message === 'string' ? message : JSON.stringify(message)
);

export type WebSocketSendMessageFn = (connectionId: string, message: any) => Promise<void>;

export class SubscriptionServer {
  readonly #cubeRenewSubject = new Subject<unknown>();

  readonly #cubeRenewedPipe = this.#cubeRenewSubject.pipe(
    map((val) => ensureArray(val)),
    // Map only the renewedCube property
    map((val) => val as Array<{ renewedCube: string | undefined, requestContext: { securityContext: { tenantId: string } } }>),
    map((val) => val.filter(v => v.renewedCube !== undefined) as Array<{ renewedCube: string, requestContext: { securityContext: { tenantId: string } } }>),
    map((val) => val.map(v => ({ cube: v.renewedCube, tenantId: v.requestContext.securityContext.tenantId }))),
    // Buffer the values for 300ms
    bufferTime(100),
    map((renewedCubes) => renewedCubes.flat()),
    map(combineByTenant),
  );
  
  public constructor(
    protected readonly apiGateway: ApiGateway,
    protected readonly sendMessage: WebSocketSendMessageFn,
    protected readonly subscriptionStore: LocalSubscriptionStore,
    protected readonly contextAcceptor: ContextAcceptorFn,
    protected readonly eventEmitter: EventEmitterInterface
  ) {
    this.eventEmitter.on('cubeRenewed', (val: unknown) => this.#cubeRenewSubject.next(val));
    this.#cubeRenewedSubscription = this.#cubeRenewedPipe.subscribe(this.renewCubes.bind(this));
  }

  readonly #cubeRenewedSubscription: { unsubscribe(): void };

  /**
   * Stops the renew pipeline (its bufferTime keeps a timer running). Optional: for owners and
   * tests that discard the server.
   */
  public close() {
    this.#cubeRenewedSubscription.unsubscribe();
    this.#cubeRenewSubject.complete();
  }

  protected resultFn(connectionId: string, messageId: string | undefined, requestId: string | undefined, logNetworkUsage: boolean = true) {
    return async (message, { status } = { status: 200 }) => {
      if (logNetworkUsage) {
        this.apiGateway.log({ type: 'Outgoing network usage', service: 'api-ws', bytes: calcMessageLength(message), }, { requestId });
      }

      return this.sendMessage(connectionId, { messageId, message, status });
    };
  }

  protected deserializeMessage(message: any): any {
    try {
      return JSON.parse(message);
    } catch (e: any) {
      throw new CubejsHandlerError(400, 'Invalid JSON payload', e.message);
    }
  }

  protected mapZodError(error: ZodError): string {
    return error.issues
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .join(', ');
  }

  protected validateMessage(message: object): WsMessage {
    if ('authorization' in message) {
      const result = authMessageSchema.safeParse(message);
      if (!result.success) {
        throw new CubejsHandlerError(400, 'Invalid authorization message format', this.mapZodError(result.error));
      }

      return result.data;
    }

    if ('unsubscribe' in message) {
      const result = unsubscribeMessageSchema.safeParse(message);
      if (!result.success) {
        throw new CubejsHandlerError(400, 'Invalid unsubscribe message format', this.mapZodError(result.error));
      }

      return result.data;
    }

    const result = methodMessageSchema.safeParse(message);
    if (!result.success) {
      throw new CubejsHandlerError(400, 'Invalid message format', this.mapZodError(result.error));
    }

    return result.data;
  }

  public async processMessage(connectionId: string, body: string) {
    let message: any | undefined;

    try {
      message = this.deserializeMessage(body);
      message = this.validateMessage(message);

      await this.handleMessage(connectionId, message, false);
    } catch (e) {
      // A message that cannot be parsed or validated gets no completion line: cube.error
      this.apiGateway.handleError({
        e,
        query: message?.query,
        res: this.resultFn(connectionId, message?.messageId, undefined, false),
      });
    }
  }

  protected async handleMessage(connectionId: string, message: WsMessage, isSubscription: boolean) {
    let authContext: any = {};
    let context: Partial<ExtendedRequestContext> = {};
    const startedAt = new Date();
    // Once dispatched, the gateway method records the request's completion line itself
    let dispatched = false;

    const bytes = calcMessageLength(message);

    try {
      if ('authorization' in message) {
        authContext = { isSubscription, protocol: 'ws' };
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

      if ('unsubscribe' in message) {
        await this.subscriptionStore.unsubscribe(connectionId, message.unsubscribe);
        return;
      }

      if (!message.messageId) {
        throw new UserError('messageId is required');
      }

      authContext = await this.subscriptionStore.getAuthContext(connectionId);
      if (!authContext && isSubscription) {
        // A server poll for a connection without an auth context: the connection was disconnected while the
        // previous poll was in flight and that poll's late subscribe() re-created it. Drop it quietly instead
        // of answering 'Not authorized' (and recording an error) on every poll until the eviction
        await this.subscriptionStore.disconnect(connectionId);
        return;
      }

      if (!authContext) {
        this.recordFailure({
          endpoint: endpointForWsMethod('method' in message ? message.method : undefined),
          startedAt,
          e: new CubejsHandlerError(403, 'Forbidden', 'Not authorized'),
        });
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
        throw new UserError('Method is required');
      }

      if (!methodParams.hasOwnProperty(message.method)) {
        throw new UserError(`Unsupported method: ${message.method}`);
      }

      const subscriptionId = message.messageId;
      const baseRequestId = message.requestId || `${connectionId}-${subscriptionId}`;
      // Without a requestId the id is built from the raw messageId, which the schema doesn't restrict
      if (!isValidRequestId(baseRequestId)) {
        throw new UserError(`Invalid request id: ${JSON.stringify(baseRequestId)}`);
      }

      const requestId = `${baseRequestId}-span-${uuidv4()}`;

      context = await this.apiGateway.contextByReq(
        // TODO: We need to standardize type for WS request type
        message as any,
        authContext.securityContext,
        requestId
      );

      this.apiGateway.log({
        type: 'Incoming network usage',
        service: 'api-ws',
        bytes,
      }, context);

      const collectedParams: Record<string, unknown> = Object.create(null);

      if (message.params) {
        for (const k of methodParams[message.method]) {
          collectedParams[k] = message.params[k];
        }
      }

      const method = message.method === 'meta'
        ? 'metaExtended'
        : message.method.replace(/[^a-z]+(.)/g, (_m, chr) => chr.toUpperCase());
      if (collectedParams.cache !== undefined) {
        collectedParams.cacheMode = collectedParams.cache;
        delete collectedParams.cache;
      }
      dispatched = true;
      await this.apiGateway[method]({
        ...collectedParams,
        connectionId,
        context,
        signedWithPlaygroundAuthSecret: authContext.signedWithPlaygroundAuthSecret,
        isSubscription,
        apiType: 'ws',
        res: this.resultFn(connectionId, message.messageId, requestId),
        subscriptionState: async () => {
          const subscription = await this.subscriptionStore.getSubscription(connectionId, subscriptionId);
          return subscription && subscription.state;
        },
        subscribe: async (state) => this.subscriptionStore.subscribe(connectionId, subscriptionId, {
          message,
          state
        }),
        unsubscribe: async () => this.subscriptionStore.unsubscribe(connectionId, subscriptionId)
      });

      await this.sendMessage(connectionId, { messageProcessedId: message.messageId });
    } catch (e) {
      const messageId = 'messageId' in message ? message.messageId : undefined;
      const query = 'params' in message && message.params && 'query' in message.params
        ? message.params.query
        : undefined;

      const endpoint = endpointForWsMethod('method' in message ? message.method : undefined);
      // Once dispatched, a wired gateway method has written the request's completion line itself;
      // before that, recordFailure writes it for a wired method. Otherwise handleError writes
      // cube.error, so the failure is visible exactly once at the default level
      const completionLogged = dispatched
        ? Boolean(endpoint)
        : this.recordFailure({
          context,
          endpoint,
          startedAt,
          e,
        });

      this.apiGateway.handleError({
        e,
        query,
        res: this.resultFn(connectionId, messageId, context.requestId),
        context,
        completionLogged,
      });
    }
  }

  /**
   * Completion line for a message that failed before its gateway method ran. Returns whether a
   * completion line covers the message. Never throws.
   */
  protected recordFailure(params: { context?: Partial<ExtendedRequestContext>, endpoint?: Endpoint, startedAt: Date, e: unknown }): boolean {
    try {
      return this.apiGateway.recordRequestFailure({ ...params, method: 'WS' });
    } catch {
      // logging must never break message handling
      return false;
    }
  }

  public async processSubscriptions() {
    const allSubscriptions = this.subscriptionStore.getAllSubscriptions();
    await Promise.all(allSubscriptions.map(async subscription => {
      await this.handleMessage(subscription.connectionId, subscription.message, true);
    }));
  }

  public async disconnect(connectionId: string) {
    await this.subscriptionStore.disconnect(connectionId);
  }

  public clear() {
    this.subscriptionStore.clear();
  }

  public async renewCubes(updatedValues: Array<{ tenantId: string, cubes: Array<string> }>) {
    if (updatedValues.length === 0) {
      return;
    }

    const perTenant = updatedValues.map(({ tenantId, cubes }) => ({
      tenantId,
      cubes,
      subs: this.subscriptionStore.getSubscriptionsByCubeName(tenantId, cubes),
    }));
    const subs = perTenant.map(t => t.subs).flat();

    if (subs.length === 0) {
      return;
    }

    for (const { tenantId, cubes, subs: tenantSubs } of perTenant) {
      if (tenantSubs.length > 0) {
        // other store implementations may not expose the counter
        this.subscriptionStore.recordRenew?.(tenantSubs.length, tenantId, cubes);
      }
    }
    subs.map(async subscription => {
      this.handleMessage(subscription.connectionId, subscription.message, true);
    });
  }
}
