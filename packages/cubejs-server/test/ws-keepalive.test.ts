import { EventEmitter } from 'events';

import { WebSocketKeepAlive, KeepAliveSocket } from '../src/ws-keepalive';

class FakeSocket extends EventEmitter {
  public ping = jest.fn();

  public terminate = jest.fn();

  public asSocket(): KeepAliveSocket {
    return this as unknown as KeepAliveSocket;
  }
}

const INTERVAL = 1000;
const tick = (times = 1) => {
  for (let i = 0; i < times; i++) {
    jest.advanceTimersByTime(INTERVAL);
  }
};

describe('WebSocketKeepAlive', () => {
  let keepAlive: WebSocketKeepAlive | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    keepAlive?.close();
    keepAlive = undefined;
    jest.useRealTimers();
  });

  test('a pong keeps a socket alive', () => {
    keepAlive = new WebSocketKeepAlive({ intervalMs: INTERVAL });
    const socket = new FakeSocket();
    keepAlive.add(socket.asSocket(), 'c1');

    tick();
    expect(socket.ping).toHaveBeenCalledTimes(1);
    socket.emit('pong');
    tick();

    expect(socket.terminate).not.toHaveBeenCalled();
    expect(socket.ping).toHaveBeenCalledTimes(2);
  });

  test('a message keeps a socket alive even if it never pongs', () => {
    keepAlive = new WebSocketKeepAlive({ intervalMs: INTERVAL });
    const socket = new FakeSocket();
    keepAlive.add(socket.asSocket(), 'c1');

    for (let i = 0; i < 5; i++) {
      tick();
      socket.emit('message', 'hello');
    }

    expect(socket.terminate).not.toHaveBeenCalled();
  });

  test('a missed pong terminates the socket exactly once', () => {
    const onTerminate = jest.fn();
    keepAlive = new WebSocketKeepAlive({ intervalMs: INTERVAL, onTerminate });
    const socket = new FakeSocket();
    keepAlive.add(socket.asSocket(), 'c1');

    tick(2);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(onTerminate).toHaveBeenCalledWith('c1');

    tick(3);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(onTerminate).toHaveBeenCalledTimes(1);
  });

  test('a ping that throws terminates that socket and the loop continues', () => {
    keepAlive = new WebSocketKeepAlive({ intervalMs: INTERVAL });
    const broken = new FakeSocket();
    broken.ping.mockImplementation(() => {
      throw new Error('WebSocket is not open');
    });
    const healthy = new FakeSocket();
    keepAlive.add(broken.asSocket(), 'broken');
    keepAlive.add(healthy.asSocket(), 'healthy');

    tick();

    expect(broken.terminate).toHaveBeenCalledTimes(1);
    expect(healthy.ping).toHaveBeenCalledTimes(1);
    expect(healthy.terminate).not.toHaveBeenCalled();
  });

  test('closed sockets are forgotten', () => {
    const onTick = jest.fn();
    keepAlive = new WebSocketKeepAlive({ intervalMs: INTERVAL, onTick });
    const sockets = Array.from({ length: 100 }, () => new FakeSocket());
    sockets.forEach((s, i) => keepAlive!.add(s.asSocket(), `c${i}`));
    sockets.forEach(s => s.emit('close'));

    tick();

    expect(onTick).toHaveBeenCalledWith(0);
    sockets.forEach(s => expect(s.ping).not.toHaveBeenCalled());
  });

  test('onTick receives the connection count after terminations', () => {
    const onTick = jest.fn();
    keepAlive = new WebSocketKeepAlive({ intervalMs: INTERVAL, onTick });
    const a = new FakeSocket();
    const b = new FakeSocket();
    const c = new FakeSocket();
    keepAlive.add(a.asSocket(), 'a');
    keepAlive.add(b.asSocket(), 'b');
    keepAlive.add(c.asSocket(), 'c');

    tick();
    expect(onTick).toHaveBeenLastCalledWith(3);
    a.emit('pong');
    b.emit('pong');
    tick();

    expect(c.terminate).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenLastCalledWith(2);
  });

  test('a throwing onTerminate or onTick does not break the loop', () => {
    const onTerminate = jest.fn(() => {
      throw new Error('metrics down');
    });
    const onTick = jest.fn(() => {
      throw new Error('gauge down');
    });
    keepAlive = new WebSocketKeepAlive({ intervalMs: INTERVAL, onTerminate, onTick });
    const dead1 = new FakeSocket();
    const dead2 = new FakeSocket();
    const alive = new FakeSocket();
    keepAlive.add(dead1.asSocket(), 'dead1');
    keepAlive.add(dead2.asSocket(), 'dead2');
    keepAlive.add(alive.asSocket(), 'alive');

    tick();
    alive.emit('pong');
    expect(() => tick()).not.toThrow();

    expect(dead1.terminate).toHaveBeenCalledTimes(1);
    expect(dead2.terminate).toHaveBeenCalledTimes(1);
    alive.emit('pong');
    tick();
    expect(alive.ping).toHaveBeenCalledTimes(3);
    expect(alive.terminate).not.toHaveBeenCalled();
  });

  test('close() stops the timer', () => {
    keepAlive = new WebSocketKeepAlive({ intervalMs: INTERVAL });
    const socket = new FakeSocket();
    keepAlive.add(socket.asSocket(), 'c1');
    expect(jest.getTimerCount()).toBe(1);

    keepAlive.close();
    expect(jest.getTimerCount()).toBe(0);

    tick(3);
    expect(socket.ping).not.toHaveBeenCalled();
  });

  test('an interval of 0 never starts a timer', () => {
    keepAlive = new WebSocketKeepAlive({ intervalMs: 0 });
    const socket = new FakeSocket();
    keepAlive.add(socket.asSocket(), 'c1');

    expect(jest.getTimerCount()).toBe(0);
    tick(3);
    expect(socket.ping).not.toHaveBeenCalled();
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  test('the timer is unref\'d so it never keeps the process alive', () => {
    const unref = jest.fn();
    const spy = jest.spyOn(global, 'setInterval').mockReturnValue({ unref } as unknown as NodeJS.Timeout);

    try {
      keepAlive = new WebSocketKeepAlive({ intervalMs: INTERVAL });
      keepAlive.add(new FakeSocket().asSocket(), 'c1');
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
