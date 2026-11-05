import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { createWriteFileTool } from '../../../src/tools/builtin/write_file.ts'
import { recordingApprover, toolSandbox } from '../../helpers/tool_context.ts'

let cleanup = () => {}
afterEach(() => cleanup())

describe('write_file', () => {
  test('新建文件不需要确认，自动创建上级目录', async () => {
    const approve = recordingApprover(false)
    const sandbox = toolSandbox({ approve })
    cleanup = sandbox.cleanup

    const result = await createWriteFileTool().execute({ path: 'a/b/c.txt', content: '你好' }, sandbox.ctx)
    assert.match(result, /已新建 .*c\.txt（6 字节）/)
    assert.equal(readFileSync(join(sandbox.dir, 'a/b/c.txt'), 'utf8'), '你好')
    assert.equal(approve.requests.length, 0)
  })

  test('覆盖已有文件前请求确认，允许后覆盖', async () => {
    const approve = recordingApprover(true)
    const sandbox = toolSandbox({ approve })
    cleanup = sandbox.cleanup
    const file = join(sandbox.dir, 'x.txt')
    writeFileSync(file, 'old')

    const result = await createWriteFileTool().execute({ path: 'x.txt', content: 'new!' }, sandbox.ctx)
    assert.match(result, /已覆盖/)
    assert.equal(readFileSync(file, 'utf8'), 'new!')
    assert.deepEqual(approve.requests, [{ kind: 'overwrite_file', path: file, old_bytes: 3, new_bytes: 4 }])
  })

  test('用户拒绝覆盖时报错，文件保持原样', async () => {
    const sandbox = toolSandbox({ approve: recordingApprover(false) })
    cleanup = sandbox.cleanup
    const file = join(sandbox.dir, 'x.txt')
    writeFileSync(file, 'old')

    await assert.rejects(createWriteFileTool().execute({ path: 'x.txt', content: 'new' }, sandbox.ctx), /用户拒绝覆盖/)
    assert.equal(readFileSync(file, 'utf8'), 'old')
  })

  test('目标是目录或参数缺失时报错', async () => {
    const sandbox = toolSandbox()
    cleanup = sandbox.cleanup
    mkdirSync(join(sandbox.dir, 'd'))
    await assert.rejects(createWriteFileTool().execute({ path: 'd', content: 'x' }, sandbox.ctx), /是目录/)
    await assert.rejects(createWriteFileTool().execute({ path: 'y.txt' }, sandbox.ctx), /content：缺少必填参数/)
  })
})
