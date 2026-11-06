import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { computeStats } from '../../src/dataset/stats.ts'
import type { Dataset } from '../../src/dataset/types.ts'
import { planChunks } from '../../src/pipeline/chunk.ts'
import type { Theme } from '../../src/pipeline/merge.ts'
import { renderReport, type ReportInput, type ReportRunInfo } from '../../src/pipeline/report.ts'
import { analysisCoverage } from '../../src/analysis/coverage.ts'
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

test('报告以表格展示真实处理覆盖和字幕对齐，缺失字幕不猜内容', () => {
  const data = makeDataset([makeItem({ id: 'd', kind: 'danmaku', text: '反应', video_time_sec: 10 })], {
    contents: [{ id: 'BV1', platform: 'bilibili', transcript: [{ start_sec: 9, end_sec: 12, text: '实际字幕' }] }],
  })
  const result = renderReport(input([], { ledger: analysisCoverage(data) }, data))
  assert.match(result, /\| 类型 \| 导入 \|/)
  assert.match(result, /\| 内容 \| 视频秒数 \|/)
  assert.match(result, /实际字幕/)
  assert.match(result, /BV1:transcript:1/)
  assert.match(result, /不是|不代表/)
  assert.match(result, /\[d\]/)
})

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
    assert.deepEqual(headings, ['## 核心结论', '## 字幕与观众反应时间轴', '## 附录：统计与处理范围', '## 概况', '## 关键词', '## 附录：分块主题（未综合核对）', '## 主要观点', '## 吐槽点', '## 运行信息'])
    assert.match(markdown, /### 1\. 整体评价一般（模型估计涉及约 12 条，非逐条分类结果）/)
    assert.match(markdown, /- \*\*和别家比\*\*（模型估计涉及约 3 条，非逐条分类结果）/)
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
    const unknown = renderReport(input(themes, { run: run({ usage: { input_tokens: 1000, output_tokens: 200, cached_unreported_calls: 3 } }) }))
    assert.match(unknown, /输入 1,000（缓存命中 未知），输出 200/)
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

test('回复分母就地说明；估计数量不伪装逐条统计', () => {
  const data = makeDataset([makeItem({ id: 'p', reply_count: 337 }), makeItem({ id: 'r', kind: 'reply', parent_id: 'p' })])
  const report = renderReport(input([theme('主要观点', '结论', ['p'])], {}, data))
  assert.match(report, /已采集主评论下标注的回复数合计 337 条/)
  assert.match(report, /不代表全视频回复覆盖率/)
  assert.match(report, /模型估计涉及约 3 条，非逐条分类结果/)
  assert.ok(!report.includes('平台显示'))
})

test('核心结论先于统计，分歧双方分别展示；成功综合后省略原始主题', () => {
  const report = renderReport(input([theme('主要观点', '低价值问候', ['c4'])], { insights: { called: true, insights: [{ finding: '内容接受与品牌记忆需分别验证', evidence: [{ point: '内容评价', refs: [{ id: 'c5', quote: '还可以' }] }], counterevidence: [{ point: '负面证据', refs: [{ id: 'c1', quote: '太贵了' }] }], boundary: '零散线索', meaning: '分开衡量目标', verify: '补充回忆调查' }] } }))
  assert.ok(report.indexOf('## 核心结论') < report.indexOf('## 概况'))
  assert.ok(!report.includes('低价值问候'))
  for (const text of ['还可以', '太贵了', '反例/分歧', '零散线索', '分开衡量目标', '补充回忆调查']) assert.ok(report.includes(text))
})

test('晚段高峰优先进入关键时间轴，完整窗口保留在附录', () => {
  const items = Array.from({ length: 50 }, (_, i) => makeItem({ id: `d${i}`, kind: 'danmaku', text: `普通窗口${i}`, video_time_sec: i * 30 }))
  items.push(...Array.from({ length: 30 }, (_, i) => makeItem({ id: `late${i}`, kind: 'danmaku', text: '广告揭晓', video_time_sec: 1000 })))
  const data = makeDataset(items)
  const report = renderReport(input([], {}, data))
  const main = report.slice(report.indexOf('## 字幕与观众反应时间轴'), report.indexOf('## 附录：完整时间轴'))
  assert.match(main, /广告揭晓/)
  assert.match(report, /1470–1500/)
})

test('补查段落区分未命中、全部已引用、放宽匹配和失败', () => {
  const base = { index: 0, queries: ['价格'], matched: 0, candidates: 0, contradicts: [], qualifies: [], supports: 0, rejected: 0, relaxed: false }
  const insight = { finding: '价格偏高', evidence: [{ point: '抱怨', refs: [{ id: 'c1', quote: '太贵了' }] }], counterevidence: [], boundary: 'b', meaning: 'm', verify: 'v' }
  const render = (item: Record<string, unknown>, error?: string) => renderReport(input([], {
    insights: { insights: [insight], called: true },
    recheck: { items: [{ ...base, ...item } as never], called: true, error },
  }))
  assert.match(render({ status: 'no_candidates' }), /未检索到原文/)
  assert.match(render({ status: 'no_candidates', matched: 2 }), /均已在本发现中引用/)
  assert.match(render({ status: 'checked', matched: 3, candidates: 1, supports: 1, relaxed: true }), /补充任一词出现/)
  assert.match(render({ status: 'checked', matched: 3, candidates: 1, supports: 1 }), /未发现反例或限定，不代表不存在/)
  assert.match(render({ status: 'failed', matched: 3, candidates: 1 }, '预算耗尽'), /补查未完成（预算耗尽）/)
})
