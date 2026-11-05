import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as z from 'zod'
import { mappingSchema } from './mapping.ts'

const outcomeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mapping'), mapping: mappingSchema }),
  z.object({ type: z.literal('rejected'), reason: z.string() }),
])

const ruleSchema = z.object({
  created_at: z.string(),
  /** 生成这条规则时的文件名，方便人查看 */
  file_name: z.string(),
  outcome: outcomeSchema,
})

/** 同一个指纹可以有多条规则：结构相同，但有的文件路径里有 BV 号、有的没有 */
const entrySchema = z.object({
  version: z.literal(2),
  fingerprint: z.string(),
  rules: z.array(ruleSchema),
})

export type CacheRule = z.output<typeof ruleSchema>
export type CacheEntry = z.output<typeof entrySchema>

function entryPath(dir: string, fingerprint: string): string {
  return join(dir, `${fingerprint}.json`)
}

async function readEntryFile(path: string, fingerprint?: string): Promise<CacheEntry | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = entrySchema.safeParse(JSON.parse(text))
    if (!parsed.success) return undefined
    return fingerprint === undefined || parsed.data.fingerprint === fingerprint ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** 文件不存在或内容不合格时返回 undefined，重新推断即可，不报错 */
export async function readCache(dir: string, fingerprint: string): Promise<CacheEntry | undefined> {
  return readEntryFile(entryPath(dir, fingerprint), fingerprint)
}

/** 缓存目录里的全部条目，跳过无法读取的文件 */
export async function listCache(dir: string): Promise<CacheEntry[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const entries = await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => readEntryFile(join(dir, name))))
  return entries.filter((entry): entry is CacheEntry => entry !== undefined)
}

/** 追加一条规则；内容完全相同的规则不重复保存 */
export async function addCacheRule(dir: string, fingerprint: string, rule: CacheRule): Promise<void> {
  const entry = (await readCache(dir, fingerprint)) ?? { version: 2, fingerprint, rules: [] }
  const key = JSON.stringify(rule.outcome)
  if (!entry.rules.some((existing) => JSON.stringify(existing.outcome) === key)) entry.rules.push(rule)

  await mkdir(dir, { recursive: true })
  const target = entryPath(dir, fingerprint)
  // 先写临时文件再改名，避免读到写了一半的文件
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`)
  await rename(temporary, target)
}
