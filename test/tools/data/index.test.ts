import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createDatasetStore } from '../../../src/dataset/store.ts'
import { createDataTools } from '../../../src/tools/data/index.ts'
import { ToolArgumentError } from '../../../src/tools/define.ts'
import type { AgentTool, ToolContext } from '../../../src/tools/types.ts'
import { fixtureDataset, makeDataset, makeItem } from '../../helpers/dataset.ts'

const ctx: ToolContext = { run_id: 'test', signal: new AbortController().signal, cwd: '/', approve: async () => false }

const items = [
  makeItem({ id: 'c1', text: '标题党，退钱！', likes: 10, reply_count: 5, created_at: '2024-05-02T00:00:00.000Z', author: { location: '广东' } }),
  makeItem({ id: 'c2', text: '讲得很清楚'.repeat(100), likes: 50, created_at: '2024-05-01T00:00:00.000Z' }),
  ...Array.from({ length: 12 }, (_, i) =>
    makeItem({ id: `r${i + 1}`, kind: 'reply', parent_id: 'c1', text: `回复 ${i + 1}`, created_at: `2024-05-${String(i + 3).padStart(2, '0')}T00:00:00.000Z` }),
  ),
  makeItem({ id: 'd1', kind: 'danmaku', text: '骗人的吧', video_time_sec: 30 }),
]

function toolsFor(datasets = [makeDataset(items)], maxOutputChars?: number) {
  const byName = new Map<string, AgentTool>(createDataTools(createDatasetStore(datasets), { maxOutputChars }).map((t) => [t.name, t]))
  return (name: string, args: Record<string, unknown> = {}) => {
    const tool = byName.get(name)
    assert.ok(tool, name)
    return tool.execute(args, ctx)
  }
}

