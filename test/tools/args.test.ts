import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { optionalInteger, requireString, resolvePath } from '../../src/tools/args.ts'

describe('参数辅助函数', () => {
  test('resolvePath：相对路径基于 cwd，绝对路径不变，~ 展开为用户目录', () => {
    assert.equal(resolvePath('a/b.txt', '/work'), join('/work', 'a/b.txt'))
    assert.equal(resolvePath('/etc/hosts', '/work'), '/etc/hosts')
    assert.equal(resolvePath('~/x', '/work'), join(homedir(), 'x'))
    assert.throws(() => resolvePath('  ', '/work'), /不能为空/)
  })

  test('requireString / optionalInteger 拒绝错误类型', () => {
    assert.equal(requireString({ a: 'x' }, 'a'), 'x')
    assert.throws(() => requireString({ a: 1 }, 'a'), /必须是字符串/)
    assert.equal(optionalInteger({}, 'n', 1), undefined)
    assert.equal(optionalInteger({ n: 3 }, 'n', 1), 3)
    assert.throws(() => optionalInteger({ n: 0 }, 'n', 1), /不小于 1/)
    assert.throws(() => optionalInteger({ n: 1.5 }, 'n', 1), /整数/)
  })
})
