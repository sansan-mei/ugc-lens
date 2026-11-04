import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isReadOnlyCommand, splitWords } from '../../../src/tools/builtin/command_policy.ts'

describe('isReadOnlyCommand', () => {
  test('白名单内的只读命令和它们之间的管道', () => {
    for (const command of [
      'ls -la',
      'date "+%Y-%m-%d"',
      'cat a.txt | wc -l',
      'rg -n "TODO" src',
      'git status',
      'git log --oneline -5',
      'find . -name "*.ts"',
    ]) {
      assert.equal(isReadOnlyCommand(command), true, command)
    }
  })

  test('不在白名单、或带重定向、拼接、变量展开的命令需要确认', () => {
    for (const command of [
      'rm -rf tmp',
      'python3 -c "print(1)"',
      'ls > out.txt',
      'cat a < b',
      'ls; rm x',
      'ls && rm x',
      'ls || rm x',
      'echo $HOME',
      'echo `whoami`',
      'cat $(ls)',
      'ls\nrm x',
      'FOO=1 ls',
      './ls',
      '/bin/ls',
      'ls |',
      'echo "unclosed',
      '',
    ]) {
      assert.equal(isReadOnlyCommand(command), false, JSON.stringify(command))
    }
  })

  test('只读命令带上会写文件或执行程序的参数时需要确认', () => {
    for (const command of [
      'find . -delete',
      'find . -exec rm {} +',
      'sort -o out.txt a.txt',
      'sort --output=out.txt a.txt',
      'rg --pre ./script x',
      'tree -o out.txt',
      'date -s 2020-01-01',
      'git push',
      'git branch -D main',
      'git -c core.pager=sh log',
      'git diff --output=x',
    ]) {
      assert.equal(isReadOnlyCommand(command), false, command)
    }
  })

  test('引号里的特殊字符同样保守处理', () => {
    assert.equal(isReadOnlyCommand('rg "a|b" src'), false)
    assert.equal(isReadOnlyCommand('rg "a;b"'), false)
  })
})

describe('splitWords', () => {
  test('按空白切分，支持引号', () => {
    assert.deepEqual(splitWords(` rg -n "a b" 'c d' e`), ['rg', '-n', 'a b', 'c d', 'e'])
    assert.deepEqual(splitWords('echo ""'), ['echo', ''])
    assert.equal(splitWords('echo "x'), undefined)
  })
})
