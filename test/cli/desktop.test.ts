import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { desktopArgs } from '../../src/cli/desktop.ts'

const home = join('/home', 'someone')

test('双击启动（没有参数）进入界面，目录放在用户目录下且不与全局配置目录重叠', () => {
  const result = desktopArgs([], home)
  assert.equal(result.workdir, join(home, 'ugc-lens'))
  assert.deepEqual(result.args, ['ui', '--cwd', result.workdir])
  assert.notEqual(result.workdir, join(home, '.ugc-lens'))
})

test('macOS 旧版本附带的进程序列号参数视为没有参数', () => {
  const result = desktopArgs(['-psn_0_12345'], home)
  assert.deepEqual(result.args, ['ui', '--cwd', join(home, 'ugc-lens')])
})

test('带参数时按命令行原样执行，不建目录', () => {
  for (const args of [['--version'], ['ui', '--no-open'], ['analyze', 'a.json', '-psn_x']]) {
    const result = desktopArgs(args, home)
    assert.deepEqual(result.args, args)
    assert.equal(result.workdir, undefined)
  }
})
