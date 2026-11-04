import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { describe, test } from 'node:test'
import { createConsoleApprover, describeApproval } from '../../src/cli/approve.ts'
import type { ApprovalRequest } from '../../src/tools/approval.ts'

const request: ApprovalRequest = { kind: 'run_command', command: 'rm x', cwd: '/work' }

async function ask(answer: string | null): Promise<{ approved: boolean; prompt: string }> {
  const input = new PassThrough()
  const output = new PassThrough()
  let prompt = ''
  output.on('data', (chunk: Buffer) => (prompt += chunk.toString()))
  const pending = createConsoleApprover({ input, output })(request)
  if (answer === null) input.end()
  else input.write(`${answer}\n`)
  return { approved: await pending, prompt }
}

describe('createConsoleApprover', () => {
  test('只有 y / yes 算允许', async () => {
    assert.equal((await ask('y')).approved, true)
    assert.equal((await ask('YES')).approved, true)
    assert.equal((await ask('')).approved, false)
    assert.equal((await ask('n')).approved, false)
    assert.equal((await ask('ok')).approved, false)
  })

  test('输入流结束时视为拒绝，不会一直等待', { timeout: 2_000 }, async () => {
    assert.equal((await ask(null)).approved, false)
  })

  test('提示里包含要执行的命令和目录', async () => {
    const { prompt } = await ask('n')
    assert.match(prompt, /\$ rm x/)
    assert.match(prompt, /\/work/)
  })
})

test('describeApproval 覆盖每种确认请求', () => {
  assert.match(describeApproval({ kind: 'overwrite_file', path: '/a.txt', old_bytes: 1, new_bytes: 2 }), /覆盖文件[\s\S]*\/a\.txt/)
})
