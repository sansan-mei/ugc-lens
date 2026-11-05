import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { isolateEnv } from '../helpers/env.ts'
import { completion, sendJson, startMockServer } from '../helpers/mock_server.ts'
const exec = promisify(execFile)
const CLI = process.env.UGC_LENS_TEST_CLI ?? fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url))

test('实际 CLI analyze 支持 CSV/TXT/JSONL，ask 可按原文 ID 引用；只调用 HTTP 模拟模型', { timeout: 10_000 }, async () => {
  const isolated = isolateEnv()
  const server = await startMockServer((request, response) => {
    const body = request.body as { tools: Array<{ function: { name: string } }>; messages: Array<{ role: string }> }
    const name = body.tools[0]?.function.name
    if (name === 'submit_mapping' && body.messages.some((m) => m.role === 'tool')) return sendJson(response, 200, completion('完成'))
    if (name !== 'submit_mapping' && name !== 'submit_findings') return sendJson(response, 200, completion('两条记录都提到服务速度 [line_1] [line_2]'))
    const args = name === 'submit_mapping'
      ? { platform: 'unknown', collections: [{ kind: 'record', path: '$.rows', fields: { id: 'column_1', text: 'column_2' } }] }
      : { findings: [{ direction: 1, title: '希望更快的服务', criteria: '提到服务速度', support: 2, refs: [1, 2] }] }
    return sendJson(response, 200, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })
  })
  const project = join(isolated.dir, 'project')
  await mkdir(join(project, '.ugc-lens'), { recursive: true })
  await writeFile(join(project, '.ugc-lens', 'config.json'), JSON.stringify({ llm: { provider: 'custom', model: 'mock-model', base_url: server.baseUrl, max_retries: 0 } }))
  const run = (args: string[]) => exec(process.execPath, [CLI, ...args], { cwd: project, env: { ...process.env, HOME: isolated.dir } })
  try {
    const cases = [['survey.csv', '编号,回答\n001,希望客服更快回复\n002,期待更快处理售后'], ['notes.txt', '希望客服更快回复\n期待更快处理售后'], ['answers.jsonl', '"希望客服更快回复"\n"期待更快处理售后"']] as const
    for (const [file, text] of cases) {
      await writeFile(join(project, file), text)
      const result = await run(['analyze', file, '--no-save'])
      assert.match(result.stdout, /文本记录：记录 2 条/)
      assert.match(result.stdout, /希望更快的服务/)
      assert.match(result.stdout, /希望客服更快回复/)
      assert.match(result.stderr, file.endsWith('csv') ? /由模型识别/ : /由内置规则读取/)
    }
    const asked = await run(['ask', 'notes.txt', '有什么建议？'])
    assert.match(asked.stdout, /\[line_1\]/)
    assert.match(asked.stderr, /引用 2 个存在/)
  } finally { await server.close(); isolated.restore() }
})
