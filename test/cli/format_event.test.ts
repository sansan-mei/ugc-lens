import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import { runAgent } from '../../src/agent/loop.ts'
import { formatEvent } from '../../src/cli/format_event.ts'

test('每种事件都能格式化成非空文本', async () => {
  const lines: string[] = []
  await runAgent({
    model: createFakeModel([{ tool_calls: [{ name: 'missing' }] }, { content: 'ok' }]),
    messages: [{ role: 'user', content: 'q' }],
    onEvent: (event) => lines.push(formatEvent(event)),
  })
  assert.ok(lines.length > 0)
  assert.ok(lines.every((line) => line.trim().length > 0))
  assert.match(lines.join('\n'), /✗ 工具 missing 失败/)
  assert.match(formatEvent({ type: 'pipeline_stage', run_id: 'r', stage: '统计', progress: 0.5 }), /统计 50%/)
})
