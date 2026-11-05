/** 原始值的转换都在这里，模型提交的规则只说明“哪个字段是什么”，不处理单位 */

const COUNT = /^(\d+(?:\.\d+)?)\s*(万|w|W|千|k|K|亿)?\+?$/
const UNITS: Record<string, number> = { 万: 1e4, w: 1e4, W: 1e4, 千: 1e3, k: 1e3, K: 1e3, 亿: 1e8 }

/** 12、"12"、"1,234"、"1.2万"、"3w"、"10+" → 数字 */
export function toCount(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined
  if (typeof value !== 'string') return undefined
  const match = COUNT.exec(value.trim().replaceAll(',', ''))
  if (!match) return undefined
  const unit = match[2] ? UNITS[match[2]] ?? 1 : 1
  return Math.round(Number(match[1]) * unit)
}

export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  }
  return undefined
}

/** 1e11 秒约在公元 5138 年，1e11 毫秒约在 1973 年，以此区分秒和毫秒 */
const SECONDS_LIMIT = 1e11

/** 秒、毫秒（数字或数字字符串）、日期字符串 → ISO 8601 */
export function toIso(value: unknown): string | undefined {
  const number = typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : value
  if (typeof number === 'number') {
    if (!Number.isFinite(number) || number <= 0) return undefined
    return new Date(number < SECONDS_LIMIT ? number * 1000 : number).toISOString()
  }
  if (typeof number !== 'string' || number.trim() === '') return undefined
  const time = Date.parse(number)
  return Number.isNaN(time) ? undefined : new Date(time).toISOString()
}

/** "01:02:03" → 3723，"02:03" → 123 */
export function parseClock(value: string): number | undefined {
  const parts = value.trim().split(':')
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return undefined
  return parts.reduce((total, part) => total * 60 + Number(part), 0)
}

/** 视频内时间点：秒数，或 "01:23"、"00:01:23" */
export function toVideoSeconds(value: unknown): number | undefined {
  if (typeof value === 'string' && value.includes(':')) return parseClock(value)
  const number = toNumber(value)
  return number !== undefined && number >= 0 ? number : undefined
}

/** 字符串原样保留（不去空白），数字转成字符串，空字符串视为没有 */
export function toText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/** 有的平台导出“IP属地：广东”，统一成“广东”，按属地统计和筛选时才能对上 */
export function toLocation(value: unknown): string | undefined {
  return toText(value)?.replace(/^\s*IP\s*属地\s*[:：]/i, '').trim() || undefined
}

export function toId(value: unknown): string | undefined {
  const text = toText(value)
  return text === undefined ? undefined : text.trim()
}
