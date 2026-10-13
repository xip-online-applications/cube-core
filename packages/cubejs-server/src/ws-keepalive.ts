import type WebSocket from 'ws';

export type KeepAliveSocket = Pick<WebSocket, 'ping' | 'terminate' | 'on'>;

export interface KeepAliveOptions {
  // Milliseconds between ticks; <= 0 never starts a timer
  intervalMs: number;
  onTerminate?: (connectionId: string) => void;
  // Called every tick with the number of tracked connections after terminations
  onTick?: (connectionCount: number) => void;
}

interface TrackedSocket {
  connectionId: string;
  alive: boolean;
}

/**
 * Detects dead (half-open) WebSocket connections: a socket that neither ponged nor sent a message
 * since the previous tick is terminated, which fires its `close` event and so the existing cleanup.
 * Nothing here may throw out of the interval callback.
 */
export class WebSocketKeepAlive {
  private readonly sockets = new Map<KeepAliveSocket, TrackedSocket>();

  private timer: NodeJS.Timeout | null = null;

  public constructor(private readonly options: KeepAliveOptions) {}

  public add(ws: KeepAliveSocket, connectionId: string): void {
    const tracked: TrackedSocket = { connectionId, alive: true };
    this.sockets.set(ws, tracked);

    const markAlive = () => {
      tracked.alive = true;
    };
    ws.on('pong', markAlive);
    ws.on('message', markAlive);
    ws.on('close', () => {
      this.sockets.delete(ws);
    });

    if (!this.timer && this.options.intervalMs > 0) {
      this.timer = setInterval(() => this.tick(), this.options.intervalMs);
      this.timer.unref();
    }
  }

  public close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sockets.clear();
  }

  private tick(): void {
    for (const [ws, tracked] of Array.from(this.sockets)) {
      try {
        let dead = !tracked.alive;
        if (!dead) {
          tracked.alive = false;

          try {
            ws.ping();
          } catch {
            dead = true;
          }
        }

        if (dead) {
          this.sockets.delete(ws);
          ws.terminate();
          this.safely(() => this.options.onTerminate?.(tracked.connectionId));
        }
      } catch {
        // one misbehaving socket must not stop the others
      }
    }

    this.safely(() => this.options.onTick?.(this.sockets.size));
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // metrics and logging failures must never break the keepalive loop
    }
  }
}
