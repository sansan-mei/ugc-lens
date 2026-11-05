import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFakeModel } from '../../src/agent/fake_model.ts'
import { createSession } from '../../src/chat/session.ts'
import { makeDataset, makeItem } from '../helpers/dataset.ts'

const dataset = makeDataset([makeItem({ id: 'c1', text: '价格太贵' })])

test('会话按模型选择导入和检索，追问保留完整历史和固定 system prompt', async () => {
  const model = createFakeModel([
    { tool_calls: [{ name: 'load_dataset', args: { file: 'data.json' } }] },
    { tool_calls: [{ name: 'search_feedback', args: { query: '价格' } }] },
    { content: '有人觉得价格贵 [c1]' },
    { content: '刚才说的是价格 [c1]' },
  ])
  const loaded: string[] = []
  const session = createSession({ model, cwd: '/data', load: async (file) => { loaded.push(file); return dataset } })
  try {
    const first = await session.ask('看看 data.json 里的价格评价')
    const snapshot = structuredClone(first.messages)
    const second = await session.ask('刚才说什么？')
    assert.deepEqual(loaded, ['/data/data.json'])
    assert.deepEqual(model.requests.at(-1)?.messages.slice(0, snapshot.length), snapshot)
    assert.deepEqual(first.messages, snapshot)
    assert.equal(second.messages.filter((m) => m.role === 'system').length, 1)
    assert.deepEqual(second.messages.filter((m) => m.role === 'user').map((m) => m.content), ['看看 data.json 里的价格评价', '刚才说什么？'])
    for (let i = 0; i < second.messages.length; i++) {
      const message = second.messages[i]!
      if (message.role !== 'assistant') continue
      for (const [j, call] of (message.tool_calls ?? []).entries()) {
        const result = second.messages[i + j + 1]
        assert.equal(result?.role, 'tool')
        if (result?.role === 'tool') assert.equal(result.tool_call_id, call.id)
      }
    }
    assert.match(first.messages.find((m) => m.role === 'tool' && m.content.includes('[c1]'))?.content ?? '', /价格太贵/)
  } finally { await session.close() }
})

test('导入失败交给模型修正；生成报告复用流水线并传入关注点', async () => {
  const model = createFakeModel([
    { tool_calls: [{ name: 'load_dataset', args: { file: 'missing.json' } }] },
    { tool_calls: [{ name: 'analyze_dataset', args: { file: 'data.json', directions: ['价格'] } }] },
    { content: '报告已生成' },
  ])
  const analyzed: unknown[] = []
  const session = createSession({
    model, cwd: '/data',
    load: async (file) => { if (file.endsWith('missing.json')) throw new Error('文件不存在'); return dataset },
    analyze: async (options) => {
      analyzed.push({ dataset: options.dataset, directions: options.directions, cwd: options.cwd })
      return { markdown: '# 价格报告', path: '/data/report.md', calls: 1, usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } }
    },
  })
  try {
    const result = await session.ask('分析价格')
    assert.match(result.messages.find((m) => m.role === 'tool')?.content ?? '', /错误.*文件不存在/)
    assert.deepEqual(analyzed, [{ dataset, directions: ['价格'], cwd: '/data' }])
    assert.ok(result.messages.some((m) => m.role === 'tool' && m.content.includes('# 价格报告') && m.content.includes('/data/report.md')))
  } finally { await session.close() }
})

