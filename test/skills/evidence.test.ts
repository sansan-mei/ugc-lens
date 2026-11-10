import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseInput, type InputFormat } from '../../src/ingest/formats.ts'

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../skills/cited-feedback-analysis/scripts/evidence.mjs')
const dir = mkdtempSync(join(tmpdir(), 'ugc-lens-evidence-'))
after(() => rmSync(dir, { recursive: true, force: true }))

interface Record { id: string; text: string; meta?: { [key: string]: unknown } }

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

function index(name: string, content: string, ...options: string[]): { summary: { records: number; out: string; [key: string]: unknown }; records: Record[] } {
  writeFileSync(join(dir, name), content)
  const out = `${name}.records.jsonl`
  const result = run('index', name, '--out', out, ...options)
  assert.equal(result.code, 0, result.stderr)
  const records = readFileSync(join(dir, out), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record)
  return { summary: JSON.parse(result.stdout), records }
}

function ugcLensIds(content: string, format: InputFormat): string[] {
  const parsed = parseInput(content, format)
  const rows = Array.isArray(parsed.data) ? parsed.data : (parsed.data as { rows: unknown[] }).rows
  return rows.map((row) => (row as { source_id: string }).source_id)
}

test('index：TXT 与 Markdown 的 ID 与 ugc-lens 导入器一致', () => {
  const txt = 'Shipping was slow\n\n  \nLove the new UI\r\nRefund took 3 weeks\n'
  const fromTxt = index('notes.txt', txt).records
  assert.deepEqual(fromTxt.map((r) => r.id), ugcLensIds(txt, 'txt'))
  assert.equal(fromTxt[1]!.text, 'Love the new UI')

  const md = '# Interview 1\nShe wanted exports.\n\n\nPricing is confusing\nfor teams.\n'
  const fromMd = index('interviews.md', md).records
  assert.deepEqual(fromMd.map((r) => r.id), ugcLensIds(md, 'markdown'))
  assert.equal(fromMd[1]!.text, 'Pricing is confusing\nfor teams.')
})

test('index：CSV 引号内换行使用记录起始行号，自动识别文本列并保留其他列', () => {
  const csv = 'ticket,rating,comment\nT1,2,"App crashes\non login"\nT2,5,"Fast, ""great"" support"\n'
  const { summary, records } = index('tickets.csv', csv)
  assert.deepEqual(records.map((r) => r.id), ugcLensIds(csv, 'csv'))
  assert.equal(summary.records, 2)
  assert.equal(summary.text_field, 'comment')
  assert.equal(records[0]!.text, 'App crashes\non login')
  assert.equal(records[1]!.text, 'Fast, "great" support')
  assert.deepEqual(records[1]!.meta, { ticket: 'T2', rating: '5' })
})

test('index：分号 CSV、TSV 和 --id-field', () => {
  const semi = index('survey.csv', 'id;answer\nr-1;Too expensive\nr-2;Works fine\n', '--id-field', 'id').records
  assert.deepEqual(semi.map((r) => [r.id, r.text]), [['r-1', 'Too expensive'], ['r-2', 'Works fine']])
  const tsv = index('reviews.tsv', 'review\tstars\nGood value\t4\n').records
  assert.deepEqual(tsv.map((r) => [r.id, r.text]), [['line_2', 'Good value']])
})

test('index：JSON 自动找到唯一的对象数组，支持点路径文本字段与 ID 字段', () => {
  const json = JSON.stringify({ meta: { source: 'x' }, replies: [
    { rpid: 101, content: { message: 'Subtitles are off by 2s' }, like: 9 },
    { rpid: 102, content: { message: '  ' } },
    { rpid: 103, content: { message: 'Great explanation' } },
  ] })
  const { summary, records } = index('comments.json', json, '--text-field', 'content.message', '--id-field', 'rpid')
  assert.deepEqual(records.map((r) => r.id), ['101', '103'])
  assert.equal(summary.skipped_empty, 1)
  assert.equal(records[0]!.meta?.like, 9)
})

test('index：JSON 字符串数组沿用 ugc-lens 的 line_N，对象数组无 ID 时用 item_N', () => {
  const strings = JSON.stringify(['a', 'b'])
  assert.deepEqual(index('strings.json', strings).records.map((r) => r.id), ugcLensIds(strings, 'json'))
  const objects = index('objects.json', JSON.stringify([{ text: 'x' }, { text: 'y' }])).records
  assert.deepEqual(objects.map((r) => r.id), ['item_1', 'item_2'])
})

test('index：JSONL 自动识别常见 ID 和文本字段，无 ID 时用行号', () => {
  const withId = index('a.jsonl', '{"id":"c1","body":"Too many ads"}\n\n{"id":"c2","body":"Clean design"}\n').records
  assert.deepEqual(withId.map((r) => [r.id, r.text]), [['c1', 'Too many ads'], ['c2', 'Clean design']])
  const noId = index('b.jsonl', '{"review":"Battery drains"}\n{"review":"Nice"}\n').records
  assert.deepEqual(noId.map((r) => r.id), ['line_1', 'line_2'])
})

