import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { ImportError, MAX_FILE_BYTES } from './errors.ts'
import type { Mapping } from './mapping.ts'

export type InputFormat = 'json' | 'jsonl' | 'csv' | 'tsv' | 'txt' | 'markdown' | 'log'
export interface ParsedInput { data: unknown; format: InputFormat; builtin?: Mapping }
const TEXT_MAPPING: Mapping = { platform: 'unknown', collections: [{ kind: 'record', path: '$', fields: { text: 'text', id: 'source_id' } }] }

function textRecords(rows: Array<{ text: string; line: number }>, format: InputFormat): ParsedInput {
  const data = rows.filter((row) => row.text.trim()).map((row) => ({ source_id: `line_${row.line}`, text: row.text }))
  if (!data.length) throw new ImportError('empty_data', '文件中没有非空文本记录')
  return { data, format, builtin: TEXT_MAPPING }
}

export function parseJsonLines(text: string): ParsedInput {
  const rows: Array<{ value: unknown; line: number }> = []
  for (const [index, line] of text.split(/\r\n|\n|\r/).entries()) {
    if (!line.trim()) continue
    let value: unknown
    try { value = JSON.parse(line) } catch { throw new ImportError('not_jsonl', `JSONL 第 ${index + 1} 行不是有效 JSON`) }
    if (typeof value !== 'string' && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new ImportError('not_jsonl', `JSONL 第 ${index + 1} 行需要对象或字符串`)
    rows.push({ value, line: index + 1 })
  }
  if (!rows.length) throw new ImportError('empty_data', 'JSONL 中没有非空记录')
  if (rows.every((row) => typeof row.value === 'string')) return textRecords(rows.map((row) => ({ text: row.value as string, line: row.line })), 'jsonl')
  if (rows.some((row) => typeof row.value === 'string')) throw new ImportError('not_jsonl', 'JSONL 不支持混合对象和字符串，请统一记录结构')
  return { data: rows.map((row) => row.value), format: 'jsonl' }
}

interface DelimitedRow { cells: string[]; line: number }
/** 状态机保留引号内的换行和分隔符，不能按行或逗号直接 split。 */
export function parseDelimited(text: string, delimiter: string): DelimitedRow[] {
  const rows: DelimitedRow[] = []
  let cells: string[] = []
  let value = ''
  let quoted = false
  let closed = false
  let line = 1
  let start = 1
  const fail = (reason: string): never => { throw new ImportError('not_csv', `表格第 ${line} 行：${reason}`) }
  const finishRow = () => {
    if (cells.length || value.trim() || closed) rows.push({ cells: [...cells, value], line: start })
    cells = []; value = ''; closed = false
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { value += '"'; i++ } else { quoted = false; closed = true }
      } else {
        value += char
        if (char === '\n' || (char === '\r' && text[i + 1] !== '\n')) line++
      }
      continue
    }
    if (char === delimiter) { cells.push(value); value = ''; closed = false }
    else if (char === '\r' || char === '\n') {
      finishRow()
      if (char === '\r' && text[i + 1] === '\n') i++
      line++; start = line
    } else if (char === '"') {
      if (value || closed) fail('双引号必须位于字段开头')
      quoted = true
    } else {
      if (closed) fail('结束引号后只能是分隔符或换行')
      value += char
    }
  }
  if (quoted) fail(`从第 ${start} 行开始的引号未闭合`)
  finishRow()
  return rows
}

