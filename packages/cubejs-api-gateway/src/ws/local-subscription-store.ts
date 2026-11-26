import { emitLog, getEnv, getPodName } from '@cubejs-backend/shared';
import { Tracer } from '@cubejs-backend/tracer';

interface LocalSubscriptionStoreOptions {
  heartBeatInterval?: number;
  // 0 disables the cap. Defaults to CUBEJS_WEB_SOCKETS_MAX_SUBSCRIPTIONS
  maxSubscriptionsPerConnection?: number;
}

export type LocalSubscriptionStoreSubscription = {
  message: any,
  state: any,
  timestamp: Date,
  cubes: string[],
  // Registered before its first load finished: not polled or renewed until subscribe() stores its state
  pending?: boolean,
};

// Unsubscribed ids remembered per connection, oldest dropped first. Clients don't reuse a
// messageId on a connection, so only a subscribe still in flight can ever hit one
const MAX_UNSUBSCRIBED_IDS = 10_000;

export class LocalSubscriptionStoreConnection {
  public readonly subscriptions: Map<string, LocalSubscriptionStoreSubscription> = new Map();

  public authContext?: any;

  protected authorizing: boolean = false;

  protected closed: boolean = false;

  // An unsubscribe can arrive while that subscription's load is in flight (its first load, or a
  // poll); the load's subscribe() must not bring it back afterwards
  protected readonly unsubscribedIds: Set<string> = new Set();

  public isAuthorizing(): boolean {
    return this.authorizing;
  }

  public async trackAuth<T>(fn: () => Promise<T>): Promise<T> {
    this.authorizing = true;

    try {
      return await fn();
    } finally {
      this.authorizing = false;
    }
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public close(): void {
    this.closed = true;
  }

  public markUnsubscribed(subscriptionId: string): void {
    this.unsubscribedIds.delete(subscriptionId);
    this.unsubscribedIds.add(subscriptionId);

    if (this.unsubscribedIds.size > MAX_UNSUBSCRIBED_IDS) {
      const oldest = this.unsubscribedIds.values().next().value;
      if (oldest !== undefined) {
        this.unsubscribedIds.delete(oldest);
      }
    }
  }

  public isUnsubscribed(subscriptionId: string): boolean {
    return this.unsubscribedIds.has(subscriptionId);
  }
}

export type RegisterSubscriptionResult = 'registered' | 'limit_exceeded' | 'unsubscribed' | 'gone';

const haveCommonElement = (arr1: string[], arr2: string[]): boolean => arr1.some(element => arr2.includes(element));

// TODO: Check whether this is the correct way to get cube names
const getCubeNames = (query) => {
  if (!query) {
    return [];
  }

  const allColumns = [
    ...(query.measures || []).map(m => m.split('.')[0]),
    ...(query.dimensions || []).map(d => d.split('.')[0]),
  ];

  return Array.from(new Set(allColumns));
};

const getNumberOfSubscriptionsPerTenant = (connections: Map<string, LocalSubscriptionStoreConnection>): Record<string, number> => {
  const result: Record<string, number> = {};

  for (const [, connection] of connections) {
    const tenantId = connection.authContext?.securityContext?.tenantId;
    if (tenantId) {
      result[tenantId] = (result[tenantId] || 0) + connection.subscriptions.size;
    }
  }

  return result;
};

export class LocalSubscriptionStore {
  protected readonly connections: Map<string, LocalSubscriptionStoreConnection> = new Map();

  protected readonly heartBeatInterval: number;

  protected readonly maxSubscriptionsPerConnection: number;

  protected unsubscribeUnknownCount = 0;

  protected limitExceededCount = 0;

  protected refreshCount = 0;

  protected renewCount = 0;

  protected readonly summaryTimer: NodeJS.Timeout;

  public constructor(options: LocalSubscriptionStoreOptions = {}) {
    Tracer.init();
    this.heartBeatInterval = options.heartBeatInterval || 60;
    this.maxSubscriptionsPerConnection = options.maxSubscriptionsPerConnection ?? getEnv('webSocketsMaxSubscriptions');

    this.summaryTimer = setInterval(() => {
      this.logConnections();
    }, 60 * 1000);
    this.summaryTimer.unref();
  }