test('目录列表分页，监听启动后继续对话，查询任务和停止；退出清理后台资源', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ugc-session-'))
  let stopped = 0
  const model = createFakeModel([
    { tool_calls: [{ name: 'list_files', args: { limit: 1 } }] }, { content: '列出了文件' },
    { tool_calls: [{ name: 'start_watch', args: { dir: '.' } }] }, { content: '已监听' },
    { tool_calls: [{ name: 'watch_status' }] }, { content: '仍可对话' },
    { tool_calls: [{ name: 'stop_watch' }] }, { content: '已停止' },
    { tool_calls: [{ name: 'start_watch', args: { dir: '.' } }] }, { content: '重新监听' },
  ])
  const session = createSession({ model, cwd, watch: async (options) => {
    options.onEvent?.({ type: 'watching', dir: options.dir, patterns: ['*_all.json'], ignored: 0, resumed: 0 })
    await new Promise<void>((done) => options.signal.addEventListener('abort', () => { stopped++; done() }, { once: true }))
  } })
  try {
    await writeFile(join(cwd, 'a.json'), '{}')
    await writeFile(join(cwd, 'b.json'), '{}')
    const files = await session.ask('有什么文件？')
    const listing = JSON.parse(files.messages.find((m) => m.role === 'tool')!.content!) as { entries: unknown[]; next_offset: number }
    assert.equal(listing.entries.length, 1)
    assert.equal(listing.next_offset, 1)
    await session.ask('监听这里')
    const status = await session.ask('还在监听吗？')
    assert.ok(status.messages.some((m) => m.role === 'tool' && m.content.includes('"running":true')))
    await session.ask('停止监听')
    assert.equal(stopped, 1)
    await session.ask('重新监听')
    await session.close()
    assert.equal(stopped, 2)
    await assert.rejects(session.ask('你好'), /关闭/)
  } finally { await session.close(); await rm(cwd, { recursive: true, force: true }) }
})

test('监听启动失败作为工具结果返回，允许继续对话', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ugc-session-fail-'))
  const model = createFakeModel([{ tool_calls: [{ name: 'start_watch', args: { dir: '.' } }] }, { content: '监听失败' }, { content: '你好' }])
  const session = createSession({ model, cwd, watch: async () => { throw new Error('无法监听') } })
  try {
    const first = await session.ask('监听这里')
    assert.match(first.messages.find((m) => m.role === 'tool')?.content ?? '', /无法监听/)
    assert.equal((await session.ask('你好')).answer, '你好')
  } finally { await session.close(); await rm(cwd, { recursive: true, force: true }) }
})

test('真实目录监听在后台分析，退出会取消正在运行的分析', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ugc-session-watch-'))
  const model = createFakeModel([
    { tool_calls: [{ name: 'start_watch', args: { dir: '.', existing: true } }] }, { content: '已监听' },
    { tool_calls: [{ name: 'watch_status' }] }, { content: '正在分析' },
  ])
  let started!: () => void
  const analyzing = new Promise<void>((done) => { started = done })
  let cancelled = false
  const session = createSession({ model, cwd, load: async () => dataset, analyze: async ({ signal }) => {
    started()
    await new Promise<void>((done) => {
      const abort = () => { cancelled = true; done() }
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
    signal?.throwIfAborted()
    throw new Error('应当已取消')
  } })
  try {
    await writeFile(join(cwd, 'video_all.json'), '{}')
    await session.ask('监听并分析已有文件')
    await analyzing
    const result = await session.ask('进展如何')
    const tool = result.messages.filter((m) => m.role === 'tool').at(-1)
    assert.match(tool?.content ?? '', /"status":"running"/)
    await session.close()
    assert.equal(cancelled, true)
  } finally { await session.close(); await rm(cwd, { recursive: true, force: true }) }
})

test('持续对话可以直接导入纯文本并按 record 检索，追问继续复用数据', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ugc-text-session-'))
  const model = createFakeModel([
    { tool_calls: [{ name: 'load_dataset', args: { file: 'notes.txt' } }] },
    { tool_calls: [{ name: 'search_feedback', args: { kinds: ['record'], query: '售后' } }] },
    { content: '希望改善售后 [line_3]' }, { content: '上次提到售后 [line_3]' },
  ])
  const session = createSession({ model, cwd })
  try {
    await writeFile(join(cwd, 'notes.txt'), '价格太贵\n\n希望改善售后')
    const first = await session.ask('看看文本中的建议')
    assert.match(first.answer, /line_3/)
    const second = await session.ask('接着说')
    assert.ok(second.messages.some((m) => m.role === 'tool' && m.content?.includes('记录 希望改善售后')))
    assert.equal(model.requests.at(-1)?.messages.filter((m) => m.role === 'user').length, 2)
  } finally { await session.close(); await rm(cwd, { recursive: true, force: true }) }
})
