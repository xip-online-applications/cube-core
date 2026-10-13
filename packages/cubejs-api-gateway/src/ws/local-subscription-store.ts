import { emitLog, getPodName } from '@cubejs-backend/shared';
import { Tracer } from '@cubejs-backend/tracer';

interface LocalSubscriptionStoreOptions {
  heartBeatInterval?: number;
}

export type LocalSubscriptionStoreSubscription = {
  message: any,
  state: any,
  timestamp: Date,
  cubes: string[],
};

export type LocalSubscriptionStoreConnection = {
  subscriptions: Map<string, LocalSubscriptionStoreSubscription>,
  authContext?: any,
};

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

  private unsubscribeUnknownCount = 0;

  private refreshCount = 0;

  private renewCount = 0;

  private readonly summaryTimer: NodeJS.Timeout;

  public constructor(options: LocalSubscriptionStoreOptions = {}) {
    Tracer.init();
    this.heartBeatInterval = options.heartBeatInterval || 60;

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

  public async subscribe(connectionId: string, subscriptionId: string, subscription) {
    const connection = this.getConnectionOrCreate(connectionId);
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

  public getAllSubscriptions() {
    const now = Date.now();
    const staleThreshold = this.heartBeatInterval * 4 * 1000;
    const result: Array<{ connectionId: string } & LocalSubscriptionStoreSubscription> = [];

    for (const [connectionId, connection] of this.connections) {
      for (const [subscriptionId, subscription] of connection.subscriptions) {
        if (now - subscription.timestamp.getTime() > staleThreshold) {
          connection.subscriptions.delete(subscriptionId);
        }
      }

      for (const [, subscription] of connection.subscriptions) {
        result.push({ connectionId, ...subscription });
      }
    }

    return result;
  }

  public getTenantSubscriptions(tenantId: string) {
    const now = Date.now();
    const staleThreshold = this.heartBeatInterval * 4 * 1000;
    const result: Array<{ connectionId: string } & LocalSubscriptionStoreSubscription> = [];

    for (const [connectionId, connection] of this.connections) {
      for (const [subscriptionId, subscription] of connection.subscriptions) {
        if (now - subscription.timestamp.getTime() > staleThreshold) {
          connection.subscriptions.delete(subscriptionId);
        }
      }

      if (connection.authContext?.securityContext?.tenantId === tenantId) {
        for (const [, subscription] of connection.subscriptions) {
          result.push({ connectionId, ...subscription });
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
    this.connections.delete(connectionId);
  }

  public async getAuthContext(connectionId: string) {
    return this.getConnectionOrCreate(connectionId).authContext;
  }

  public async setAuthContext(connectionId: string, authContext) {
    this.getConnectionOrCreate(connectionId).authContext = authContext;
  }

  protected getConnectionOrCreate(connectionId: string): LocalSubscriptionStoreConnection {
    const connect = this.getConnection(connectionId);
    if (connect) {
      return connect;
    }

    const connection: LocalSubscriptionStoreConnection = { subscriptions: new Map<string, LocalSubscriptionStoreSubscription>() };
    this.connections.set(connectionId, connection);

    return connection;
  }

  protected getConnection(connectionId: string): LocalSubscriptionStoreConnection | undefined {
    return this.connections.get(connectionId);
  }

  public clear() {
    this.connections.clear();
  }

  /**
   * The 60 s interval callback. Never throws: an exception here would be uncaught.
   */
  private logConnections() {
    try {
      this.logConnectionsUnsafe();
    } catch {
      // metrics and logging must never crash the process
    } finally {
      this.unsubscribeUnknownCount = 0;
      this.refreshCount = 0;
      this.renewCount = 0;
    }
  }

  private logConnectionsUnsafe() {
    const subsPerTenant = getNumberOfSubscriptionsPerTenant(this.connections);
    const tenants = Object.keys(subsPerTenant);

    tenants.forEach(tenantIdentifier => {
      Tracer.init().get().gauge('subscriptions', subsPerTenant[tenantIdentifier], {
        pod: getPodName(),
        tenant: tenantIdentifier,
      });
    });

    const total = tenants.reduce((sum, t) => sum + subsPerTenant[t], 0);
    if (this.unsubscribeUnknownCount || this.refreshCount || this.renewCount || total > 0) {
      emitLog('info', 'cube.ws.summary', {
        subscriptionsByTenant: subsPerTenant,
        unsubscribeUnknown: this.unsubscribeUnknownCount,
        refreshes: this.refreshCount,
        renews: this.renewCount,
      });
    }
  }
}
