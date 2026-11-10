import 'dotenv/config'
import { Redis } from 'ioredis'

export const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:56379', {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
})

export async function checkRedis(): Promise<boolean> {
  if (redis.status === 'wait') await redis.connect()
  return await redis.ping() === 'PONG'
}
