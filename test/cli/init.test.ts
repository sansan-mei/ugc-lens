import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { runInitFlow, type InitIo } from '../../src/cli/init.ts'
import { globalConfigPath } from '../../src/config.ts'
import { isolateEnv } from '../helpers/env.ts'

let env: ReturnType<typeof isolateEnv>
let home: string
beforeEach(() => {
  env = isolateEnv()
  home = mkdtempSync(join(tmpdir(), 'ugc-home-'))
})
afterEach(() => {
  env.restore()
  rmSync(home, { recursive: true, force: true })
})

/** 按顺序给出回答的假交互；printed 收集输出 */
function fakeIo(answers: string[]): InitIo & { printed: string[] } {
  const printed: string[] = []
  let i = 0
  return {
    printed,
    print: (text) => printed.push(text),
    ask: async () => {
      const answer = answers[i++]
      if (answer === undefined) throw new Error('问题比准备的回答多')
      return answer
    },
  }
}

const flow = (io: InitIo, extra: Partial<Parameters<typeof runInitFlow>[0]> = {}) =>
  runInitFlow({
    io,
    homeDir: home,
    cwd: home, // 空目录，避免读到仓库的 .env
    fetchModels: async () => ['model-a', 'model-b'],
    verifyModel: async () => undefined,
    ...extra,
  })

const saved = () => JSON.parse(readFileSync(globalConfigPath(home), 'utf8')).llm as Record<string, unknown>

describe('runInitFlow', () => {
  test('完整流程：选提供商、选模型、填 key、测试调用、写入全局配置', async () => {
    const io = fakeIo(['1', 'sk-test', '2', ''])
    const result = await flow(io)
    assert.deepEqual(result, { provider: 'deepseek', api_key: 'sk-test', model: 'model-b' })
    assert.deepEqual(saved(), result)
    assert.equal(statSync(globalConfigPath(home)).mode & 0o777, 0o600)
    assert.ok(io.printed.some((line) => line.includes('DeepSeek')))
    assert.ok(io.printed.some((line) => line.includes('测试调用通过')))
  })

  test('已有配置时先展示并询问；回车保持原来的模型和 key', async () => {
    await flow(fakeIo(['1', 'old-key', '1', '']))
    // 换成没有国内/国际之分的 openai，两个问题都回车：保持已保存的 key 和模型
    const io = fakeIo(['y', '6', '', '', 'n'])
    const result = await flow(io)
    assert.deepEqual(result, { provider: 'openai', model: 'model-a', api_key: 'old-key' })
    assert.ok(io.printed[0]?.includes('deepseek / model-a（已保存 key）'))
  })

  test('选择保持现状时不写入', async () => {
    await flow(fakeIo(['1', '', 'k', '1', '']))
    const before = readFileSync(globalConfigPath(home), 'utf8')
    const result = await flow(fakeIo(['n']))
    assert.equal(result, undefined)
    assert.equal(readFileSync(globalConfigPath(home), 'utf8'), before)
  })

  test('环境变量里已有 key 时不保存 key；模型列表失败时手动输入', async () => {
    process.env.DEEPSEEK_API_KEY = 'from-env'
    const io = fakeIo(['1', '', '', '手动模型', 'n'])
    const result = await flow(io, {
      fetchModels: async () => {
        throw new Error('HTTP 401')
      },
    })
    assert.deepEqual(result, { provider: 'deepseek', model: '手动模型' })
    assert.ok(!('api_key' in saved()))
    assert.ok(io.printed.some((line) => line.includes('获取模型列表失败')))
  })

  test('本地服务不问 key；自定义提供商必须填接口地址', async () => {
    const result = await flow(fakeIo(['ollama', '1', 'n']))
    assert.deepEqual(result, { provider: 'ollama', model: 'model-a' })
    // 换个空目录，避免上一个流程写下的配置触发“是否重新设置”
    home = mkdtempSync(join(tmpdir(), 'ugc-home-'))
    await assert.rejects(flow(fakeIo(['custom', ''])), /接口地址/)
  })

  test('测试调用失败时可以不保存', async () => {
    const io = fakeIo(['1', '', 'k', '1', '', 'n'])
    const result = await flow(io, { verifyModel: async () => '模型不支持 function call' })
    assert.equal(result, undefined)
    assert.throws(() => saved(), /ENOENT/)
  })

  test('测试调用失败但选择保存；region 选国际', async () => {
    const io = fakeIo(['2', '2', 'k', '1', '', 'y'])
    const result = await flow(io, { verifyModel: async () => '超时' })
    assert.deepEqual(result, { provider: 'qwen', region: 'global', api_key: 'k', model: 'model-a' })
  })
})
