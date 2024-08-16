import * as redis from 'redis';
import { ClientOpts, RedisClient } from 'redis';
import { getEnv } from '@cubejs-backend/shared';
import { promisify } from 'util';
import AsyncRedisClient from './AsyncRedisClient';

export type RedisOptions = ClientOpts;

function decorateRedisClient(client: RedisClient): AsyncRedisClient {
  [
    'brpop',
    'del',
    'get',
    'hget',
    'rpop',
    'set',
    'zadd',
    'zrange',
    'zrangebyscore',
    'keys',
    'watch',
    'unwatch',
    'incr',
    'decr',
    'lpush',
  ].forEach(
    k => {
      client[`${k}Async`] = promisify(client[k]);
    }
  );

  return <AsyncRedisClient>client;
}

// redis.Multi.prototype.execAsync = function execAsync() {
//   return new Promise((resolve, reject) => this.exec((err, res) => (
//     err ? reject(err) : resolve(res)
//   )));
// };

export async function createRedisClient(url: string) {
  const options: RedisOptions = {
    url
  };

  if (getEnv('redisTls')) {
    options.tls = {};
  }

  if (getEnv('redisPassword')) {
    options.password = getEnv('redisPassword');
  }

  return redis.createClient(options);
}
