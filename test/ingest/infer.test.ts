import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import { inferMapping } from '../../src/ingest/infer.ts'
import { describeShape } from '../../src/ingest/shape.ts'
import { BILIBILI_MAPPING, BV_FIXTURE } from '../helpers/fixtures.ts'

const load = async () => {
  const data = JSON.parse(await readFile(BV_FIXTURE, 'utf8'))
  return { data, shape: describeShape(data), file_path: BV_FIXTURE }
}

test('inferMapping：模型看到文件路径和结构摘要，提交的规则通过后得到转换结果', async () => {
  const input = await load()
  const model = createFakeModel([{ tool_calls: [{ name: 'submit_mapping', args: BILIBILI_MAPPING }] }, { content: '完成' }])
  const { outcome, run } = await inferMapping({ ...input, model })

  assert.equal(outcome?.type, 'mapping')
  assert.equal(run.stop_reason, 'completed')
  const user = model.requests[0]?.messages.find((message) => message.role === 'user')
  assert.ok(typeof user?.content === 'string' && user.content.includes(BV_FIXTURE) && user.content.includes(input.shape.text))
  assert.deepEqual(model.requests[0]?.tools.map((tool) => tool.function.name), ['submit_mapping', 'reject_file'])
  if (outcome?.type === 'mapping') assert.ok(outcome.result.items.length > 0)
})

test('inferMapping：试转换的错误作为工具结果交给模型，模型改正后通过', async () => {
  const input = await load()
  const wrong = { ...BILIBILI_MAPPING, collections: [{ kind: 'comment', path: '$.comments', fields: { text: 'content' } }] }
  const model = createFakeModel([
    { tool_calls: [{ name: 'submit_mapping', args: wrong }] },
    { tool_calls: [{ name: 'submit_mapping', args: BILIBILI_MAPPING }] },
    { content: '完成' },
  ])
  const { outcome, run } = await inferMapping({ ...input, model })

  assert.equal(outcome?.type, 'mapping')
  const [first, second] = run.steps.map((step) => step.tool_calls[0])
  assert.equal(first?.ok, false)
  assert.match(first!.result, /\$\.comments 不是数组/)
  assert.equal(second?.ok, true)
  assert.match(second!.result, /规则已通过/)
})

test('inferMapping：参数格式不对时，模型收到参数错误提示', async () => {
  const input = await load()
  const model = createFakeModel([
    { tool_calls: [{ name: 'submit_mapping', args: { platform: 'bilibili', collections: [{ kind: 'comment', path: 'video_comments', fields: { text: 'content' } }] } }] },
    { content: '放弃' },
  ])
  const { outcome, run, last_error } = await inferMapping({ ...input, model })
  assert.equal(outcome, undefined)
  assert.match(run.steps[0]!.tool_calls[0]!.result, /参数不正确[\s\S]*collections\.0\.path/)
  assert.ok(last_error)
})

test('inferMapping：reject_file 表示文件没有互动内容', async () => {
  const model = createFakeModel([{ tool_calls: [{ name: 'reject_file', args: { reason: '搜索结果列表' } }] }, { content: '完成' }])
  const { outcome } = await inferMapping({ data: [], shape: describeShape([]), file_path: '/x.json', model })
  assert.deepEqual(outcome, { type: 'rejected', reason: '搜索结果列表' })
})

test('inferMapping：连续出错达到上限后停止，不会无限重试', async () => {
  const input = await load()
  const wrong = { platform: 'x', collections: [{ kind: 'comment', path: '$.nope', fields: { text: 'content' } }] }
  const model = createFakeModel((request) =>
    request.toolChoice === 'none' ? { content: '没办法' } : { tool_calls: [{ name: 'submit_mapping', args: wrong }] },
  )
  const { outcome, run, last_error } = await inferMapping({ ...input, model })
  assert.equal(outcome, undefined)
  assert.equal(run.stop_reason, 'tool_errors')
  assert.match(last_error ?? '', /不是数组/)
})
