import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createConversation } from '../../src/llm/conversation.ts'
import type { ChatMessage, ChatResult } from '../../src/llm/types.ts'

function fakeClient(replies: Array<string | Error>) {
  const calls: ChatMessage[][] = []
  return {
    calls,
    async chat(messages: ChatMessage[]): Promise<ChatResult> {
      calls.push(messages)
      const reply = replies[calls.length - 1]
      if (reply === undefined) throw new Error('没有更多回复')
      if (reply instanceof Error) throw reply
      return {
        message: { role: 'assistant', content: reply },
        finishReason: 'stop',
        usage: { input_tokens: messages.length * 10, output_tokens: 1 },
        model: 'fake',
      }
    },
  }
}

describe('createConversation', () => {
  test('每一轮都发送完整历史', async () => {
    const client = fakeClient(['记住了', '成都'])
    const conversation = createConversation(client, 'sys')

    await conversation.send('我喜欢成都')
    await conversation.send('我喜欢哪里？')

    assert.deepEqual(
      client.calls[1]?.map((m) => `${m.role}:${m.content}`),
      ['system:sys', 'user:我喜欢成都', 'assistant:记住了', 'user:我喜欢哪里？'],
    )
    assert.equal(conversation.messages.length, 5)
  })

  test('累计 token 随历史增长', async () => {
    const conversation = createConversation(fakeClient(['a', 'b']), 'sys')
    await conversation.send('1')
    const first = conversation.usage.input_tokens
    await conversation.send('2')
    assert.ok(conversation.usage.input_tokens - first > first)
  })

  test('请求失败时撤回这条提问', async () => {
    const conversation = createConversation(fakeClient([new Error('网络错误'), 'ok']), 'sys')
    await assert.rejects(conversation.send('第一次'), /网络错误/)
    assert.equal(conversation.messages.length, 1)

    await conversation.send('第二次')
    assert.deepEqual(conversation.messages.map((m) => m.role), ['system', 'user', 'assistant'])
  })

  test('reset 只保留 system prompt', async () => {
    const conversation = createConversation(fakeClient(['a']), 'sys')
    await conversation.send('1')
    conversation.reset()
    assert.deepEqual(conversation.messages, [{ role: 'system', content: 'sys' }])
  })
})
