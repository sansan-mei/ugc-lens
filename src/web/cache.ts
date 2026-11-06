import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface CacheEntry<T> { value: T; fetched_at: string }

export interface WebCache {
  get<T>(key: string): Promise<CacheEntry<T> | undefined>
  set<T>(key: string, value: T, fetchedAt: Date): Promise<void>
}

/** 按键的摘要存成单个 JSON 文件；读取失败或过期都按未命中处理 */
export function createWebCache(dir: string, ttlMs: number, now: () => Date = () => new Date()): WebCache {
  const file = (key: string) => join(dir, `${createHash('sha256').update(key).digest('hex')}.json`)
  return {
    async get<T>(key: string) {
      try {
        const entry = JSON.parse(await readFile(file(key), 'utf8')) as { key?: unknown; expires_at?: unknown; fetched_at?: unknown; value?: T }
        if (entry.key !== key || typeof entry.expires_at !== 'string' || typeof entry.fetched_at !== 'string') return undefined
        if (Date.parse(entry.expires_at) <= now().getTime()) return undefined
        return { value: entry.value as T, fetched_at: entry.fetched_at }
      } catch { return undefined }
    },
    async set<T>(key: string, value: T, fetchedAt: Date) {
      await mkdir(dir, { recursive: true })
      const target = file(key)
      const temp = `${target}.${randomUUID()}.tmp`
      const expires = new Date(fetchedAt.getTime() + ttlMs)
      await writeFile(temp, JSON.stringify({ key, fetched_at: fetchedAt.toISOString(), expires_at: expires.toISOString(), value }), { mode: 0o600 })
      await rename(temp, target)
    },
  }
}
