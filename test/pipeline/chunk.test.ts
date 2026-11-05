import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { groupDanmaku } from '../../src/analysis/danmaku.ts'
import type { FeedbackItem } from '../../src/dataset/types.ts'
import { buildThreads, mergeDuplicateThreads, planChunks } from '../../src/pipeline/chunk.ts'
import { fixtureDataset, makeDataset, makeItem } from '../helpers/dataset.ts'

/** n 条评论，每条带 replies 条回复，正文各不相同 */
function threads(n: number, replies: number, text = (i: number) => `第${i}条评论，内容编号${i * 7919}`): FeedbackItem[] {
  const items: FeedbackItem[] = []
  for (let i = 0; i < n; i++) {
    items.push(makeItem({ id: `c${i}`, text: text(i), likes: i, reply_count: replies }))
    for (let j = 0; j < replies; j++) {
      items.push(makeItem({ id: `c${i}r${j}`, kind: 'reply', parent_id: `c${i}`, text: `回复${i}-${j}`, likes: j }))
    }
  }
  return items
}

function chunkOf(plan: ReturnType<typeof planChunks>): Map<string, number> {
  const owner = new Map<string, number>()
  for (const chunk of plan.chunks) for (const id of chunk.ids) {
    assert.ok(!owner.has(id), `${id} 出现在多个块里`)
    owner.set(id, chunk.index)
  }
  return owner
}

describe('buildThreads', () => {
  test('一级内容带上所有层级的回复，点赞多的在前；超出上限的记为未列出', () => {
    const dataset = makeDataset([
      makeItem({ id: 'c1', likes: 10 }),
      makeItem({ id: 'r1', kind: 'reply', parent_id: 'c1', likes: 1 }),
      makeItem({ id: 'r2', kind: 'reply', parent_id: 'c1', likes: 5 }),
      makeItem({ id: 'r3', kind: 'reply', parent_id: 'r1', likes: 3 }),
      makeItem({ id: 'd1', kind: 'danmaku' }),
    ])
    const [thread, ...rest] = buildThreads(dataset, { maxRepliesPerThread: 2 })
    assert.equal(rest.length, 0, '弹幕不算')
    assert.deepEqual(thread?.replies.map((r) => r.id), ['r2', 'r3'])
    assert.equal(thread?.omitted_replies, 1)
  })

  test('上一级不在数据里的回复作为一级内容', () => {
    const dataset = makeDataset([makeItem({ id: 'r9', kind: 'reply', parent_id: 'gone' })])
    assert.deepEqual(buildThreads(dataset).map((t) => t.root.id), ['r9'])
  })

  test('热度按对数计算：点赞多的分数高，但不是线性增长', () => {
    const dataset = makeDataset([makeItem({ id: 'a', likes: 10 }), makeItem({ id: 'b', likes: 10_000 })])
    const [a, b] = buildThreads(dataset)
    assert.ok(b!.score > a!.score && b!.score < a!.score * 5)
  })
})

test('mergeDuplicateThreads：正文相同的一级内容合并，保留热度最高的一条', () => {
  const dataset = makeDataset([
    makeItem({ id: 'a', text: '666', likes: 1 }),
    makeItem({ id: 'b', text: '6 6 6！', likes: 50 }),
    makeItem({ id: 'c', text: '666', likes: 3 }),
    makeItem({ id: 'd', text: '讲得好' }),
    makeItem({ id: 'e', text: '[doge]' }),
  ])
  const merged = mergeDuplicateThreads(buildThreads(dataset))
  const b = merged.find((t) => t.root.id === 'b')
  assert.equal(merged.length, 3)
  assert.equal(b?.duplicates, 2)
  assert.ok(!merged.some((t) => t.root.id === 'a' || t.root.id === 'c'))
})

