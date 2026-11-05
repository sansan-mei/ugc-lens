import type { CollectionReport, ContentInfo, FeedbackItem, FeedbackKind, ImportReport } from '../dataset/types.ts'
import { toCount, toId, toIso, toLocation, toNumber, toText, toVideoSeconds } from './convert.ts'
import type { ChildRule, ItemFields, Mapping } from './mapping.ts'
import { FLATTEN, getField, isRecord, joinTokens, resolveTokens, startsWithTokens, tokenize } from './paths.ts'
import type { ArrayInfo } from './shape.ts'

export interface ApplyContext {
  file_path: string
  /** 结构摘要里的数组，用来提醒没有被规则使用的大数组 */
  arrays?: readonly ArrayInfo[]
  /** 缓存规则用在新文件上：可选字段缺失只警告 */
  lenient?: boolean
}

export interface ApplyResult {
  contents: ContentInfo[]
  items: FeedbackItem[]
  report: ImportReport
}

const MIN_TEXT_RATIO = 0.5
const UNMAPPED_ARRAY_MIN = 5
const MAX_RECURSION = 20

class HitCounter {
  elements = 0
  /** 路径上有值（哪怕是空字符串、null）的元素数 */
  readonly present = new Map<string, number>()
  /** 取到并能转换的元素数 */
  readonly hits = new Map<string, number>()

  /** 规则里写了才统计 */
  take<T>(field: string, path: string | undefined, get: (path: string) => unknown, convert: (raw: unknown) => T | undefined): T | undefined {
    if (path === undefined) return undefined
    const raw = get(path)
    const result = raw === undefined ? undefined : convert(raw)
    this.present.set(field, (this.present.get(field) ?? 0) + (raw === undefined ? 0 : 1))
    this.hits.set(field, (this.hits.get(field) ?? 0) + (result === undefined ? 0 : 1))
    return result
  }

