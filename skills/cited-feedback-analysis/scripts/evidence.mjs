#!/usr/bin/env node
// Evidence helper for the cited-feedback-analysis skill. Node.js 18+, no dependencies.
// Usage:
//   node evidence.mjs index  <file> [--out records.jsonl] [--items path] [--text-field path] [--id-field path]
//   node evidence.mjs search <records.jsonl> <regex> [--limit 20]
//   node evidence.mjs verify <records.jsonl> <report.md>
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const MAX_BYTES = 100 * 1024 * 1024
const TEXT_FIELDS = ['text', 'content', 'comment', 'body', 'message', 'review', 'feedback', 'answer', 'response', 'description', 'note', 'notes', '内容', '评论', '文本', '反馈', '回答', '评价', '留言']
const ID_FIELDS = ['id', '_id', 'uuid', 'source_id', 'comment_id', 'review_id', 'ticket_id', 'response_id', 'rpid', 'cid']
const SAFE_ID = /^[\w.:-]+$/
const QUOTE_PAIRS = { '"': '"', '“': '”', '「': '」', '『': '』' }

class UsageError extends Error {}

function fail(message) { throw new UsageError(message) }

function readText(file) {
  const size = statSync(file).size
  if (size > MAX_BYTES) fail(`${file} is larger than 100 MB; split it first`)
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
}

function getPath(value, path) {
  let current = value
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

function pickField(keys, preferred, explicit) {
  if (explicit) return explicit
  const lower = new Map(keys.map((key) => [key.toLowerCase(), key]))
  for (const name of preferred) if (lower.has(name)) return lower.get(name)
  return undefined
}

/** State machine keeps quoted newlines and delimiters inside one cell; the row keeps its starting line. */
function parseDelimited(text, delimiter) {
  const rows = []
  let cells = []
  let value = ''
  let quoted = false
  let closed = false
  let line = 1
  let start = 1
  const finishRow = () => {
    if (cells.length || value.trim() || closed) rows.push({ cells: [...cells, value], line: start })
    cells = []; value = ''; closed = false
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
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
      if (value || closed) fail(`line ${line}: a double quote must start the field`)
      quoted = true
    } else {
      if (closed) fail(`line ${line}: only a delimiter or newline may follow a closing quote`)
      value += char
    }
  }
  if (quoted) fail(`unclosed quote starting at line ${start}`)
  finishRow()
  return rows
}

function csvDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  return (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','
}

function textRows(lines) {
  return lines.filter((row) => row.text.trim()).map((row) => ({ id: `line_${row.line}`, text: row.text }))
}

function markdownRows(text) {
  const rows = []
  let buffer = []
  let start = 1
  for (const [i, line] of text.split(/\r\n|\n|\r/).entries()) {
    if (!line.trim()) {
      if (buffer.length) rows.push({ text: buffer.join('\n'), line: start })
      buffer = []
    } else { if (!buffer.length) start = i + 1; buffer.push(line) }
  }
  if (buffer.length) rows.push({ text: buffer.join('\n'), line: start })
  return textRows(rows)
}

function findArray(data, itemsPath) {
  if (itemsPath) {
    const items = getPath(data, itemsPath)
    if (!Array.isArray(items)) fail(`--items ${itemsPath} is not an array in this JSON`)
    return items
  }
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    const arrays = Object.entries(data).filter(([, value]) => Array.isArray(value) && value.length)
    if (arrays.length === 1) return arrays[0][1]
    if (arrays.length > 1) fail(`JSON has several arrays (${arrays.map(([key]) => key).join(', ')}); choose one with --items`)
  }
  fail('JSON must be an array of records or an object containing one array of records; choose a nested one with --items')
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Objects become records; nested arrays of records with the same text field (reply threads) are flattened with parent_id. */
function objectRows(items, options, fallbackId) {
  const objects = items.filter(isObject)
  if (objects.length !== items.length) fail('records must be all objects or all strings')
  const keys = [...new Set(objects.flatMap((item) => Object.keys(item)))]
  const textField = pickField(keys, TEXT_FIELDS, options['text-field'])
  if (!textField) fail(`cannot find the text field; pass --text-field (available: ${keys.join(', ')})`)
  const idField = pickField(keys, ID_FIELDS, options['id-field'])
  const top = (path) => path.split('.')[0]
  const isThread = (value) => Array.isArray(value) && value.some((child) => isObject(child) && getPath(child, textField) !== undefined)
  const threadKeys = new Set()
  const collect = (item) => {
    for (const [key, value] of Object.entries(item)) {
      if (isThread(value)) { threadKeys.add(key); value.filter(isObject).forEach(collect) }
    }
  }
  objects.forEach(collect)
  const rows = []
  const flattened = {}
  const visit = (item, fallback, parentId) => {
    const raw = idField ? getPath(item, idField) : undefined
    const id = raw === undefined || raw === null || raw === '' ? fallback : String(raw)
    if (!SAFE_ID.test(id)) fail(`id "${id}" contains spaces or brackets; pick another --id-field`)
    const value = getPath(item, textField)
    const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
    const threads = Object.entries(item).filter(([key, v]) => threadKeys.has(key) && Array.isArray(v))
    const meta = Object.fromEntries(Object.entries(item).filter(([key, v]) => key !== top(textField) && key !== (idField && top(idField)) && !(threadKeys.has(key) && Array.isArray(v))))
    if (parentId !== undefined) meta.parent_id = parentId
    rows.push({ id, text, meta })
    for (const [key, children] of threads) {
      children.filter(isObject).forEach((child, n) => {
        flattened[key] = (flattened[key] ?? 0) + 1
        visit(child, `${id}.r${n + 1}`, id)
      })
    }
  }
  objects.forEach((item, i) => visit(item, fallbackId(i), undefined))
  return { rows, textField, idField, flattened }
}

