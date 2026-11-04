import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { createRunCommandTool } from '../../../src/tools/builtin/run_command.ts'
import { recordingApprover, toolSandbox } from '../../helpers/tool_context.ts'

let cleanup = () => {}
afterEach(() => cleanup())

describe('run_command', () => {
  test('只读命令不需要确认，在 cwd 下执行，返回退出码和输出', async () => {
    const approve = recordingApprover(false)
    const sandbox = toolSandbox({ approve })
    cleanup = sandbox.cleanup
    writeFileSync(join(sandbox.dir, 'hello.txt'), 'hi')

    const result = await createRunCommandTool().execute({ command: 'ls' }, sandbox.ctx)
    assert.match(result, /^退出码：0\n/)
    assert.match(result, /hello\.txt/)
    assert.equal(approve.requests.length, 0)
  })

  test('其他命令先请求确认；拒绝时不执行', async () => {
    const approve = recordingApprover(false)
    const sandbox = toolSandbox({ approve })
    cleanup = sandbox.cleanup

    await assert.rejects(
      createRunCommandTool().execute({ command: 'touch made.txt' }, sandbox.ctx),
      /用户拒绝执行命令：touch made\.txt/,
    )
    assert.equal(existsSync(join(sandbox.dir, 'made.txt')), false)
    assert.deepEqual(approve.requests, [{ kind: 'run_command', command: 'touch made.txt', cwd: sandbox.dir }])
  })

  test('允许后执行；非零退出码和 stderr 照常返回给模型', async () => {
    const sandbox = toolSandbox({ approve: recordingApprover(true) })
    cleanup = sandbox.cleanup
    const result = await createRunCommandTool().execute({ command: 'echo oops 1>&2; exit 3' }, sandbox.ctx)
    assert.match(result, /^退出码：3\n/)
    assert.match(result, /oops/)
  })

  test('输出超过上限时保留开头和结尾', async () => {
    const sandbox = toolSandbox({ approve: recordingApprover(true) })
    cleanup = sandbox.cleanup
    const tool = createRunCommandTool({ maxOutputChars: 100 })
    const result = await tool.execute({ command: `node -e "process.stdout.write('A'.repeat(500) + 'Z'.repeat(500))"` }, sandbox.ctx)
    assert.match(result, /A{50}\n…（输出过长，中间省略 900 个字符）…\nZ{50}$/)
  })

  test('超时后终止命令并报错', async () => {
    const sandbox = toolSandbox({ approve: recordingApprover(true) })
    cleanup = sandbox.cleanup
    const startedAt = Date.now()
    await assert.rejects(
      createRunCommandTool({ timeoutMs: 200 }).execute({ command: 'echo started; sleep 5' }, sandbox.ctx),
      /超过 0\.2 秒，已终止[\s\S]*started/,
    )
    assert.ok(Date.now() - startedAt < 3_000)
  })

  test('运行被取消时终止命令', async () => {
    const controller = new AbortController()
    const sandbox = toolSandbox({ approve: recordingApprover(true), signal: controller.signal })
    cleanup = sandbox.cleanup
    setTimeout(() => controller.abort(), 100)
    await assert.rejects(createRunCommandTool().execute({ command: 'sleep 5' }, sandbox.ctx), /已取消/)
  })

  test('不把 *_API_KEY 环境变量传给子进程', async () => {
    const sandbox = toolSandbox({ approve: recordingApprover(true) })
    cleanup = sandbox.cleanup
    process.env.UGC_LENS_TEST_API_KEY = 'should-not-leak'
    try {
      const result = await createRunCommandTool().execute(
        { command: `node -e "console.log(process.env.UGC_LENS_TEST_API_KEY ?? 'missing')"` },
        sandbox.ctx,
      )
      assert.match(result, /missing/)
    } finally {
      delete process.env.UGC_LENS_TEST_API_KEY
    }
  })
})
