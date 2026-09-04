import hotShots, { StatsD } from 'hot-shots';

export class Tracer {
  private static tracer: StatsD;

  private static self: Tracer;

  public constructor() {
    if (!Tracer.tracer) {
      // hot-shots constructor uses function style.
      // eslint-disable-next-line new-cap
      Tracer.tracer = new hotShots({
        host: process.env['DD_AGENT_HOST'] ?? '127.0.0.1',
        prefix: `transai.${process.env['DD_SERVICE'] ?? 'unknown'}.`,
        errorHandler: (error) => {
          // hot-shots only listens for socket errors when an errorHandler is
          // set; without one, an unreachable/unresolvable DD_AGENT_HOST would
          // otherwise crash the process with an uncaught 'error' event.
          // eslint-disable-next-line no-console
          console.error('StatsD/Datadog error', error);
        },
      });
    }
  }

  public static init(): Tracer {
    if (!Tracer.self || !Tracer.tracer) {
      Tracer.self = new Tracer();
    }

    return Tracer.self;
  }

  public get(): StatsD {
    Tracer.init();

    return Tracer.tracer;
  }
}
