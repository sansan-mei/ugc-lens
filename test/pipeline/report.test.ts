import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { computeStats } from '../../src/dataset/stats.ts'
import type { Dataset } from '../../src/dataset/types.ts'
import { planChunks } from '../../src/pipeline/chunk.ts'
import type { Theme } from '../../src/pipeline/merge.ts'
import { renderReport, type ReportInput, type ReportRunInfo } from '../../src/pipeline/report.ts'
import { makeDataset, makeItem } from '../helpers/dataset.ts'

const LONG = '这个价格真的劝退，同样的配置别家便宜三百块，售后还要自己寄回去等两周，体验很差，下次不会再买了，大家慎重考虑一下吧，不然后悔都来不及，真心建议多比较，'.repeat(2)

const dataset = makeDataset([
  makeItem({ id: 'c1', text: '太贵了', likes: 5, author: { name: '甲', location: '浙江' } }),
  makeItem({ id: 'c2', text: '太贵了', likes: 1 }),
  makeItem({ id: 'c3', text: LONG, likes: 50, author: { name: '乙' } }),
  makeItem({ id: 'c4', text: '一般般', likes: 20 }),
  makeItem({ id: 'c5', text: '还可以', likes: 30 }),
  makeItem({ id: 'r1', kind: 'reply', parent_id: 'c1', text: '回复 @甲 :说得对，确实贵', likes: 9 }),
  makeItem({ id: 'd1', kind: 'danmaku', text: '前方高能', video_time_sec: 75 }),
])

const theme = (direction: string, title: string, ids: string[], extra: Partial<Theme> = {}): Theme => ({
  direction, title, support: ids.length * 3, refs: ids.map((id) => ({ id })), sources: [], children: [], ...extra,
})

const run = (partial: Partial<ReportRunInfo> = {}): ReportRunInfo => ({
  generated_at: new Date(2026, 10, 5, 12, 0, 0),
  duration_ms: 1234,
  calls: 3,
  usage: { input_tokens: 1000, output_tokens: 200, cached_input_tokens: 500 },
  model: 'fake-model',
  total_chunks: 2,
  incomplete_chunks: 0,
  ...partial,
})

function input(themes: Theme[], partial: Partial<ReportInput> = {}, data: Dataset = dataset): ReportInput {
  return {
    dataset: data,
    stats: computeStats(data),
    coverage: planChunks(data).coverage,
    keywords: [{ word: '价格', docs: 3, ids: [] }],
    themes,
    directions: ['主要观点', '吐槽点', '争议'],
    run: run(),
    ...partial,
  }
}

describe('renderReport', () => {
  const themes = [
    theme('主要观点', '整体评价一般', ['c4', 'c5', 'c3', 'c1']),
    theme('吐槽点', '价格偏高', ['c1', 'r1'], {
      children: [theme('吐槽点', '和别家比', ['c3']), theme('吐槽点', '复读', ['c2'])],
    }),
  ]
  const markdown = renderReport(input(themes))

  test('结构：标题、概况、关键词、各方向主题、运行信息；没有主题的方向不出现', () => {
    assert.match(markdown, /^# 《测试视频》分析报告\n/)
    const headings = markdown.split('\n').filter((l) => l.startsWith('## '))
    assert.deepEqual(headings, ['## 概况', '## 关键词', '## 主要观点', '## 吐槽点', '## 运行信息'])
    assert.match(markdown, /### 1\. 整体评价一般（约 12 条）/)
    assert.match(markdown, /- \*\*和别家比\*\*（约 3 条）/)
    assert.match(markdown, /价格（3）/)
    assert.ok(markdown.endsWith('\n') && !markdown.includes('\n\n\n'))
  })

  test('每个主题最多 3 条引用，按赞数排序；引用带作者、属地、赞和 ID', () => {
    const section = markdown.slice(markdown.indexOf('### 1. 整体评价一般'), markdown.indexOf('## 吐槽点'))
    const ids = [...section.matchAll(/`(\w+)`/g)].map((m) => m[1])
    assert.deepEqual(ids, ['c3', 'c5', 'c4'])
    assert.match(markdown, /> 太贵了（类似内容 2 条） —— 甲 · 浙江 · 赞 5 `c1`/)
  })

  test('引用去掉“回复 @某人 :”；长内容截断，有摘句时用摘句', () => {
    assert.match(markdown, /> 说得对，确实贵 —— 赞 9 `r1`/)
    assert.ok(!markdown.includes('回复 @'))
    const long = markdown.split('\n').find((l) => l.includes('`c3`'))!
    assert.ok(long.includes('…') && long.length < LONG.length)
    const quoted = renderReport(input([theme('主要观点', '贵', ['c3'], { refs: [{ id: 'c3', quote: '别家便宜三百块' }] })]))
    assert.match(quoted, /> ……别家便宜三百块…… —— 乙/)
  })

  test('只放正常结果：块全部完成时不提未完成；有未完成的块时只用一句话说明', () => {
    assert.ok(!markdown.includes('没有完成'))
    assert.match(markdown, /输入 1,000（缓存命中 500），输出 200/)
    const partial = renderReport(input(themes, { run: run({ incomplete_chunks: 1 }) }))
    assert.equal(partial.split('\n').filter((l) => l.includes('没有完成')).length, 1)
  })

  test('没有主题时说明没有找到；不存在的引用 ID 跳过', () => {
    assert.match(renderReport(input([])), /没有找到有足够内容支持的观点/)
    const missing = renderReport(input([theme('主要观点', '空引用', ['nope', 'c4'])]))
    assert.ok(!missing.includes('nope'))
    assert.match(missing, /`c4`/)
  })

  test('多个内容时标题写内容数；没有标题时用文件名', () => {
    const two = makeDataset(dataset.items, { contents: [{ id: 'a', platform: 'bilibili', title: 'A' }, { id: 'b', platform: 'bilibili', title: 'B' }] })
    assert.match(renderReport(input([], {}, two)), /^# 2 个内容的分析报告/)
    const none = makeDataset(dataset.items, { contents: [] })
    assert.match(renderReport(input([], {}, none)), /^# test\.json 分析报告/)
  })
})