  ratios(): Record<string, number> {
    return Object.fromEntries(
      [...this.hits].map(([field, hits]) => [field, this.elements ? Math.round((hits / this.elements) * 100) / 100 : 0]),
    )
  }
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

/** 缓存规则用在别的文件上时，这两个字段缺失仍然算错误：没有正文就没有数据，没有 ID 就无法引用 */
const ALWAYS_REQUIRED = new Set(['text', 'id'])

/**
 * inherited：沿用上一级的规则，这一级缺少的字段不算错误。
 * lenient：规则已在别的文件上验证过，这个文件缺少可选字段（如没有 AI 总结）只警告。
 */
function checkHits(
  label: string,
  counter: HitCounter,
  errors: string[],
  warnings: string[],
  options: { inherited?: boolean; lenient?: boolean } = {},
): void {
  if (counter.elements === 0) return
  for (const [field, ratio] of Object.entries(counter.ratios())) {
    // 路径完全不存在多半是写错了；路径存在但值为空（如 AI 总结为空字符串）是数据本身的情况
    if (counter.present.get(field) === 0) {
      if (options.inherited) warnings.push(`${label} 沿用上一级的字段 ${field}，这一级没有，已忽略`)
      else if (options.lenient && !ALWAYS_REQUIRED.has(field)) warnings.push(`${label} 的字段 ${field} 在这个文件里不存在`)
      else errors.push(`${label} 的字段 ${field} 路径在所有元素上都不存在，请修正或去掉`)
    }
    else if (ratio === 0) warnings.push(`${label} 的字段 ${field} 的值都为空或无法转换`)
    else if (ratio < 1) warnings.push(`${label} 的字段 ${field} 命中率 ${percent(ratio)}`)
  }
}

export function applyMapping(data: unknown, mapping: Mapping, ctx: ApplyContext): ApplyResult {
  const errors: string[] = []
  const warnings: string[] = []
  const platform = mapping.platform
  const contents: ContentInfo[] = []
  const contentById = new Map<string, ContentInfo>()
  const report: ImportReport = { contents: 0, items: 0, collections: [], errors, warnings, unmapped: [] }

  // ---------- 内容 ----------
  interface ContentEntry {
    info: ContentInfo
    element: unknown
  }
  const entries: ContentEntry[] = []
  /** 被规则用到的数组路径，用来找出没被使用的大数组 */
  const usedArrays = new Set<string>()
  const usedObjects = new Set<string>()
  /** 内容是数组时，写在 `内容路径[]` 下面的集合属于所在的内容 */
  let contentTokens: string[] | undefined

  const rule = mapping.content
  if (rule) {
    let tokens = tokenize(rule.path)
    let found = resolveTokens([data], tokens)
    if (found.length === 1 && Array.isArray(found[0])) {
      usedArrays.add(joinTokens(tokens))
      tokens = [...tokens, FLATTEN]
      found = found[0]
    }
    contentTokens = tokens
    const elements = found.filter(isRecord)
    if (elements.length === 0) errors.push(`content.path ${rule.path} 找不到对象`)

    let idPattern: RegExp | undefined
    if (rule.id_from_path !== undefined) {
      try {
        idPattern = new RegExp(rule.id_from_path)
      } catch (error) {
        errors.push(`content.id_from_path 不是有效的正则：${(error as Error).message}`)
      }
    }

    const counter = new HitCounter()
    const fields = rule.fields
    elements.forEach((element, index) => {
      counter.elements++
      const get = (path: string) => getField(element, data, path)
      const take = <T>(field: string, path: string | undefined, convert: (raw: unknown) => T | undefined) =>
        counter.take(field, path, get, convert)
      let id = take('id', fields.id, toId)
      if (id === undefined && idPattern) {
        const match = idPattern.exec(ctx.file_path)
        id = match ? (match[1] ?? match[0]) : undefined
        if (!match && index === 0) errors.push(`content.id_from_path ${rule.id_from_path} 没有匹配文件路径 ${ctx.file_path}`)
      }
      id ??= `content-${index + 1}`

      const stats: Record<string, number> = {}
      for (const [name, path] of Object.entries(rule.stats ?? {})) {
        const value = take(`stats.${name}`, path, toCount)
        if (value !== undefined) stats[name] = value
      }

      let transcript: ContentInfo['transcript']
      if (rule.transcript) {
        const spec = rule.transcript
        const lines = take('transcript', spec.path, (raw) => {
          if (!Array.isArray(raw)) return undefined
          return raw.flatMap((line) => {
            const start = toNumber(getField(line, data, spec.start))
            const end = toNumber(getField(line, data, spec.end))
            const text = toText(getField(line, data, spec.text))
            return start !== undefined && end !== undefined && text !== undefined ? [{ start_sec: start, end_sec: end, text }] : []
          })
        })
        transcript = lines?.length ? lines : undefined
      }

      const url = take('url', fields.url, toText) ?? rule.url_template?.replaceAll('{id}', id)
      const info: ContentInfo = {
        id,
        platform,
        title: take('title', fields.title, toText),
        url,
        author: take('author', fields.author, toText),
        description: take('description', fields.description, toText),
        published_at: take('published_at', fields.published_at, toIso),
        stats: Object.keys(stats).length ? stats : undefined,
        summary: take('summary', fields.summary, toText),
        transcript,
      }
      if (contentById.has(id)) errors.push(`内容 ID 重复：${id}`)
      contentById.set(id, info)
      contents.push(info)
      entries.push({ info, element })
    })
    report.content = { path: rule.path, elements: counter.elements, field_hits: counter.ratios() }
    // 内容对象和内容字段所在的对象（如 $.video_ai_summary）里的数组是内容的一部分，不是遗漏的互动内容
    const objectPaths = [contentTokens, ...Object.values(fields), ...Object.values(rule.stats ?? {})]
      .map((value) => (typeof value === 'string' ? (value.startsWith('$') ? tokenize(value).slice(0, -1) : undefined) : value))
      .filter((tokens): tokens is string[] => tokens !== undefined && tokens.length > 0 && tokens.at(-1) !== FLATTEN)
    for (const tokens of objectPaths) usedObjects.add(joinTokens(tokens))
    if (fields.id === undefined && rule.id_from_path === undefined) {
      errors.push('content 没有 ID 来源：请写 fields.id；文件里没有 ID 时用 id_from_path 从文件路径中取（如路径里的视频号，或所在目录名）')
    }
    checkHits('content', counter, errors, warnings, { lenient: ctx.lenient })
  }

  // ---------- 互动内容 ----------
  const items: FeedbackItem[] = []
  const unassigned: FeedbackItem[] = []
  const sequence = new Map<FeedbackKind, number>()
  const usedPaths = usedArrays
  if (rule?.transcript) {
    const path = rule.transcript.path
    usedPaths.add(path.startsWith('$') ? path : joinTokens([...(contentTokens ?? []), ...tokenize(path)]))
  }

  const byId = new Map<string, FeedbackItem>()
  let duplicatesDropped = 0
  const reports = new Map<string, { report: CollectionReport; counter: HitCounter; inherited: boolean }>()
  const reportFor = (path: string, kind: FeedbackKind, inherited = false) => {
    let entry = reports.get(path)
    if (!entry) {
      entry = {
        report: { path, kind, elements: 0, imported: 0, skipped: 0, field_hits: {} },
        counter: new HitCounter(),
        inherited,
      }
      reports.set(path, entry)
      usedPaths.add(path)
    }
    return entry
  }

  const visit = (
    element: unknown,
    kind: FeedbackKind,
    fields: ItemFields,
    children: readonly ChildRule[],
    label: string,
    parentId: string | undefined,
    owner: ContentInfo | undefined,
    depth: number,
    inherited: boolean,
  ): void => {
    const { report: collectionReport, counter } = reportFor(label, kind, inherited)
    collectionReport.elements++
    counter.elements++
    const get = (path: string) => getField(element, data, path)
    const take = <T>(field: string, path: string | undefined, convert: (raw: unknown) => T | undefined) =>
      counter.take(field, path, get, convert)

    const text = take('text', fields.text, toText)
    const rawId = take('id', fields.id, toId)
    const fieldParent =
      parentId === undefined
        ? take('parent_id', fields.parent_id, (raw) => {
            // 一级评论的 parent 常写成 0 或空值，字段存在就算命中，用空字符串表示“没有上一级”
            const value = toId(raw)
            return value === undefined || value === '0' ? '' : value
          })
        : undefined
    const contentId = owner ? undefined : take('content_id', fields.content_id, toId)
    const location = take('author_location', fields.author_location, toLocation)
    const author = {
      id: take('author_id', fields.author_id, toId),
      name: take('author_name', fields.author_name, toText),
      gender: take('author_gender', fields.author_gender, toText),
      location,
    }
    const likes = take('likes', fields.likes, toCount)
    const replyCount = take('reply_count', fields.reply_count, toCount)
    const createdAt = take('created_at', fields.created_at, toIso)
    const videoTime = take('video_time', fields.video_time, toVideoSeconds)
    const mode = take('danmaku_mode', fields.danmaku_mode, toText)

    if (text === undefined) {
      collectionReport.skipped++
      return
    }

    const parent = parentId ?? (fieldParent || undefined)
    const finalKind: FeedbackKind = kind === 'comment' && parentId === undefined && parent !== undefined ? 'reply' : kind
    let id = rawId
    if (id === undefined) {
      const next = (sequence.get(finalKind) ?? 0) + 1
      sequence.set(finalKind, next)
      id = `${finalKind}-${next}`
    }

    const hasAuthor = Object.values(author).some((value) => value !== undefined)
    const item: FeedbackItem = {
      id,
      platform,
      kind: finalKind,
      content_id: owner?.id ?? contentId ?? '',
      parent_id: parent,
      text,
      author: hasAuthor ? author : undefined,
      likes,
      reply_count: replyCount,
      created_at: createdAt,
      video_time_sec: videoTime,
      danmaku_mode: mode,
    }
    const existing = byId.get(id)
    // 同一条内容被搜集了两次（MediaCrawler 的文件里常见），去掉重复的；正文不同则留下，最后报 ID 重复
    if (existing && existing.text === item.text && existing.content_id === item.content_id) {
      duplicatesDropped++
      return
    }
    if (!existing) byId.set(id, item)
    collectionReport.imported++
    items.push(item)
    if (!item.content_id) unassigned.push(item)

    if (depth >= MAX_RECURSION) return
    for (const childRule of children) {
      const childElements = getField(element, data, childRule.path)
      if (!Array.isArray(childElements)) continue
      const childFields: ItemFields = childRule.fields ?? fields
      const childInherited = childRule.fields === undefined
      const grandchildren: ChildRule[] = [...(childRule.recursive ? [childRule] : []), ...(childRule.children ?? [])]
      // 递归的更深层与第一层共用一个统计项
      const sameLevel = childRule.recursive && label.endsWith(`[].${childRule.path}`)
      const childLabel = sameLevel ? label : `${label}[].${childRule.path}`
      for (const childElement of childElements) {
        visit(childElement, childRule.kind, childFields, grandchildren, childLabel, id, owner, depth + 1, childInherited)
      }
    }
  }

  for (const collection of mapping.collections) {
    const tokens = tokenize(collection.path)
    const label = joinTokens(tokens)
    reportFor(label, collection.kind)

    const groups: Array<{ arrays: unknown[]; owner?: ContentInfo }> = []
    if (contentTokens && contentTokens.at(-1) === FLATTEN && startsWithTokens(tokens, contentTokens) && tokens.length > contentTokens.length) {
      const rest = tokens.slice(contentTokens.length)
      for (const entry of entries) groups.push({ arrays: resolveTokens([entry.element], rest), owner: entry.info })
    } else {
      groups.push({ arrays: resolveTokens([data], tokens) })
    }

    const arrays = groups.flatMap((group) => group.arrays.filter(Array.isArray))
    if (arrays.length === 0) {
      const reachedElements = groups.some((group) => group.arrays.length > 0)
      errors.push(
        reachedElements && collection.path.endsWith('[]')
          ? `集合 ${collection.path} 指向的是数组元素，不是数组本身，请去掉末尾的 []`
          : `集合 ${collection.path} 不是数组，或者路径不存在`,
      )
      continue
    }
    for (const group of groups) {
      for (const array of group.arrays) {
        if (!Array.isArray(array)) continue
        for (const element of array) {
          visit(element, collection.kind, collection.fields, collection.children ?? [], label, undefined, group.owner, 0, false)
        }
      }
    }
  }

  // ---------- 归属与检查 ----------
  if (unassigned.length > 0) {
    if (contents.length === 1) {
      for (const item of unassigned) item.content_id = contents[0]!.id
    } else if (contents.length === 0) {
      const placeholder: ContentInfo = { id: 'content-1', platform }
      contents.push(placeholder)
      contentById.set(placeholder.id, placeholder)
      for (const item of unassigned) item.content_id = placeholder.id
    } else {
      errors.push(
        `有 ${contents.length} 个内容，但 ${unassigned.length} 条互动内容无法确定属于哪一个：请写 fields.content_id，或把集合路径写在内容数组下面（如 ${joinTokens(contentTokens ?? [])}.comments）`,
      )
    }
  }
  for (const item of items) {
    if (item.content_id && !contentById.has(item.content_id)) {
      const info: ContentInfo = { id: item.content_id, platform }
      contentById.set(info.id, info)
      contents.push(info)
    }
  }

  for (const { report: collectionReport, counter, inherited } of reports.values()) {
    collectionReport.field_hits = counter.ratios()
    report.collections.push(collectionReport)
    const label = `集合 ${collectionReport.path}`
    if (collectionReport.elements === 0) continue
    const textRatio = collectionReport.field_hits.text ?? 0
    if (collectionReport.imported === 0) errors.push(`${label} 一条都没有导入，请检查 text 字段`)
    else if (textRatio < MIN_TEXT_RATIO) errors.push(`${label} 只有 ${percent(textRatio)} 的元素取到了 text，请检查路径`)
    checkHits(label, counter, errors, warnings, { inherited, lenient: ctx.lenient })
  }
  if (duplicatesDropped > 0) warnings.push(`去掉了 ${duplicatesDropped} 条重复的条目（ID、正文、所属内容都相同）`)

  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1)
  const duplicates = [...counts].filter(([, count]) => count > 1)
  if (duplicates.length > 0) {
    errors.push(
      `有 ${duplicates.length} 个条目 ID 重复（如 ${duplicates.slice(0, 3).map(([id]) => id).join('、')}）：请换一个唯一的 id 字段，或去掉 id 让程序生成`,
    )
  }

