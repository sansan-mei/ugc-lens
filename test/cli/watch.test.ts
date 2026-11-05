import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { formatWatchEvent, parseWatchArgs } from '../../src/cli/watch.ts'
import { DEFAULT_PATTERNS } from '../../src/watch/pattern.ts'

test('parseWatchArgs：默认值', () => {
  assert.deepEqual(parseWatchArgs(['./data']), {
    dir: './data',
    patterns: DEFAULT_PATTERNS,
    existing: false,
    retryFailed: false,
    scanIntervalMs: 30_000,
    settleMs: 2_000,
    maxTotalChars: undefined,
    directions: undefined,
  })
})

test('parseWatchArgs：各个选项', () => {
  const args = parseWatchArgs(['d', '--pattern', 'a.json,b_*.json', '--existing', '--retry-failed', '--interval', '5', '--settle', '0.5', '--chars', '20000', '--focus', '价格，售后'])
  assert.deepEqual(args.patterns, ['a.json', 'b_*.json'])
  assert.equal(args.existing, true)
  assert.equal(args.retryFailed, true)
  assert.equal(args.scanIntervalMs, 5000)
  assert.equal(args.settleMs, 500)
  assert.equal(args.maxTotalChars, 20000)
  assert.deepEqual(args.directions, ['价格', '售后'])
})

test('parseWatchArgs：缺目录、多个目录、数字不对、未知选项都报错', () => {
  assert.throws(() => parseWatchArgs([]), /目录/)
  assert.throws(() => parseWatchArgs(['a', 'b']), /目录/)
  assert.throws(() => parseWatchArgs(['a', '--interval', '0']), /--interval/)
  assert.throws(() => parseWatchArgs(['a', '--chars', 'abc']), /--chars/)
  assert.throws(() => parseWatchArgs(['a', '--unknown']))
})

test('formatWatchEvent：路径相对监听目录显示，完成时带报告路径和 token', () => {
  const dir = '/data'
  const file = join(dir, 'v1', 'bilibili_all.json')
  assert.equal(formatWatchEvent({ type: 'queued', file, reason: 'resume' }, dir), '+ 排队（上次没做完）：v1/bilibili_all.json')
  const done = formatWatchEvent(
    { type: 'done', file, task: { file, status: 'done', added_at: '', report: '/r.md', calls: 3, usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 0 } } },
    dir,
  )
  assert.match(done, /✓ 完成：v1\/bilibili_all\.json，调用 3 次，输入 100、输出 20 token\n  报告：\/r\.md/)
  const watching = formatWatchEvent({ type: 'watching', dir, patterns: ['*_all.json'], ignored: 2, resumed: 1 }, dir)
  assert.match(watching, /继续上次的 1 个任务/)
  assert.match(watching, /已有的 2 个文件不分析/)
  assert.equal(formatWatchEvent({ type: 'stopped' }, dir), '已停止监听。')
  assert.match(formatWatchEvent({ type: 'stopped', interrupted: file }, dir), /v1\/bilibili_all\.json 没有分析完，下次启动时继续/)
})
