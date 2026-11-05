import { createHash } from 'node:crypto'

export interface ArrayInfo {
  path: string
  /** 抽样到的父元素里该数组长度之和，嵌套数组是下限 */
  total: number
  /** 元素是对象。字符串、数字数组（如链接列表）不可能是互动内容集合 */
  objects: boolean
}

export interface Shape {
  /** 发给模型的结构摘要，一行一个路径 */
  text: string
  /** 路径和类型的指纹，不含示例值和数组长度 */
  fingerprint: string
  arrays: ArrayInfo[]
}

export interface ShapeOptions {
  sampleSize?: number
  maxLines?: number
  maxExampleChars?: number
}

interface PathStats {
  types: Set<string>
  example?: string
  minLength?: number
  maxLength?: number
  total: number
}

const MAX_DEPTH = 20
const MAX_KEYS = 200

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** 均匀抽样，保留首尾 */
function sampleIndexes(length: number, size: number): number[] {
  if (length <= size) return Array.from({ length }, (_, index) => index)
  return Array.from({ length: size }, (_, index) => Math.round((index * (length - 1)) / (size - 1)))
}

export function describeShape(data: unknown, options: ShapeOptions = {}): Shape {
  const sampleSize = options.sampleSize ?? 50
  const maxLines = options.maxLines ?? 300
  const maxExample = options.maxExampleChars ?? 40
  const paths = new Map<string, PathStats>()

  const visit = (value: unknown, path: string, depth: number): void => {
    let stats = paths.get(path)
    if (!stats) {
      stats = { types: new Set(), total: 0 }
      paths.set(path, stats)
    }
    const type = typeOf(value)
    stats.types.add(type)

    if (Array.isArray(value)) {
      stats.minLength = Math.min(stats.minLength ?? Infinity, value.length)
      stats.maxLength = Math.max(stats.maxLength ?? 0, value.length)
      stats.total += value.length
      if (depth < MAX_DEPTH) for (const index of sampleIndexes(value.length, sampleSize)) visit(value[index], `${path}[]`, depth + 1)
      return
    }
    if (type === 'object') {
      if (depth >= MAX_DEPTH) return
      for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
        visit(child, `${path}.${key}`, depth + 1)
      }
      return
    }
    if (stats.example === undefined && (type === 'number' || type === 'boolean' || (type === 'string' && value !== ''))) {
      const text = String(value)
      stats.example = JSON.stringify(text.length > maxExample ? `${text.slice(0, maxExample)}…` : text)
      if (type !== 'string') stats.example = text
    }
  }

  visit(data, '$', 0)

  const lines: string[] = []
  for (const [path, stats] of paths) {
    let line = `${path}  ${[...stats.types].join('|')}`
    if (stats.maxLength !== undefined) {
      line += stats.minLength === stats.maxLength ? `  长度 ${stats.maxLength}` : `  长度 ${stats.minLength}~${stats.maxLength}`
    }
    if (stats.example !== undefined) line += `  例：${stats.example}`
    lines.push(line)
  }
  const shown = lines.slice(0, maxLines)
  if (lines.length > maxLines) shown.push(`……另有 ${lines.length - maxLines} 个路径未列出`)

  const signature = [...paths]
    .map(([path, stats]) => `${path}:${[...stats.types].sort().join('|')}`)
    .sort()
    .join('\n')

  return {
    text: shown.join('\n'),
    fingerprint: createHash('sha256').update(signature).digest('hex').slice(0, 16),
    arrays: [...paths]
      .filter(([, stats]) => stats.maxLength !== undefined)
      .map(([path, stats]) => ({ path, total: stats.total, objects: paths.get(`${path}[]`)?.types.has('object') ?? false })),
  }
}
