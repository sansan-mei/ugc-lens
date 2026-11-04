import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { createReadFileTool } from '../../../src/tools/builtin/read_file.ts'
import { toolSandbox } from '../../helpers/tool_context.ts'

let sandbox = toolSandbox()
afterEach(() => {
  sandbox.cleanup()
  sandbox = toolSandbox()
})

describe('read_file', () => {
  test('带行号返回内容，相对路径以 cwd 为基准', async () => {
    writeFileSync(join(sandbox.dir, 'a.txt'), 'one\ntwo\n')
    const result = await createReadFileTool().execute({ path: 'a.txt' }, sandbox.ctx)
    assert.match(result, /共 2 行，显示第 1-2 行/)
    assert.match(result, /1\| one\n2\| two$/)
    assert.doesNotMatch(result, /还有/)
  })

  test('offset 和 limit 分段读取，并提示下一段的 offset', async () => {
    writeFileSync(join(sandbox.dir, 'a.txt'), Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n'))
    const result = await createReadFileTool().execute({ path: 'a.txt', offset: 3, limit: 2 }, sandbox.ctx)
    assert.match(result, /3\| L3\n4\| L4/)
    assert.doesNotMatch(result, /L5/)
    assert.match(result, /还有 6 行未显示，用 offset=5 继续读取/)
  })

  test('超过字符上限时按整行截断，至少返回一行', async () => {
    writeFileSync(join(sandbox.dir, 'a.txt'), Array.from({ length: 50 }, () => 'x'.repeat(30)).join('\n'))
    const result = await createReadFileTool({ maxOutputChars: 100 }).execute({ path: 'a.txt' }, sandbox.ctx)
    const shown = result.split('\n').filter((line) => /^\d+\| /.test(line))
    assert.ok(shown.length >= 1 && shown.length < 50)
    assert.match(result, new RegExp(`offset=${shown.length + 1}`))
  })

  test('目录、不存在、二进制、过大、offset 越界都报错', async () => {
    const tool = createReadFileTool({ maxFileBytes: 10 })
    mkdirSync(join(sandbox.dir, 'sub'))
    writeFileSync(join(sandbox.dir, 'bin'), Buffer.from([1, 0, 2]))
    writeFileSync(join(sandbox.dir, 'big'), 'x'.repeat(20))
    writeFileSync(join(sandbox.dir, 'small'), 'a\n')

    await assert.rejects(tool.execute({ path: 'sub' }, sandbox.ctx), /是目录/)
    await assert.rejects(tool.execute({ path: 'none' }, sandbox.ctx), /不存在/)
    await assert.rejects(tool.execute({ path: 'bin' }, sandbox.ctx), /二进制/)
    await assert.rejects(tool.execute({ path: 'big' }, sandbox.ctx), /过大/)
    await assert.rejects(tool.execute({ path: 'small', offset: 5 }, sandbox.ctx), /超出范围，文件共 1 行/)
  })

  test('空文件', async () => {
    writeFileSync(join(sandbox.dir, 'empty'), '')
    assert.match(await createReadFileTool().execute({ path: 'empty' }, sandbox.ctx), /空文件/)
  })
})
