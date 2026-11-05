import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolvePath } from '../../src/tools/paths.ts'

test('resolvePath：相对路径基于 cwd，绝对路径不变，~ 展开为用户目录', () => {
  assert.equal(resolvePath('a/b.txt', '/work'), join('/work', 'a/b.txt'))
  assert.equal(resolvePath('/etc/hosts', '/work'), '/etc/hosts')
  assert.equal(resolvePath('~/x', '/work'), join(homedir(), 'x'))
  assert.equal(resolvePath('~', '/work'), homedir())
})