  /**
   * Stops the periodic subscription summary. Optional: the timer is unref'd, so it never keeps
   * the process alive; this is for owners (and tests) that discard the store.
   */
  public close() {
    clearInterval(this.summaryTimer);
  }

  /**
   * The only place a connection is created. Everything else ignores unknown connections, so work
   * that finishes after a disconnect can't bring the connection back.
   */
  public connect(connectionId: string): LocalSubscriptionStoreConnection {
    const existing = this.getConnection(connectionId);
    if (existing) {
      return existing;
    }

    const connection = new LocalSubscriptionStoreConnection();
    this.connections.set(connectionId, connection);

    return connection;
  }

  /**
   * Records that subscriptions were renewed (called by the SubscriptionServer).
   */
  public recordRenew(count: number, tenant?: string, cubes?: string[]) {
    this.renewCount++;
    emitLog('debug', 'cube.ws.renew', { tenant, count, cubes });
  }

  public async getSubscription(connectionId: string, subscriptionId: string): Promise<LocalSubscriptionStoreSubscription | undefined> {
    // only get subscription, do not create connection if it doesn't exist
    const connection = this.getConnection(connectionId);
    if (!connection) {
      return undefined;
    }

    return connection.subscriptions.get(subscriptionId);
  }

  /**
   * Registers a new subscription before its first load, so an unsubscribe that arrives during the
   * load finds it, and so the per-connection cap is checked before the load runs.
   */
  public async registerSubscription(connectionId: string, subscriptionId: string, message: any): Promise<RegisterSubscriptionResult> {
    const connection = this.getConnection(connectionId);
    if (!connection || connection.isClosed()) {
      return 'gone';
    }

    // The unsubscribe was handled first (the subscribe was still authorizing): it stays unsubscribed
    if (connection.isUnsubscribed(subscriptionId)) {
      return 'unsubscribed';
    }

    const existing = connection.subscriptions.get(subscriptionId);
    if (
      !existing
      && this.maxSubscriptionsPerConnection > 0
      && connection.subscriptions.size >= this.maxSubscriptionsPerConnection
    ) {
      this.limitExceededCount++;
      emitLog('debug', 'cube.ws.subscription_limit_exceeded', {
        connectionId,
        activeCount: connection.subscriptions.size,
        limit: this.maxSubscriptionsPerConnection,
      });

      return 'limit_exceeded';
    }

    connection.subscriptions.set(subscriptionId, {
      message,
      state: existing?.state,
      cubes: getCubeNames(message?.params?.query),
      timestamp: new Date(),
      pending: !existing || Boolean(existing.pending),
    });

    return 'registered';
  }

  /**
   * Drops a registration whose first load never stored a state (it threw before subscribe()).
   */
  public async abandonPendingSubscription(connectionId: string, subscriptionId: string) {
    const connection = this.getConnection(connectionId);
    if (connection?.subscriptions.get(subscriptionId)?.pending) {
      connection.subscriptions.delete(subscriptionId);
    }
  }

  public async subscribe(connectionId: string, subscriptionId: string, subscription) {
    // A subscribe that finishes after the disconnect must not bring the connection back
    const connection = this.getConnection(connectionId);
    if (!connection || connection.isClosed()) {
      return;
    }

    // ...nor one that finishes after the subscription was unsubscribed
    if (connection.isUnsubscribed(subscriptionId)) {
      return;
    }

    connection.subscriptions.set(subscriptionId, {
      ...subscription,
      cubes: getCubeNames(subscription.message?.params?.query),
      timestamp: new Date()
    });
  }

  public async unsubscribe(connectionId: string, subscriptionId: string) {
    const connection = this.getConnection(connectionId);
    if (!connection) {
      return;
    }

    connection.markUnsubscribed(subscriptionId);

    if (!connection.subscriptions.has(subscriptionId)) {
      this.unsubscribeUnknownCount++;
      emitLog('debug', 'cube.ws.unsubscribe_unknown', {
        connectionId,
        idType: typeof subscriptionId,
        activeCount: connection.subscriptions.size,
      });

      try {
        Tracer.init().get().increment('ws.unsubscribe_unknown', 1, { pod: getPodName() });
      } catch {
        // metrics must never break unsubscribe
      }
      return;
    }

    connection.subscriptions.delete(subscriptionId);
  }

