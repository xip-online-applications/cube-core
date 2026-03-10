interface LocalSubscriptionStoreOptions {
  heartBeatInterval?: number;
}

export type SubscriptionId = string | number;

const normalizeSubscriptionId = (subscriptionId: SubscriptionId): string => {
  if (typeof subscriptionId === 'number') {
    return subscriptionId.toString();
  }

  return subscriptionId;
};

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

export class LocalSubscriptionStore {
  protected readonly connections: Map<string, LocalSubscriptionStoreConnection> = new Map();

  protected readonly hearBeatInterval: number;

  public constructor(options: LocalSubscriptionStoreOptions = {}) {
    this.hearBeatInterval = options.heartBeatInterval || 60;
  }

  public async getSubscription(connectionId: string, subscriptionId: SubscriptionId): Promise<LocalSubscriptionStoreSubscription | undefined> {
    const connection = this.getConnection(connectionId);
    if (!connection) {
      return undefined;
    }

    const normalizedSubscriptionId = normalizeSubscriptionId(subscriptionId);
    return connection.subscriptions.get(normalizedSubscriptionId);
  }

  public async subscribe(connectionId: string, subscriptionId: SubscriptionId, subscription) {
    const normalizedSubscriptionId = normalizeSubscriptionId(subscriptionId);
    const connection = this.getConnectionOrCreate(connectionId);
    connection.subscriptions.set(normalizedSubscriptionId, {
      ...subscription,
      cubes: getCubeNames(subscription.message?.params?.query),
      timestamp: new Date()
    });
  }

  public async unsubscribe(connectionId: string, subscriptionId: SubscriptionId) {
    const connection = this.getConnection(connectionId);
    if (!connection) {
      return;
    }
    const normalizedSubscriptionId = normalizeSubscriptionId(subscriptionId);

    if (connection.subscriptions.has(normalizedSubscriptionId)) {
      connection.subscriptions.delete(normalizedSubscriptionId);
    } else {
      console.warn(`Trying to unsubscribe non-existing subscription ${typeof subscriptionId} ${subscriptionId} for connection ${connectionId}`);
    }
  }

  public getAllSubscriptions() {
    const now = Date.now();
    const staleThreshold = this.hearBeatInterval * 4 * 1000;
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
    const staleThreshold = this.hearBeatInterval * 4 * 1000;
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
      console.log(`Refreshing ${subs.length} subscriptions for tenant ${tenantId} cause cubes ${cubes.join(', ')} have changed`);
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
}
