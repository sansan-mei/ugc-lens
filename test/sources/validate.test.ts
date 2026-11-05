import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as z from 'zod'
import { formatSchemaIssues } from '../../src/sources/validate.ts'

test('formatSchemaIssues：列出问题路径，最多 5 处，其余汇总', () => {
  const schema = z.array(z.object({ text: z.string() }))
  const result = schema.safeParse(Array.from({ length: 7 }, () => ({})))
  assert.equal(result.success, false)
  const lines = formatSchemaIssues(result.error!).split('\n')
  assert.equal(lines.length, 6)
  assert.match(lines[0]!, /^- 0\.text：/)
  assert.equal(lines[5], '- 另有 2 处问题')
})

test('formatSchemaIssues：顶层错误标注为文件顶层', () => {
  const result = z.object({}).safeParse(null)
  assert.match(formatSchemaIssues(result.error!), /（文件顶层）/)
})