test('index：找不到文本字段或 ID 重复时报错并说明原因', () => {
  writeFileSync(join(dir, 'bad.csv'), 'a,b\n1,2\n')
  const missing = run('index', 'bad.csv', '--out', 'bad.jsonl')
  assert.notEqual(missing.code, 0)
  assert.match(missing.stderr, /--text-field/)
  assert.match(missing.stderr, /a, b/)

  writeFileSync(join(dir, 'dup.jsonl'), '{"id":1,"text":"x"}\n{"id":1,"text":"y"}\n')
  const dup = run('index', 'dup.jsonl', '--out', 'dup.records.jsonl')
  assert.notEqual(dup.code, 0)
  assert.match(dup.stderr, /duplicate/i)
})

test('verify：引用存在且摘句逐字出现时通过，并报告覆盖数量', () => {
  index('v.txt', 'The refund took three weeks and nobody replied\nLove the dark mode\nRefund was instant for me\n')
  writeFileSync(join(dir, 'ok.md', ), [
    '## Refund delays',
    '- "refund took three weeks" [line_1]; counter-example: "Refund was instant" [line_3]',
    '- Mixed: [line_1, line_3] and a [docs link](https://example.com).',
    '- Ellipsis is allowed: "The refund … nobody replied" [line_1]',
    '- [x] checked task stays ignored',
  ].join('\n'))
  const result = run('verify', 'v.txt.records.jsonl', 'ok.md')
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const summary = JSON.parse(result.stdout)
  assert.equal(summary.ok, true)
  assert.equal(summary.records_total, 3)
  assert.equal(summary.cited_unique, 2)
  assert.equal(summary.quotes_checked, 3)
})

test('verify：不存在的 ID 和与原文不符的摘句都会失败', () => {
  writeFileSync(join(dir, 'bad.md'), [
    '- "refund took two weeks" [line_1]',
    '- "Love the dark mode" [line_9]',
    '- "Refund was instant" [line_2]',
  ].join('\n'))
  const result = run('verify', 'v.txt.records.jsonl', 'bad.md')
  assert.equal(result.code, 1)
  const summary = JSON.parse(result.stdout)
  assert.equal(summary.ok, false)
  assert.deepEqual(summary.unknown_ids.map((u: { id: string }) => u.id), ['line_9'])
  assert.deepEqual(summary.quote_mismatches.map((m: { ids: string[]; line: number }) => [m.ids, m.line]), [[['line_1'], 1], [['line_2'], 3]])
})

test('verify：相邻的 [a][b] 引用逐个核对', () => {
  writeFileSync(join(dir, 'adjacent.md'), '- Both sides [line_1][line_8]\n')
  const summary = JSON.parse(run('verify', 'v.txt.records.jsonl', 'adjacent.md').stdout)
  assert.equal(summary.citations, 2)
  assert.deepEqual(summary.unknown_ids.map((u: { id: string }) => u.id), ['line_8'])
})

test('index：多个数组时用 --items 选择，嵌套回复展开为带 parent_id 的记录', () => {
  const archive = JSON.stringify({
    video_info: { title: 't' },
    video_danmus: [{ content: '前方高能' }],
    video_comments: [
      { rpid: 1, content: '[doge]今年能更新第二次', like: 5, replyList: [{ rpid: 2, content: '为啥？', replyList: [{ rpid: 3, content: '每年一次', replyList: [] }] }] },
      { rpid: 4, content: '讲得清楚', replyList: [] },
    ],
  })
  writeFileSync(join(dir, 'archive.json'), archive)
  const ambiguous = run('index', 'archive.json', '--out', 'archive.records.jsonl')
  assert.notEqual(ambiguous.code, 0)
  assert.match(ambiguous.stderr, /--items/)
  assert.match(ambiguous.stderr, /video_comments/)

  const { summary, records } = index('archive.json', archive, '--items', 'video_comments')
  assert.deepEqual(records.map((r) => [r.id, r.meta?.parent_id]), [['1', undefined], ['2', '1'], ['3', '2'], ['4', undefined]])
  assert.equal(summary.records, 4)
  assert.deepEqual(summary.flattened_replies, { replyList: 2 })
  assert.equal(records[0]!.meta?.like, 5)
  assert.ok(records.every((r) => r.meta?.replyList === undefined), '展开后的回复不再重复留在 meta 里')
})

test('verify：摘句里的方括号表情不当作引用', () => {
  index('emote.txt', '[doge]今年能更新第二次真的小看你了\n')
  writeFileSync(join(dir, 'emote.md'), '- "[doge]今年能更新第二次" [line_1]\n- 「[滑稽]」不在原文里 [line_1]\n')
  const summary = JSON.parse(run('verify', 'emote.txt.records.jsonl', 'emote.md').stdout)
  assert.deepEqual(summary.unknown_ids, [])
  assert.equal(summary.citations, 2)
  assert.equal(summary.quote_mismatches.length, 0)
})

test('search：按正则统计匹配记录，--limit 只限制展示条数', () => {
  const result = run('search', 'v.txt.records.jsonl', 'refund', '--limit', '1')
  assert.equal(result.code, 0, result.stderr)
  const summary = JSON.parse(result.stdout)
  assert.equal(summary.matched, 2)
  assert.equal(summary.records_total, 3)
  assert.equal(summary.matches.length, 1)
  assert.equal(summary.matches[0].id, 'line_1')
})
