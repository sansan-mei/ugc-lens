import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { after, before, describe, test } from 'node:test'
import { parseAnalyzeArgs } from '../../src/cli/analyze.ts'
import { parseAskArgs } from '../../src/cli/ask.ts'
import { UsageError } from '../../src/cli/common.ts'

const CLI = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url))

describe('parseAnalyzeArgs', () => {
  test('默认值', () => {
    assert.deepEqual(parseAnalyzeArgs(['a.json']), {
      file: 'a.json', output: undefined, save: true, maxTotalChars: undefined, directions: undefined, concurrency: undefined,
    })
  })
  test('各个选项', () => {
    const args = parseAnalyzeArgs(['a.json', '-o', 'r.md', '--no-save', '--chars', '20000', '--focus', '价格,售后', '--concurrency', '2'])
    assert.deepEqual(args, { file: 'a.json', output: 'r.md', save: false, maxTotalChars: 20000, directions: ['价格', '售后'], concurrency: 2 })
  })
  test('缺文件、多个文件、数字不对时抛出 UsageError', () => {
    assert.throws(() => parseAnalyzeArgs([]), UsageError)
    assert.throws(() => parseAnalyzeArgs(['a', 'b']), UsageError)
    assert.throws(() => parseAnalyzeArgs(['a', '--concurrency', '1.5']), UsageError)
    assert.throws(() => parseAnalyzeArgs(['a', '--chars=-1']), UsageError)
  })
})

describe('parseAskArgs', () => {
  test('第一个是文件，后面依次是问题；空问题去掉', () => {
    assert.deepEqual(parseAskArgs(['a.json', '吐槽什么？', ' ', '追问', '--verbose']), { file: 'a.json', questions: ['吐槽什么？', '追问'], verbose: true })
  })
  test('缺文件或缺问题时抛出 UsageError', () => {
    assert.throws(() => parseAskArgs([]), UsageError)
    assert.throws(() => parseAskArgs(['a.json']), /问题/)
  })
})

describe('命令行入口', () => {
  // 在空目录里运行，不读本机的 .env
  let cwd: string
  const env = { PATH: process.env.PATH ?? '' }
  const run = async (...args: string[]) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], { cwd, env })
      return { code: 0, stdout, stderr }
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string }
      return { code: e.code, stdout: e.stdout, stderr: e.stderr }
    }
  }
  before(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'ugc-cli-'))
  })
  after(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  test('没有参数或 --help 时打印总用法；--version 打印 package.json 的版本', async () => {
    for (const args of [[], ['--help']]) {
      const r = await run(...args)
      assert.equal(r.code, 0)
      assert.match(r.stdout, /ugc-lens analyze <文件>/)
    }
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
    assert.equal((await run('--version')).stdout.trim(), pkg.version)
  })

  test('命令 --help 打印该命令的用法，不读取配置', async () => {
    for (const command of ['init', 'analyze', 'ask', 'watch']) {
      const r = await run(command, '--help')
      assert.equal(r.code, 0)
      assert.match(r.stdout, new RegExp(`ugc-lens ${command}`))
    }
  })

  test('init 在非交互终端里拒绝运行', async () => {
    const r = await run('init')
    assert.equal(r.code, 2)
    assert.match(r.stderr, /交互/)
  })

  test('未知命令、参数不对退出码 2；缺 API key 退出码 1 并提示', async () => {
    assert.equal((await run('foo')).code, 2)
    const bad = await run('analyze')
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /需要一个要分析的文件/)
    assert.equal((await run('ask', 'a.json', '--unknown', 'q')).code, 2)
    const noKey = await run('analyze', 'a.json')
    assert.equal(noKey.code, 1)
    assert.match(noKey.stderr, /^错误：/)
    assert.ok(!noKey.stderr.includes('    at '), '已知错误不打印调用栈')
  })
})