describe('数据工具', () => {
  test('createDataTools：四个只读工具，参数里 dataset_id 都是可选的', () => {
    const tools = createDataTools(createDatasetStore([]))
    assert.deepEqual(tools.map((t) => t.name), ['list_datasets', 'get_dataset_stats', 'search_feedback', 'get_feedback'])
    for (const tool of tools) {
      const required = (tool.parameters.required as string[] | undefined) ?? []
      assert.ok(!required.includes('dataset_id'), tool.name)
    }
  })

  test('list_datasets：列出每个数据集的 ID、平台、文件名、标题和条数', async () => {
    const call = toolsFor([makeDataset(items, { id: 'a' }), makeDataset([], { id: 'b', file_path: '/x/other.json', contents: [] })])
    const lines = (await call('list_datasets')).split('\n')
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, /^a bilibili test\.json 《测试视频》：1 个内容，15 条互动内容$/)
    assert.match(lines[1]!, /^b bilibili other\.json：0 个内容，0 条互动内容$/)
    assert.equal(await toolsFor([])('list_datasets'), '还没有导入任何数据集。')
  })

  test('get_dataset_stats：包含内容标题、计数、回复搜集比例和点赞最多的评论', async () => {
    const result = await toolsFor()('get_dataset_stats')
    assert.match(result, /测试视频/)
    assert.match(result, /comment 2，reply 12，danmaku 1/)
    assert.match(result, /平台显示 5 条，实际搜集到 12 条/)
    assert.match(result, /广东 1/)
    const top = result.split('\n').filter((line) => line.startsWith('['))
    assert.deepEqual(top.map((line) => line.match(/^\[(\w+)\]/)?.[1]), ['c2', 'c1'])
    assert.ok(top[0]!.length < 200, '概况里的评论正文要截断')
  })

  test('get_dataset_stats：样本数据中的计数与数据集一致', async () => {
    const dataset = await fixtureDataset()
    const result = await toolsFor([dataset])('get_dataset_stats')
    const comments = dataset.items.filter((item) => item.kind === 'comment').length
    assert.match(result, new RegExp(`comment ${comments}`))
    assert.match(result, new RegExp(dataset.contents[0]!.title!.slice(0, 5)))
  })

  test('采样比例只是数量对照，不自动判定样本不完整或无效', async () => {
    const result = await toolsFor([makeDataset([
      makeItem({ id: 'c', reply_count: 3 }),
      makeItem({ id: 'r', kind: 'reply', parent_id: 'c' }),
    ])])('get_dataset_stats')
    assert.match(result, /33%/)
    assert.doesNotMatch(result, /回复是不完整的样本/)
    assert.match(result, /不能仅凭.*比例/)
  })

  test('search_feedback：每行一条，ID 在最前，末尾说明总数和下一页的 offset', async () => {
    const call = toolsFor()
    const first = (await call('search_feedback', { kinds: ['reply'], sort: 'oldest', limit: 5 })).split('\n')
    assert.deepEqual(first.slice(0, 5).map((line) => line.match(/^\[(\w+)\]/)?.[1]), ['r1', 'r2', 'r3', 'r4', 'r5'])
    assert.equal(first.at(-1), '共 12 条，显示第 1-5 条；用 offset=5 查看下一页。')
    const last = await call('search_feedback', { kinds: ['reply'], sort: 'oldest', offset: 10 })
    assert.match(last, /^\[r11\][\s\S]*\[r12\][\s\S]*共 12 条，已全部显示。$/)
  })

  test('search_feedback：正文截断；没有结果、offset 超出时给出说明', async () => {
    const call = toolsFor()
    assert.match(await call('search_feedback', { query: '清楚' }), /…（全文 500 字）/)
    assert.match(await call('search_feedback', { query: '不存在的词' }), /没有符合条件的内容/)
    assert.match(await call('search_feedback', { offset: 99 }), /共 15 条，offset=99 已超出范围/)
  })

  test('search_feedback：结果超过字符上限时少显示几条，并按实际显示的条数给出下一页', async () => {
    const result = await toolsFor(undefined, 300)('search_feedback', { kinds: ['reply'], sort: 'oldest', limit: 50 })
    const shown = result.split('\n').filter((line) => line.startsWith('[')).length
    assert.ok(shown > 0 && shown < 12)
    assert.match(result, new RegExp(`显示第 1-${shown} 条；用 offset=${shown} 查看下一页`))
  })

  test('search_feedback：参数不合法时抛出参数错误', async () => {
    const call = toolsFor()
    await assert.rejects(call('search_feedback', { limit: 51 }), ToolArgumentError)
    await assert.rejects(call('search_feedback', { kinds: ['post'] }), ToolArgumentError)
  })

  test('get_feedback：全文、上一级和按时间排列的回复，回复可以分页', async () => {
    const call = toolsFor()
    const c2 = await call('get_feedback', { ids: ['c2'] })
    assert.ok(c2.includes('讲得很清楚'.repeat(100)), '显示全文')

    const c1 = await call('get_feedback', { ids: ['c1'], reply_limit: 3 })
    assert.match(c1, /回复（搜集到 12 条，平台显示 5 条）/)
    assert.deepEqual([...c1.matchAll(/- \[(\w+)\]/g)].map((m) => m[1]), ['r1', 'r2', 'r3'])
    assert.match(c1, /还有 9 条回复，用 reply_offset=3 继续/)
    const next = await call('get_feedback', { ids: ['c1'], reply_offset: 3, reply_limit: 3 })
    assert.deepEqual([...next.matchAll(/- \[(\w+)\]/g)].map((m) => m[1]), ['r4', 'r5', 'r6'])

    assert.match(await call('get_feedback', { ids: ['r2'] }), /上一级：\[c1\]/)
  })

  test('get_feedback：部分 ID 不存在时照常返回并列出缺失；全部不存在时报错', async () => {
    const call = toolsFor()
    const result = await call('get_feedback', { ids: ['d1', 'zz'] })
    assert.match(result, /^\[d1\]/)
    assert.match(result, /找不到这些 ID：zz$/)
    await assert.rejects(call('get_feedback', { ids: ['zz'] }), /找不到这些 ID：zz/)
  })

  test('get_feedback：平台显示有回复但没搜集到时说明；上一级不在数据里时说明', async () => {
    const call = toolsFor([makeDataset([makeItem({ id: 'a', reply_count: 3 }), makeItem({ id: 'b', kind: 'reply', parent_id: 'gone' })])])
    assert.match(await call('get_feedback', { ids: ['a'] }), /平台显示有 3 条回复，但没有搜集到/)
    assert.match(await call('get_feedback', { ids: ['b'] }), /上一级 \[gone\] 不在数据里/)
  })

  test('多个数据集时按 dataset_id 查询，不填则报错', async () => {
    const call = toolsFor([makeDataset(items, { id: 'a' }), makeDataset([makeItem({ id: 'x1', text: '另一个' })], { id: 'b' })])
    assert.match(await call('search_feedback', { dataset_id: 'b' }), /^\[x1\]/)
    await assert.rejects(call('get_dataset_stats'), /请用 dataset_id 指定/)
  })
})