  protected evictStale(connection: LocalSubscriptionStoreConnection, now: number) {
    const staleThreshold = this.heartBeatInterval * 4 * 1000;

    for (const [subscriptionId, subscription] of connection.subscriptions) {
      if (now - subscription.timestamp.getTime() > staleThreshold) {
        connection.subscriptions.delete(subscriptionId);
      }
    }
  }

  /**
   * Subscriptions to poll. Pending ones are left out: their first load is still running.
   */
  public getAllSubscriptions() {
    const now = Date.now();
    const result: Array<{ connectionId: string } & LocalSubscriptionStoreSubscription> = [];

    for (const [connectionId, connection] of this.connections) {
      this.evictStale(connection, now);

      for (const [, subscription] of connection.subscriptions) {
        if (!subscription.pending) {
          result.push({ connectionId, ...subscription });
        }
      }
    }

    return result;
  }

  public getTenantSubscriptions(tenantId: string) {
    const now = Date.now();
    const result: Array<{ connectionId: string } & LocalSubscriptionStoreSubscription> = [];

    for (const [connectionId, connection] of this.connections) {
      this.evictStale(connection, now);

      if (connection.authContext?.securityContext?.tenantId === tenantId) {
        for (const [, subscription] of connection.subscriptions) {
          if (!subscription.pending) {
            result.push({ connectionId, ...subscription });
          }
        }
      }
    }

    return result;
  }

  public getSubscriptionsByCubeName(tenantId: string, cubes: Array<string>) {
    const subs = this.getTenantSubscriptions(tenantId).filter(subscription => haveCommonElement(cubes, subscription.cubes));
    if (subs.length > 0) {
      this.refreshCount++;
      emitLog('debug', 'cube.ws.refresh', { tenant: tenantId, count: subs.length, cubes });
    }
    return subs;
  }

  public async disconnect(connectionId: string) {
    const connection = this.getConnection(connectionId);
    if (!connection) {
      return;
    }

    connection.close();
    this.connections.delete(connectionId);
  }

  public async getAuthContext(connectionId: string) {
    return this.getConnection(connectionId)?.authContext;
  }

  public async setAuthContext(connectionId: string, authContext) {
    const connection = this.getConnection(connectionId);
    if (!connection) {
      return;
    }

    connection.authContext = authContext;
  }

  protected getConnection(connectionId: string): LocalSubscriptionStoreConnection | undefined {
    return this.connections.get(connectionId);
  }

  public clear() {
    for (const connection of this.connections.values()) {
      connection.close();
    }

    this.connections.clear();
  }

  /**
   * The 60 s interval callback. Never throws: an exception here would be uncaught.
   */
  protected logConnections() {
    try {
      this.logConnectionsUnsafe();
    } catch {
      // metrics and logging must never crash the process
    } finally {
      this.unsubscribeUnknownCount = 0;
      this.limitExceededCount = 0;
      this.refreshCount = 0;
      this.renewCount = 0;
    }
  }

  protected logConnectionsUnsafe() {
    const subsPerTenant = getNumberOfSubscriptionsPerTenant(this.connections);
    const tenants = Object.keys(subsPerTenant);

    tenants.forEach(tenantIdentifier => {
      Tracer.init().get().gauge('subscriptions', subsPerTenant[tenantIdentifier], {
        pod: getPodName(),
        tenant: tenantIdentifier,
      });
    });

    const total = tenants.reduce((sum, t) => sum + subsPerTenant[t], 0);
    if (this.unsubscribeUnknownCount || this.limitExceededCount || this.refreshCount || this.renewCount || total > 0) {
      emitLog('info', 'cube.ws.summary', {
        subscriptionsByTenant: subsPerTenant,
        unsubscribeUnknown: this.unsubscribeUnknownCount,
        subscriptionLimitExceeded: this.limitExceededCount,
        refreshes: this.refreshCount,
        renews: this.renewCount,
      });
    }
  }
}
