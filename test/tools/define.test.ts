import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import * as z from 'zod'
import { ToolArgumentError, defineTool, toParametersSchema } from '../../src/tools/define.ts'
import { toolSandbox } from '../helpers/tool_context.ts'

describe('toParametersSchema', () => {
  test('生成 object 类型的 JSON Schema，带默认值的字段不在 required 里', () => {
    const schema = toParametersSchema(
      z.object({
        path: z.string().describe('路径'),
        limit: z.number().int().min(1).default(10),
        mode: z.enum(['a', 'b']).optional(),
      }),
    )
    assert.equal(schema.type, 'object')
    assert.deepEqual(schema.required, ['path'])
    const properties = schema.properties as Record<string, Record<string, unknown>>
    assert.equal(properties.path?.description, '路径')
    assert.deepEqual(properties.mode?.enum, ['a', 'b'])
    assert.equal(properties.limit?.minimum, 1)
  })

  test('去掉 $schema 和自动生成的安全整数边界', () => {
    const text = JSON.stringify(toParametersSchema(z.object({ n: z.number().int(), m: z.number().int().max(5) })))
    assert.doesNotMatch(text, /\$schema/)
    assert.doesNotMatch(text, new RegExp(String(Number.MAX_SAFE_INTEGER)))
    assert.match(text, /"maximum":5/)
  })

  test('JSON Schema 表达不了的类型在定义时就报错', () => {
    assert.throws(() => toParametersSchema(z.object({ when: z.date() })))
  })
})

describe('defineTool', () => {
  const tool = defineTool({
    name: 'demo',
    description: 'd',
    parameters: z.object({ text: z.string(), times: z.number().int().min(1).default(2) }),
    execute: async ({ text, times }) => text.repeat(times),
  })

  test('execute 拿到校验后的参数，默认值已填好', async () => {
    const { ctx, cleanup } = toolSandbox()
    try {
      assert.equal(await tool.execute({ text: 'ab' }, ctx), 'abab')
    } finally {
      cleanup()
    }
  })

  test('参数不合格时抛出 ToolArgumentError：指出参数名、原因、收到的值，并附上参数格式', async () => {
    const { ctx, cleanup } = toolSandbox()
    try {
      await assert.rejects(tool.execute({ times: 0 }, ctx), (error: unknown) => {
        assert.ok(error instanceof ToolArgumentError)
        assert.match(error.message, /- text：缺少必填参数/)
        assert.match(error.message, /- times：.*（收到：0）/)
        assert.ok(error.message.includes(`参数格式：${JSON.stringify(tool.parameters)}`))
        return true
      })
    } finally {
      cleanup()
    }
  })

  test('收到的值过长时截断', async () => {
    const { ctx, cleanup } = toolSandbox()
    try {
      await assert.rejects(tool.execute({ text: 1, times: 'x'.repeat(500) }, ctx), (error: unknown) => {
        assert.ok(error instanceof ToolArgumentError)
        assert.match(error.message, /x{50,}…）/)
        assert.ok(error.message.length < 1_000)
        return true
      })
    } finally {
      cleanup()
    }
  })
})