describe('planChunks', () => {
  test('样本数据：全部内容都放进块里，回复和它的评论在同一块', async () => {
    const dataset = await fixtureDataset()
    const plan = planChunks(dataset)
    const owner = chunkOf(plan)
    for (const item of dataset.items) {
      if (item.kind === 'danmaku') continue
      assert.ok(owner.has(item.id), item.id)
      if (item.parent_id) assert.equal(owner.get(item.id), owner.get(item.parent_id))
    }
    assert.equal(plan.coverage.items_included, plan.coverage.items_total)
    assert.equal(plan.coverage.sampled, false)
    assert.deepEqual(plan.chunks.map((c) => c.kind), ['threads', 'danmaku'])
    assert.equal(plan.coverage.danmaku_represented, plan.coverage.danmaku_total)
  })

  test('每块不超过字数上限，块里的行以 [ID] 或回复标记开头', () => {
    const plan = planChunks(makeDataset(threads(60, 3)), { maxChunkChars: 1_000 })
    assert.ok(plan.chunks.length > 3)
    for (const chunk of plan.chunks) {
      assert.ok(chunk.chars <= 1_000, `块 ${chunk.index}：${chunk.chars}`)
      assert.ok(chunk.lines.every((line) => /^(\[|  ↳ )/.test(line)))
      assert.equal(chunk.represents, chunk.ids.length)
    }
    assert.deepEqual(plan.chunks.map((c) => c.index), plan.chunks.map((_, i) => i))
  })

  test('单条串超过上限时去掉回复，一级内容保留', () => {
    const items = threads(1, 50, () => '很长的评论'.repeat(20))
    const plan = planChunks(makeDataset(items), { maxChunkChars: 800 })
    assert.equal(plan.chunks.length, 1)
    assert.ok(plan.chunks[0]!.ids.includes('c0'))
    assert.ok(plan.chunks[0]!.ids.length < 51)
    assert.ok(plan.chunks[0]!.chars <= 800)
    assert.match(plan.chunks[0]!.lines.at(-1)!, /另有 \d+ 条回复未列出/)
  })

  test('超出总预算时抽样：不超预算，热度最高的一定在里面，同一种子结果相同', () => {
    const dataset = makeDataset(threads(500, 0))
    const options = { maxTotalChars: 5_000, maxChunkChars: 2_000, seed: 1 }
    const plan = planChunks(dataset, options)
    const included = plan.chunks.flatMap((c) => c.ids)
    assert.equal(plan.coverage.sampled, true)
    assert.ok(plan.chunks.reduce((s, c) => s + c.chars, 0) <= 5_000)
    assert.ok(included.includes('c499') && included.includes('c498'), '点赞最多的保留')
    assert.ok(included.some((id) => Number(id.slice(1)) < 250), '冷门内容也被抽到')
    assert.deepEqual(planChunks(dataset, options).chunks, plan.chunks)
    assert.notDeepEqual(planChunks(dataset, { ...options, seed: 2 }).chunks.flatMap((c) => c.ids), included)
    assert.equal(plan.coverage.items_included, included.length)
  })

  test('复读评论合并成一行，注明另有多少条，并计入代表条数', () => {
    const plan = planChunks(makeDataset(threads(30, 0, (i) => (i < 20 ? '666666666666' : `正常评论${i}`))))
    const line = plan.chunks[0]!.lines.find((l) => l.includes('同样内容'))
    assert.match(line ?? '', /666…（6×12）（同样内容另有 19 条）/)
    assert.equal(plan.coverage.threads_merged, 19)
    assert.equal(plan.chunks[0]!.represents, 30)
  })

  test('弹幕按组放进单独的块，带重复次数；高峰时段的组也会放进去', () => {
    const items: FeedbackItem[] = [
      ...Array.from({ length: 5 }, (_, i) => makeItem({ id: `a${i}`, kind: 'danmaku', text: '前方高能', video_time_sec: 10 })),
      makeItem({ id: 'b0', kind: 'danmaku', text: '好看', video_time_sec: 70 }),
      makeItem({ id: 'p0', kind: 'danmaku', text: '高峰才有', video_time_sec: 300 }),
    ]
    const dataset = makeDataset(items)
    const groups = groupDanmaku(items)
    const peakGroup = groups.find((g) => g.id === 'p0')!
    const plan = planChunks(dataset, {
      danmakuGroups: 1,
      danmaku: {
        total: 7, unique: 3, groups, bin_sec: 5, timeline: [], terms: [],
        peaks: [{ start_sec: 300, end_sec: 305, count: 1, baseline: 0, z: 9, groups: [peakGroup], terms: [] }],
      },
    })
    const chunk = plan.chunks.find((c) => c.kind === 'danmaku')!
    assert.deepEqual(chunk.ids, ['a0', 'p0'])
    assert.equal(chunk.lines[0], '[a0] 弹幕×5 视频00:10 前方高能')
    assert.equal(chunk.represents, 6)
    assert.deepEqual([plan.coverage.danmaku_groups_included, plan.coverage.danmaku_represented], [2, 6])
  })
})