function tableRows(text, delimiter, options) {
  const rows = parseDelimited(text, delimiter)
  const header = rows.shift()?.cells.map((cell) => cell.trim())
  if (!header) fail('table is empty')
  if (header.some((h) => !h) || new Set(header).size !== header.length) fail('every header cell must be unique and non-empty')
  const items = rows.map((row) => {
    if (row.cells.length !== header.length) fail(`line ${row.line} has ${row.cells.length} cells, header has ${header.length}`)
    return { line: row.line, item: Object.fromEntries(header.map((key, i) => [key, row.cells[i]])) }
  })
  return objectRows(items.map((entry) => entry.item), options, (i) => `line_${items[i].line}`)
}

function parseFile(file, options) {
  const text = readText(file)
  if (!text.trim()) fail('file is empty')
  const ext = extname(file).toLowerCase()
  if (ext === '.txt' || ext === '.log') return { rows: textRows(text.split(/\r\n|\n|\r/).map((t, i) => ({ text: t, line: i + 1 }))) }
  if (ext === '.md' || ext === '.markdown') return { rows: markdownRows(text) }
  if (ext === '.csv') return tableRows(text, csvDelimiter(text), options)
  if (ext === '.tsv') return tableRows(text, '\t', options)
  if (ext === '.jsonl' || ext === '.ndjson') {
    const entries = []
    for (const [i, line] of text.split(/\r\n|\n|\r/).entries()) {
      if (!line.trim()) continue
      try { entries.push({ value: JSON.parse(line), line: i + 1 }) } catch { fail(`JSONL line ${i + 1} is not valid JSON`) }
    }
    if (entries.every((e) => typeof e.value === 'string')) return { rows: textRows(entries.map((e) => ({ text: e.value, line: e.line }))) }
    return objectRows(entries.map((e) => e.value), options, (i) => `line_${entries[i].line}`)
  }
  if (ext === '.json') {
    let data
    try { data = JSON.parse(text) } catch { fail('file is not valid JSON') }
    const items = findArray(data, options.items)
    if (items.every((item) => typeof item === 'string')) return { rows: textRows(items.map((t, i) => ({ text: t, line: i + 1 }))) }
    return objectRows(items, options, (i) => `item_${i + 1}`)
  }
  fail(`unsupported extension "${ext}"; use .txt .log .md .csv .tsv .json .jsonl .ndjson`)
}

function commandIndex(positionals, options) {
  const [file] = positionals
  if (!file) fail('usage: index <file> [--out records.jsonl] [--text-field path] [--id-field path]')
  const { rows, textField, idField, flattened } = parseFile(file, options)
  const kept = rows.filter((row) => row.text.trim())
  if (!kept.length) fail('no non-empty records found')
  const seen = new Set()
  for (const row of kept) {
    if (seen.has(row.id)) fail(`duplicate id "${row.id}"; pass a unique --id-field`)
    seen.add(row.id)
  }
  const out = resolve(options.out ?? `${basename(file)}.records.jsonl`)
  writeFileSync(out, kept.map((row) => JSON.stringify(row.meta && Object.keys(row.meta).length ? row : { id: row.id, text: row.text })).join('\n') + '\n')
  const chars = kept.reduce((sum, row) => sum + row.text.length, 0)
  const summary = { records: kept.length, skipped_empty: rows.length - kept.length, text_field: textField ?? null, id_field: idField ?? null, total_chars: chars, out }
  if (flattened && Object.keys(flattened).length) summary.flattened_replies = flattened
  return summary
}

