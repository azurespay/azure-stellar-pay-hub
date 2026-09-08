import { Injectable } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type Redis from 'ioredis';

interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Redis-backed storage for @nestjs/throttler.
 *
 * Replicates the semantics of the built-in in-memory `ThrottlerStorageService`
 * (sliding increments with block duration after the limit is exceeded) inside
 * a single atomic Lua script, so rate-limit state is shared across every API
 * instance instead of being per-process. Keys expire so the table cannot grow
 * unboundedly.
 *
 * Field layout per key (`throttle:{throttlerName}:{key}`):
 *   hits, expiresAt (ms), blockExpiresAt (ms), blocked (0|1)
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly script = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local blockMs = tonumber(ARGV[4])

local hits = tonumber(redis.call('HGET', key, 'hits') or '0')
local expiresAt = tonumber(redis.call('HGET', key, 'expiresAt') or '0')
local blockExpiresAt = tonumber(redis.call('HGET', key, 'blockExpiresAt') or '0')
local blocked = tonumber(redis.call('HGET', key, 'blocked') or '0')

if not redis.call('EXISTS', key) then
  expiresAt = now + ttlMs
  blockExpiresAt = 0
  blocked = 0
end

local timeToExpire = expiresAt - now
if timeToExpire <= 0 then
  expiresAt = now + ttlMs
  timeToExpire = ttlMs
end

if blocked == 0 then
  hits = hits + 1
end

if hits > limit and blocked == 0 then
  blocked = 1
  blockExpiresAt = now + blockMs
end

local timeToBlockExpire = blockExpiresAt - now
if timeToBlockExpire <= 0 and blocked == 1 then
  blocked = 0
  hits = 1
  expiresAt = now + ttlMs
  timeToExpire = ttlMs
  timeToBlockExpire = 0
end

redis.call('HSET', key, 'hits', tostring(hits), 'expiresAt', tostring(expiresAt),
  'blockExpiresAt', tostring(blockExpiresAt), 'blocked', tostring(blocked))
local pttl = redis.call('PTTL', key)
if pttl < 0 then
  redis.call('PEXPIRE', key, ttlMs)
end

return { hits, timeToExpire, blocked, timeToBlockExpire }
`;

  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const result = (await this.redis.eval(
      this.script,
      1,
      `throttle:${throttlerName}:${key}`,
      Date.now(),
      ttl,
      limit,
      blockDuration,
    )) as unknown[];

    return {
      totalHits: Number(result[0]),
      timeToExpire: Number(result[1]),
      isBlocked: Number(result[2]) === 1,
      timeToBlockExpire: Number(result[3]),
    };
  }
}