  const missingParents = items.filter((item) => item.parent_id !== undefined && !counts.has(item.parent_id)).length
  if (missingParents > 0) warnings.push(`${missingParents} 条回复的上一级不在文件里`)

  if (items.length === 0 && errors.length === 0) errors.push('没有导入任何条目')

  for (const array of ctx.arrays ?? []) {
    if (!array.objects || array.total < UNMAPPED_ARRAY_MIN) continue
    const covered =
      [...usedPaths].some((path) => array.path === path || array.path.startsWith(`${path}[]`)) ||
      [...usedObjects].some((path) => array.path.startsWith(`${path}.`))
    if (covered) continue
    report.unmapped.push(array.path)
    warnings.push(`数组 ${array.path}（至少 ${array.total} 个元素）没有被任何规则使用，是否漏掉了一类互动内容？`)
  }

  report.contents = contents.length
  report.items = items.length
  return { contents, items, report }
}

/** 写给模型和用户看的试转换报告 */
export function formatReport(report: ImportReport): string {
  const hits = (fieldHits: Record<string, number>) =>
    Object.entries(fieldHits)
      .map(([field, ratio]) => `${field} ${percent(ratio)}`)
      .join('、') || '无'
  const lines = [`共 ${report.contents} 个内容、${report.items} 条互动内容。`]
  if (report.content) lines.push(`内容 ${report.content.path}：${report.content.elements} 个；字段命中：${hits(report.content.field_hits)}`)
  for (const item of report.collections) {
    lines.push(
      `集合 ${item.path}（${item.kind}）：元素 ${item.elements}，导入 ${item.imported}，跳过 ${item.skipped}；字段命中：${hits(item.field_hits)}`,
    )
  }
  if (report.errors.length) lines.push('错误：', ...report.errors.map((line) => `- ${line}`))
  if (report.warnings.length) lines.push('警告：', ...report.warnings.map((line) => `- ${line}`))
  return lines.join('\n')
}
