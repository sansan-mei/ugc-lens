import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createFakeModel, type FakeReply } from '../../src/agent/fake_model.ts'
import type { AgentModel } from '../../src/agent/model.ts'
import { findingLines, mergeFindings, parseThemes } from '../../src/pipeline/merge.ts'
import type { Finding } from '../../src/pipeline/summarize.ts'

const DIRS = ['主要观点', '吐槽点']

function f(chunk: number, direction: string, support: number, ids: string[]): Finding {
  return { chunk, direction, title: `${direction}${chunk}-${ids.join('')}`, criteria: '标准', support, refs: ids.map((id) => ({ id })) }
}

const findings: Finding[] = [
  f(0, '主要观点', 5, ['a', 'b']),
  f(1, '主要观点', 4, ['b', 'c']),
  f(0, '吐槽点', 3, ['d']),
  f(1, '吐槽点', 2, ['e']),
  f(1, '吐槽点', 6, ['g']),
]

const submit = (themes: unknown[]): FakeReply => ({ tool_calls: [{ name: 'submit_themes', args: { themes } }] })

test('findingLines：每行一个观点，带方向编号、纳入标准和条数', () => {
  const lines = findingLines(findings, DIRS).split('\n')
  assert.equal(lines.length, findings.length)
  assert.equal(lines[2], `F3 [2] ${findings[2]!.title}｜标准｜约3条`)
})

describe('parseThemes', () => {
  test('合并后条数相加、引用按 ID 去重；漏掉的观点单独成为主题', () => {
    const { themes, invalid_refs } = parseThemes({ themes: [{ direction: 1, title: '合并', findings: [1, 2] }] }, findings, DIRS)
    assert.equal(invalid_refs, 0)
    assert.equal(themes[0]?.support, 9)
    assert.deepEqual(themes[0]?.refs.map((r) => r.id), ['a', 'b', 'c'])
    assert.deepEqual(themes.slice(1).map((t) => t.sources), [[2], [3], [4]])
  })

  test('不存在、方向不符、重复使用的编号不算，计入 invalid_refs；接受 "F2" 这样的写法', () => {
    const { themes, invalid_refs } = parseThemes(
      { themes: [{ direction: 1, title: '合并', findings: ['F1', 'F2', 3, 9, 1] }, { direction: 2, title: '空', findings: [1] }] },
      findings,
      DIRS,
    )
    assert.equal(invalid_refs, 4)
    assert.deepEqual(themes[0]?.sources, [0, 1])
    assert.ok(!themes.some((t) => t.title === '空'))
    assert.equal(themes.flatMap((t) => t.sources).length, findings.length)
  })

  test('子主题的观点算进上一级的条数和引用；方向编号不存在的主题跳过', () => {
    const { themes } = parseThemes(
      {
        themes: [
          { direction: 2, title: '吐槽', findings: [], children: [{ title: '甲', findings: [3] }, { title: '乙', findings: [4, 5] }] },
          { direction: 7, title: '不存在', findings: [1] },
        ],
      },
      findings,
      DIRS,
    )
    assert.equal(themes[0]?.support, 11)
    assert.deepEqual(themes[0]?.children.map((c) => c.support), [3, 8])
    assert.deepEqual(themes[0]?.refs.map((r) => r.id), ['d', 'e', 'g'])
    assert.ok(!themes.some((t) => t.title === '不存在'))
  })

  test('没有 themes 数组时报错', () => {
    assert.throws(() => parseThemes({}, findings, DIRS), /themes/)
  })
})

describe('mergeFindings', () => {
  test('一次调用，指定 submit_themes；按方向顺序、同方向按条数排序；去掉条数太少的', async () => {
    const model = createFakeModel([submit([{ direction: 2, title: '吐槽合并', findings: [3, 4] }])])
    const result = await mergeFindings({ model, findings, directions: DIRS, minSupport: 3 })
    assert.equal(model.requests.length, 1)
    assert.deepEqual(model.requests[0]?.toolChoice, { type: 'function', function: { name: 'submit_themes' } })
    assert.equal(model.requests[0]?.messages[1]?.content, findingLines(findings, DIRS))
    assert.equal(result.called, true)
    assert.ok(result.usage)
    assert.deepEqual(result.themes.map((t) => [t.direction, t.support]), [
      ['主要观点', 5],
      ['主要观点', 4],
      ['吐槽点', 6],
      ['吐槽点', 5],
    ])
  })

  test('只剩一个子主题时不分层，条数不够的子主题去掉', async () => {
    const model = createFakeModel([
      submit([{ direction: 2, title: '吐槽', findings: [], children: [{ title: '甲', findings: [4] }, { title: '乙', findings: [5] }] }]),
    ])
    const result = await mergeFindings({ model, findings, directions: DIRS, minSupport: 3 })
    const theme = result.themes.find((t) => t.title === '吐槽')
    assert.equal(theme?.support, 8)
    assert.deepEqual(theme?.children, [])
  })

  test('观点都来自同一块或只有一条时不调用模型', async () => {
    const model = createFakeModel([])
    const same = findings.filter((x) => x.chunk === 0)
    const result = await mergeFindings({ model, findings: same, directions: DIRS })
    assert.equal(model.requests.length, 0)
    assert.equal(result.called, false)
    assert.equal(result.themes.length, same.length)
    assert.equal((await mergeFindings({ model, findings: [], directions: DIRS })).themes.length, 0)
  })

  test('调用失败或格式错误时，每个观点单独成为主题并记下原因', async () => {
    const failing: AgentModel = { complete: async () => { throw new Error('网络错误') } }
    const a = await mergeFindings({ model: failing, findings, directions: DIRS })
    assert.match(a.error ?? '', /网络错误/)
    assert.equal(a.themes.length, findings.length)

    const bad = createFakeModel([{ tool_calls: [{ name: 'submit_themes', raw_arguments: '{"themes": [' }] }])
    const b = await mergeFindings({ model: bad, findings, directions: DIRS })
    assert.match(b.error ?? '', /JSON/)
    assert.ok(b.usage)
    assert.equal(b.themes.length, findings.length)
  })

  test('提供商拒绝指定工具时改用 auto 重发', async () => {
    const choices: unknown[] = []
    const model: AgentModel = {
      async complete(request) {
        choices.push(request.toolChoice)
        if (typeof request.toolChoice === 'object') {
          throw Object.assign(new Error('HTTP 400: does not support this tool_choice'), { status: 400 })
        }
        return createFakeModel([submit([{ direction: 1, title: '合并', findings: [1, 2] }])]).complete(request)
      },
    }
    const result = await mergeFindings({ model, findings, directions: DIRS })
    assert.deepEqual(choices.slice(1), ['auto'])
    assert.equal(result.error, undefined)
    assert.equal(result.themes[0]?.title, '合并')
  })

  test('取消时抛出，不用兜底结果', async () => {
    const controller = new AbortController()
    const model: AgentModel = {
      async complete() {
        controller.abort()
        throw new Error('aborted')
      },
    }
    await assert.rejects(mergeFindings({ model, findings, directions: DIRS, signal: controller.signal }))
  })
})