function loadRecords(file) {
  const records = new Map()
  for (const line of readText(file).split('\n')) {
    if (!line.trim()) continue
    const record = JSON.parse(line)
    records.set(String(record.id), record)
  }
  return records
}

function commandSearch(positionals, options) {
  const [file, pattern] = positionals
  if (!file || !pattern) fail('usage: search <records.jsonl> <regex> [--limit 20]')
  const records = loadRecords(file)
  let regex
  try { regex = new RegExp(pattern, 'iu') } catch (error) { fail(`invalid regex: ${error.message}`) }
  const limit = Number(options.limit ?? 20)
  const matches = [...records.values()].filter((record) => regex.test(record.text))
  return {
    pattern, records_total: records.size, matched: matches.length,
    matches: matches.slice(0, limit).map((record) => ({ id: record.id, text: record.text.length > 300 ? `${record.text.slice(0, 300)}…` : record.text })),
  }
}

const normalize = (text) => text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()

/** Quotes may skip text with … or ...; each fragment must appear in order. */
function quoteMatches(quote, text) {
  const source = normalize(text)
  let from = 0
  for (const fragment of normalize(quote).split(/\s*(?:…|\.\.\.)\s*/).filter(Boolean)) {
    const at = source.indexOf(fragment, from)
    if (at < 0) return false
    from = at + fragment.length
  }
  return true
}

function quoteBefore(prefix) {
  const trimmed = prefix.trimEnd()
  const close = trimmed.at(-1)
  const open = Object.entries(QUOTE_PAIRS).find(([, c]) => c === close)?.[0]
  if (!open) return undefined
  const start = trimmed.lastIndexOf(open, trimmed.length - 2)
  if (start < 0) return undefined
  return trimmed.slice(start + 1, -1)
}

/** Character ranges covered by quotes, so emotes like [doge] inside a quote are not read as citations. */
function quoteSpans(line) {
  const spans = []
  for (let i = 0; i < line.length; i++) {
    const close = QUOTE_PAIRS[line[i]]
    if (!close) continue
    const end = line.indexOf(close, i + 1)
    if (end < 0) break
    spans.push([i, end])
    i = end
  }
  return spans
}

function commandVerify(positionals) {
  const [file, report] = positionals
  if (!file || !report) fail('usage: verify <records.jsonl> <report.md>')
  const records = loadRecords(file)
  const unknown = []
  const mismatches = []
  const cited = new Set()
  let citations = 0
  let quotesChecked = 0
  for (const [i, line] of readText(report).split(/\r\n|\n|\r/).entries()) {
    const spans = quoteSpans(line)
    for (const match of line.matchAll(/\[([^\[\]\n]+)\](?![(:])/g)) {
      if (spans.some(([from, to]) => match.index > from && match.index < to)) continue
      const ids = match[1].split(/\s*,\s*/)
      if (!ids.every((id) => SAFE_ID.test(id)) || (ids.length === 1 && /^[xX ]?$/.test(ids[0]))) continue
      if (/^web:\d+$/.test(ids[0])) continue
      citations++
      for (const id of ids) {
        if (records.has(id)) cited.add(id)
        else unknown.push({ id, line: i + 1 })
      }
      const quote = quoteBefore(line.slice(0, match.index))
      if (quote === undefined) continue
      quotesChecked++
      const known = ids.filter((id) => records.has(id))
      if (known.length && !known.some((id) => quoteMatches(quote, records.get(id).text))) mismatches.push({ ids, quote, line: i + 1 })
    }
  }
  return {
    ok: unknown.length === 0 && mismatches.length === 0 && citations > 0,
    records_total: records.size, citations, cited_unique: cited.size, quotes_checked: quotesChecked,
    unknown_ids: unknown, quote_mismatches: mismatches,
    ...(citations === 0 ? { note: 'no [id] citations found in the report' } : {}),
  }
}

const COMMANDS = { index: commandIndex, search: commandSearch, verify: commandVerify }

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { out: { type: 'string' }, items: { type: 'string' }, 'text-field': { type: 'string' }, 'id-field': { type: 'string' }, limit: { type: 'string' } },
  })
  const [command, ...rest] = positionals
  const handler = COMMANDS[command]
  if (!handler) fail('usage: evidence.mjs <index|search|verify> ... (see the header of this file)')
  const result = handler(rest, values)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (command === 'verify' && !result.ok) process.exitCode = 1
} catch (error) {
  process.stderr.write(`error: ${error instanceof UsageError ? error.message : error.stack ?? error}\n`)
  process.exitCode = 2
}