function csvDelimiter(text: string): string {
  const counts = new Map([[',', 0], [';', 0]])
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (char === '"') {
      if (quoted && text[i + 1] === '"') i++
      else quoted = !quoted
    } else if (!quoted) {
      if (char === '\n' || char === '\r') {
        if ([...counts.values()].some((n) => n > 0)) break
      } else if (counts.has(char)) counts.set(char, counts.get(char)! + 1)
    }
  }
  return counts.get(';')! > counts.get(',')! ? ';' : ','
}
export function parseTable(text: string, format: 'csv' | 'tsv'): ParsedInput {
  const rows = parseDelimited(text, format === 'tsv' ? '\t' : csvDelimiter(text))
  const headers = rows.shift()?.cells.map((cell) => cell.trim())
  if (!headers) throw new ImportError('empty_data', '表格为空')
  if (headers.some((h) => !h) || new Set(headers).size !== headers.length) throw new ImportError('not_csv', '表头不能为空或重复，请给每一列唯一名称')
  if (!rows.length) throw new ImportError('empty_data', '表格只有表头，没有数据记录')
  const keys = headers.map((_, i) => `column_${i + 1}`)
  const data = rows.map((row) => {
    if (row.cells.length !== headers.length) throw new ImportError('not_csv', `表格第 ${row.line} 行有 ${row.cells.length} 列，表头有 ${headers.length} 列`)
    return Object.fromEntries([['source_id', `line_${row.line}`], ...keys.map((key, i) => [key, row.cells[i]!])])
  })
  return { data: { columns: Object.fromEntries(keys.map((key, i) => [key, headers[i]!])), rows: data }, format }
}

export function parseInput(text: string, format: InputFormat): ParsedInput {
  if (!text.trim()) throw new ImportError('empty_data', '文件为空或只有空白字符')
  if (format === 'csv' || format === 'tsv') return parseTable(text, format)
  if (format === 'jsonl') return parseJsonLines(text)
  if (format === 'json') {
    let data: unknown
    try { data = JSON.parse(text) } catch { throw new ImportError('not_json', '文件不是有效的 JSON') }
    if (Array.isArray(data) && data.every((entry) => typeof entry === 'string')) return textRecords(data.map((entry, i) => ({ text: entry as string, line: i + 1 })), format)
    return { data, format }
  }
  const lines = text.split(/\r\n|\n|\r/)
  if (format !== 'markdown') return textRecords(lines.map((line, i) => ({ text: line, line: i + 1 })), format)
  const paragraphs: Array<{ text: string; line: number }> = []
  let start = 1
  let buffer: string[] = []
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) {
      if (buffer.length) paragraphs.push({ text: buffer.join('\n'), line: start })
      buffer = []
    } else { if (!buffer.length) start = i + 1; buffer.push(line) }
  }
  if (buffer.length) paragraphs.push({ text: buffer.join('\n'), line: start })
  return textRecords(paragraphs, format)
}

const EXTENSIONS: Record<string, InputFormat> = { '.json': 'json', '.jsonl': 'jsonl', '.ndjson': 'jsonl', '.csv': 'csv', '.tsv': 'tsv', '.txt': 'txt', '.md': 'markdown', '.markdown': 'markdown', '.log': 'log' }
export async function readInput(filePath: string, signal?: AbortSignal): Promise<ParsedInput> {
  signal?.throwIfAborted()
  let bytes: Buffer
  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw new ImportError('read_failed', `不是文件：${filePath}`)
    if (info.size > MAX_FILE_BYTES) throw new ImportError('too_large', `文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MB 上限：${filePath}`)
    bytes = await readFile(filePath, { signal })
  } catch (error) {
    if (error instanceof ImportError || signal?.aborted) throw error
    throw new ImportError('read_failed', `无法读取 ${filePath}：${(error as Error).message}`)
  }
  if (bytes.length > MAX_FILE_BYTES) throw new ImportError('too_large', `文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MB 上限：${filePath}`)
  let text: string
  try {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw new Error('binary')
  } catch { throw new ImportError('invalid_encoding', '文件不是有效文本；请使用 UTF-8 或带 BOM 的 UTF-16 文本文件') }
  signal?.throwIfAborted()
  // 无后缀和历史自定义后缀仍可作为 JSON 读入，避免破坏原有 API。
  const format = EXTENSIONS[extname(filePath).toLowerCase()]
  if (!format) {
    try { return parseInput(text, 'json') } catch { throw new ImportError('unsupported_format', '不支持此文件格式；可用 JSON、JSONL、CSV、TSV、TXT、Markdown 或 LOG') }
  }
  return parseInput(text, format)
}
