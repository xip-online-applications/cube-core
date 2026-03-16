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
