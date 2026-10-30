import crypto from 'crypto';
import { DefaultEventEmitter } from '@cubejs-backend/event-emitter';
import { ResultWrapper } from '@cubejs-backend/native';
import { testLogger } from '@cubejs-backend/shared';

import { ApiGateway } from '../../src';
import { AdapterApiMock, compilerApi, DataSourceStorageMock } from '../mocks';

class TestApiGateway extends ApiGateway {
  public subscriptionResultHash(result: { message: any, opts: any }): string {
    return super.subscriptionResultHash(result);
  }
}

const createGateway = () => new TestApiGateway(
  'secret',
  compilerApi,
  async () => new AdapterApiMock(),
  testLogger,
  new DefaultEventEmitter(),
  {
    standalone: true,
    dataSourceStorage: new DataSourceStorageMock(),
    basePath: '/cubejs-api',
    refreshScheduler: {},
  }
);

describe('ApiGateway.subscribe dedupe', () => {
  let gw: TestApiGateway;
  let state: any;
  let res: jest.Mock;

  // Each tick, load answers with the next (message, opts) pair
  const loadReturns = (...responses: Array<[any, any?]>) => {
    let i = 0;
    jest.spyOn(gw, 'load').mockImplementation(async ({ res: loadRes }: any) => {
      const [message, opts] = responses[i++];
      await loadRes(message, opts);
    });
  };

  const tick = () => gw.subscribe({
    query: {},
    context: {},
    res,
    subscribe: async (s) => {
      state = s;
    },
    subscriptionState: async () => state,
    queryType: 'regularQuery',
    apiType: 'ws',
  });

  beforeEach(() => {
    gw = createGateway();
    state = undefined;
    res = jest.fn();
  });

  it('sends the first result and stores only its hash', async () => {
    loadReturns([new ResultWrapper([{ a: 1 }])]);
    await tick();

    expect(res).toHaveBeenCalledTimes(1);
    expect(Object.keys(state)).toEqual(['resultHash']);
    expect(state.resultHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('hash equals sha1 of the previous comparison string', () => {
    const r = { message: new ResultWrapper([{ a: 1 }]), opts: undefined };
    expect(gw.subscriptionResultHash(r)).toEqual(
      crypto.createHash('sha1').update(JSON.stringify(r)).digest('hex')
    );
  });

  it('does not resend an unchanged result', async () => {
    loadReturns([new ResultWrapper([{ a: 1 }])], [new ResultWrapper([{ a: 1 }])]);
    await tick();
    await tick();

    expect(res).toHaveBeenCalledTimes(1);
  });

  it('resends when rows change', async () => {
    loadReturns([new ResultWrapper([{ a: 1 }])], [new ResultWrapper([{ a: 2 }])]);
    await tick();
    const firstHash = state.resultHash;
    await tick();

    expect(res).toHaveBeenCalledTimes(2);
    expect(state.resultHash).not.toEqual(firstHash);
  });

  it('resends when only opts.status changes', async () => {
    loadReturns(
      [new ResultWrapper([{ a: 1 }]), { status: 200 }],
      [new ResultWrapper([{ a: 1 }]), { status: 202 }],
    );
    await tick();
    await tick();

    expect(res).toHaveBeenCalledTimes(2);
  });

  it('always sends errors and does not store a hash for them', async () => {
    loadReturns([{ error: 'boom' }, { status: 400 }], [{ error: 'boom' }, { status: 400 }]);
    await tick();
    await tick();

    expect(res).toHaveBeenCalledTimes(2);
    expect(state.resultHash).toBeUndefined();
  });

  it('sends the first good result after an error, even if it equals the pre-error result', async () => {
    loadReturns(
      [new ResultWrapper([{ a: 1 }])],
      [{ error: 'boom' }, { status: 400 }],
      [new ResultWrapper([{ a: 1 }])],
    );
    await tick();
    await tick();
    await tick();

    expect(res).toHaveBeenCalledTimes(3);
  });
});
