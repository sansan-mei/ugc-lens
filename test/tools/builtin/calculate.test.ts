import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ToolArgumentError } from '../../../src/tools/define.ts'
import { createCalculateTool } from '../../../src/tools/builtin/calculate.ts'
import { toolSandbox } from '../../helpers/tool_context.ts'

describe('calculate', () => {
  const tool = createCalculateTool()
  const { ctx } = toolSandbox()

  test('各种运算', async () => {
    const cases: Array<[string, number, number, string]> = [
      ['add', 0.1, 0.2, String(0.1 + 0.2)],
      ['subtract', 5, 8, '-3'],
      ['multiply', 6, 7, '42'],
      ['divide', 7, 2, '3.5'],
      ['power', 2, 10, '1024'],
      ['mod', 10, 3, '1'],
    ]
    for (const [operation, a, b, expected] of cases) {
      assert.equal(await tool.execute({ operation, a, b }, ctx), expected, operation)
    }
  })

  test('除以 0 和结果溢出时报错', async () => {
    await assert.rejects(tool.execute({ operation: 'divide', a: 1, b: 0 }, ctx), /除数不能为 0/)
    await assert.rejects(tool.execute({ operation: 'mod', a: 1, b: 0 }, ctx), /除数不能为 0/)
    await assert.rejects(tool.execute({ operation: 'power', a: 10, b: 400 }, ctx), /不是有限数/)
  })

  test('未知运算和非数字参数是参数错误', async () => {
    await assert.rejects(tool.execute({ operation: 'sqrt', a: 1, b: 1 }, ctx), ToolArgumentError)
    await assert.rejects(tool.execute({ operation: 'add', a: '1', b: 2 }, ctx), ToolArgumentError)
  })
})
