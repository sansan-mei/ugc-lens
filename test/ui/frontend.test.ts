import assert from 'node:assert/strict'
import { test } from 'node:test'
import { escapeHtml, renderMarkdown } from '../../web/src/lib/markdown.ts'
import { areaPaths, clock, donutArcs } from '../../web/src/lib/format.ts'

test('markdown：所有文本先转义，只允许 http(s) 链接', () => {
  const html: string = renderMarkdown('# 标题 <script>alert(1)</script>\n\n[点我](javascript:alert(1)) [官网](https://example.com) <img src=x onerror=alert(1)>')
  assert.doesNotMatch(html, /<script>|<img/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /href="javascript:/)
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">官网<\/a>/)
  assert.equal(escapeHtml(`"'<>&`), '&quot;&#39;&lt;&gt;&amp;')
})

test('markdown：[ID] 与 [ID1, ID2] 渲染为引用按钮，Markdown 链接和 web 引用不算', () => {
  const html: string = renderMarkdown('- "原文" [313953591841]；另见 [a_1, b-2]，外部 [web:3]，[文档](https://x.y)')
  assert.match(html, /<button type="button" class="cite" data-id="313953591841">313953591841<\/button>/)
  assert.match(html, /data-id="a_1">a_1<\/button><button type="button" class="cite" data-id="b-2">/)
  assert.doesNotMatch(html, /data-id="web:3"/)
  assert.doesNotMatch(html, /data-id="文档"/)
  const evil: string = renderMarkdown('[x"onmouseover="alert(1)]')
  assert.doesNotMatch(evil, /onmouseover="alert/)
})

test('markdown：表格、列表、引用块和代码块', () => {
  const html: string = renderMarkdown('| 主题 | 条数 |\n|---|---:|\n| 价格 | **3** |\n\n1. 第一\n2. 第二\n\n> 引用\n\n```\n<b>code</b>\n```')
  assert.match(html, /<table><thead><tr><th>主题<\/th><th>条数<\/th><\/tr><\/thead><tbody><tr><td>价格<\/td><td><strong>3<\/strong><\/td><\/tr>/)
  assert.match(html, /<ol><li class="depth-0">第一<\/li><li class="depth-0">第二<\/li><\/ol>/)
  assert.match(html, /<blockquote><p>引用<\/p><\/blockquote>/)
  assert.match(html, /<pre><code>&lt;b&gt;code&lt;\/b&gt;<\/code><\/pre>/)
})

test('charts：空数据、零值与时间格式', () => {
  assert.deepEqual(donutArcs([{ value: 0 }], 100), [])
  assert.equal(areaPaths([], { width: 100, height: 100, left: 5, right: 5, top: 5, bottom: 5 }).line, '')
  assert.deepEqual([clock(5), clock(65), clock(3725)], ['0:05', '1:05', '1:02:05'])
})

test('charts：面积路径与环形分段保持统计比例', () => {
  const box = { width: 100, height: 100, left: 0, right: 0, top: 0, bottom: 0 }
  const result = areaPaths([0, 10], box)
  assert.equal(result.line, 'M0.0,100.0 L100.0,0.0')
  const arcs = donutArcs([{ value: 1 }, { value: 3 }], 100)
  assert.deepEqual(arcs.map((a) => [a.length, a.offset]), [[25, 0], [75, 25]])
})

test('对话：NDJSON 按任意边界切块也能逐行解析', async () => {
  const { lineSplitter } = await import('../../web/src/lib/chat.ts')
  const split = lineSplitter()
  const text = '{"type":"delta","step":1,"text":"你"}\n{"type":"delta","step":1,"text":"好"}\n{"type":"done","answer":"你好"}\n'
  const lines: string[] = []
  for (let i = 0; i < text.length; i += 5) lines.push(...split.push(text.slice(i, i + 5)))
  lines.push(...split.flush())
  assert.deepEqual(lines.map((l) => JSON.parse(l).type), ['delta', 'delta', 'done'])
  assert.deepEqual(split.flush(), [])
  const tail = lineSplitter()
  assert.deepEqual(tail.push('{"a":1}\n{"b"'), ['{"a":1}'])
  assert.deepEqual(tail.flush(), ['{"b"'])
})

test('对话：事件归并为助手回复，新一步和重试清空中间正文，done 以最终回答为准', async () => {
  const { applyChatEvent, newAssistantTurn } = await import('../../web/src/lib/chat.ts')
  let turn = newAssistantTurn()
  const events = [
    { type: 'step', step: 1 },
    { type: 'delta', step: 1, text: '我先查一下' },
    { type: 'tool', step: 1, call_id: 'c1', name: 'search_feedback', args: '{"query":"价格"}' },
    { type: 'tool_end', call_id: 'c1', name: 'search_feedback', ok: true },
    { type: 'step', step: 2 },
    { type: 'delta', step: 2, text: '半句' },
    { type: 'retry', attempt: 1, reason: '503' },
    { type: 'delta', step: 2, text: '价格偏贵 ' },
    { type: 'delta', step: 2, text: '[c9]' },
  ] as const
  for (const e of events) turn = applyChatEvent(turn, e)
  assert.equal(turn.text, '价格偏贵 [c9]')
  assert.equal(turn.status, 'streaming')
  assert.deepEqual(turn.tools, [{ call_id: 'c1', name: 'search_feedback', args: '{"query":"价格"}', ok: true }])
  turn = applyChatEvent(turn, { type: 'warning', message: '画像学习失败：x' })
  turn = applyChatEvent(turn, { type: 'done', answer: '价格偏贵 [c9]', stop_reason: 'completed', citations: { valid: [], invalid: ['c9'] }, known_tokens: 120, unknown_calls: 0 })
  assert.equal(turn.status, 'done')
  assert.deepEqual(turn.citations, { valid: [], invalid: ['c9'] })
  assert.deepEqual(turn.warnings, ['画像学习失败：x'])
  assert.equal(turn.tokens, 120)
  const failed = applyChatEvent(newAssistantTurn(), { type: 'error', message: '上游 500' })
  assert.equal(failed.status, 'error')
  assert.equal(failed.error, '上游 500')
  // 事件归并不修改原对象，React 状态可直接替换
  const before = newAssistantTurn()
  applyChatEvent(before, { type: 'delta', step: 1, text: 'x' })
  assert.equal(before.text, '')
})

test('斜杠命令：输入 / 列出全部命令，按前缀筛选，输入参数后只保留该命令', async () => {
  const { COMMANDS, matchCommands } = await import('../../web/src/lib/commands.ts')
  assert.deepEqual(matchCommands('/').map((c) => c.name), COMMANDS.map((c) => c.name))
  assert.ok(COMMANDS.length >= 8)
  const s = matchCommands('/s').map((c) => c.name)
  assert.ok(s.length > 0 && s.every((n) => n.startsWith('s')))
  assert.deepEqual(matchCommands('/REP').map((c) => c.name), ['report', 'reputation'])
  assert.deepEqual(matchCommands('/report 价格').map((c) => c.name), ['report'])
  assert.deepEqual(matchCommands('/nothing'), [])
  assert.deepEqual(matchCommands('普通问题'), [])
  assert.deepEqual(matchCommands(' /new'), [])
  // 每个命令都有说明，名称唯一
  assert.equal(new Set(COMMANDS.map((c) => c.name)).size, COMMANDS.length)
  for (const c of COMMANDS) assert.ok(c.description.length > 0)
})

test('斜杠命令：解析为本地动作或发给模型的提示词，校验必填参数和未知命令', async () => {
  const { parseCommand } = await import('../../web/src/lib/commands.ts')
  assert.equal(parseCommand('价格怎么样'), undefined)
  assert.deepEqual(parseCommand('/new'), { action: 'new' })
  assert.deepEqual(parseCommand('/open'), { action: 'open' })
  assert.deepEqual(parseCommand('/search  退款 慢 '), { action: 'search', arg: '退款 慢' })
  assert.match((parseCommand('/search') as { error: string }).error, /search.*关键词/)
  assert.match((parseCommand('/foo') as { error: string }).error, /未知命令 \/foo/)
  const report = parseCommand('/Report 价格 争议') as { prompt: string }
  assert.match(report.prompt, /analyze_dataset/)
  assert.match(report.prompt, /价格 争议/)
  const plain = parseCommand('/report') as { prompt: string }
  assert.doesNotMatch(plain.prompt, /关注点：/)
  assert.match((parseCommand('/reputation') as { prompt: string }).prompt, /reputation/)
  assert.match((parseCommand('/competitor') as { prompt: string }).prompt, /competitor/)
  assert.match((parseCommand('/sentiment 主播') as { prompt: string }).prompt, /analyze_sentiment[^]*主播/)
  assert.match((parseCommand('/topics') as { prompt: string }).prompt, /analyze_topics/)
  assert.match((parseCommand('/business') as { prompt: string }).prompt, /analyze_business/)
  assert.match((parseCommand('/watch ./data') as { prompt: string }).prompt, /start_watch[^]*\.\/data/)
  assert.match((parseCommand('/watch') as { error: string }).error, /目录/)
})

test('对话历史：更新时间显示为相对时间', async () => {
  const { relativeTime } = await import('../../web/src/lib/chat.ts')
  const now = new Date('2026-11-10T12:00:00+08:00')
  assert.equal(relativeTime('2026-11-10T11:59:30+08:00', now), '刚刚')
  assert.equal(relativeTime('2026-11-10T11:45:00+08:00', now), '15 分钟前')
  assert.equal(relativeTime('2026-11-10T08:00:00+08:00', now), '4 小时前')
  assert.equal(relativeTime('2026-11-09T20:00:00+08:00', now), '昨天')
  assert.equal(relativeTime('2026-10-03T20:00:00+08:00', now), '10月3日')
  assert.equal(relativeTime('2025-10-03T20:00:00+08:00', now), '2025年10月3日')
})

test('模型设置：已保存的 key 只在接口地址不变时沿用，空 key 不发送', async () => {
  const { formBody, formEndpoint, initialForm, keepsSavedKey, keyPlaceholder } = await import('../../web/src/lib/settings.ts')
  const providers = [
    { id: 'qwen', name: '通义千问', regions: true, key: 'required' as const, key_env: 'DASHSCOPE_API_KEY', base_url: { cn: 'https://cn.example/v1', global: 'https://intl.example/v1' } },
    { id: 'custom', name: '自定义', regions: false, key: 'optional' as const },
  ]
  const web = { enabled: false, providers: [], saved: null, effective: { ok: false as const, enabled: false, error: 'x' }, overrides: [] }
  const view = { path: '/h/.ugc-lens/config.json', providers, overrides: [], effective: { ok: false as const, error: 'x' }, saved: { provider: 'qwen', region: 'cn' as const, model: 'qwen-plus', has_key: true, endpoint: 'https://cn.example/v1' }, web, analysis: { auto_sentiment: false, auto_topics: false, token_budget: 30000 } }
  const form = initialForm(view)
  assert.deepEqual(form, { provider: 'qwen', region: 'cn', base_url: '', model: 'qwen-plus', api_key: '' })
  assert.equal(formEndpoint(form, providers), 'https://cn.example/v1')
  assert.equal(keepsSavedKey(form, view), true)
  assert.match(keyPlaceholder(form, view), /留空保持/)
  assert.equal(keepsSavedKey({ ...form, base_url: 'https://cn.example/v1/' }, view), true)
  const moved = { ...form, region: 'global' as const }
  assert.equal(keepsSavedKey(moved, view), false)
  assert.match(keyPlaceholder(moved, view), /重新填写/)
  assert.match(keyPlaceholder(form, { ...view, saved: null }), /DASHSCOPE_API_KEY/)
  assert.deepEqual(formBody({ ...form, api_key: '  ' }), { provider: 'qwen', region: 'cn', model: 'qwen-plus' })
  assert.equal(formBody({ ...form, api_key: ' sk-1 ' }).api_key, 'sk-1')
})

test('心跳：网络不通或令牌失效视为服务已退出，其他错误不算', async () => {
  const { HEARTBEAT_MS, connectionLost } = await import('../../web/src/lib/lifecycle.ts')
  assert.equal(connectionLost(new TypeError('Failed to fetch')), true)
  assert.equal(connectionLost({ status: 401 }), true)
  assert.equal(connectionLost({ status: 500 }), false)
  assert.equal(connectionLost(new Error('x')), false)
  // 心跳间隔要明显短于桌面版空闲退出时间，后台标签页的计时器被浏览器放慢到每分钟一次也不会误判
  const { DESKTOP_IDLE_MS } = await import('../../src/ui/instance.ts')
  assert.ok(HEARTBEAT_MS * 5 <= DESKTOP_IDLE_MS)
})

test('打开数据后的标签页：在对话页选择文件时留在对话页，其他页面跳到概况', async () => {
  const { tabAfterOpen } = await import('../../web/src/lib/format.ts')
  assert.equal(tabAfterOpen('chat'), 'chat')
  for (const tab of ['overview', 'items', 'reports']) assert.equal(tabAfterOpen(tab), 'overview')
})

test('markdown：[web:N] 有对应来源时渲染为外部链接，未知编号和非 http(s) 网址保持文字', () => {
  const sources = [{ id: 'web:1', title: '梗的出处 <b>', url: 'https://wiki.example/meme?a=1&b=2' }, { id: 'web:2', title: 'x', url: 'javascript:alert(1)' }]
  const html: string = renderMarkdown('外部资料显示 [web:1]，另见 [web:2] 和 [web:9]', { webSources: sources })
  assert.match(html, /<a class="cite-web" href="https:\/\/wiki.example\/meme\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer" title="梗的出处 &lt;b&gt;">web:1<\/a>/)
  assert.doesNotMatch(html, /javascript:/)
  assert.match(html, /\[web:2\]/)
  assert.match(html, /\[web:9\]/)
  // 没有传来源时与原来一致
  assert.match(renderMarkdown('见 [web:1]'), /\[web:1\]/)
})

test('对话事件：done 带回联网来源，工具名有中文说明', async () => {
  const { applyChatEvent, newAssistantTurn, toolLabel } = await import('../../web/src/lib/chat.ts')
  const done = applyChatEvent(newAssistantTurn(), { type: 'done', answer: 'a [web:1]', stop_reason: 'completed', citations: { valid: [], invalid: [] }, known_tokens: 1, unknown_calls: 0, web_sources: [{ id: 'web:1', title: 't', url: 'https://x.example' }] })
  assert.deepEqual(done.web_sources, [{ id: 'web:1', title: 't', url: 'https://x.example' }])
  assert.equal(toolLabel('web_search'), '联网搜索')
  assert.equal(toolLabel('web_fetch'), '读取网页')
  assert.notEqual(toolLabel('list_chats'), 'list_chats')
  assert.notEqual(toolLabel('read_chat'), 'read_chat')
})

test('联网设置表单：初始值来自已保存设置，空 key 不发送，key 提示与服务端沿用规则一致', async () => {
  const { initialWebForm, webFormBody, webKeyPlaceholder } = await import('../../web/src/lib/web_settings.ts')
  const providers = [{ id: 'searxng', name: 'S', needs_key: false }, { id: 'tavily', name: 'T', needs_key: true, key_env: 'TAVILY_API_KEY', base_url: 'https://api.tavily.com' }]
  const view = { enabled: true, providers, saved: { provider: 'tavily', has_key: true, endpoint: 'https://api.tavily.com' }, effective: { ok: true, enabled: true, provider: 'tavily', base_url: 'https://api.tavily.com', has_key: true }, overrides: [] }
  const form = initialWebForm(view as never)
  assert.deepEqual(form, { enabled: true, provider: 'tavily', base_url: '', api_key: '' })
  assert.deepEqual(webFormBody(form), { enabled: true, provider: 'tavily' })
  assert.deepEqual(webFormBody({ ...form, api_key: ' k ', base_url: ' https://p.example ' }), { enabled: true, provider: 'tavily', api_key: 'k', base_url: 'https://p.example' })
  assert.match(webKeyPlaceholder(form, view as never), /已保存/)
  assert.match(webKeyPlaceholder({ ...form, base_url: 'https://p.example' }, view as never), /重新填写/)
  assert.deepEqual(initialWebForm({ ...view, enabled: false, saved: null } as never), { enabled: false, provider: 'searxng', base_url: '', api_key: '' })
})

test('自动分析：按任务状态给出说明和可用操作，进行中时需要轮询', async () => {
  const { analysisTaskView, anyRunning } = await import('../../web/src/lib/analysis.ts')
  assert.deepEqual(analysisTaskView({ state: 'idle' }), { text: '尚未分析', action: '开始分析', running: false })
  assert.deepEqual(analysisTaskView({ state: 'running' }), { text: '分析中…', action: null, running: true })
  assert.deepEqual(analysisTaskView({ state: 'done' }), { text: '已完成', action: '重新分析', running: false })
  const failed = analysisTaskView({ state: 'error', error: '没有配置模型' })
  assert.equal(failed.action, '重试')
  assert.match(failed.text, /没有配置模型/)
  assert.equal(anyRunning({ sentiment: { state: 'done' }, topics: { state: 'running' } }), true)
  assert.equal(anyRunning({ sentiment: { state: 'done' }, topics: { state: 'error' } }), false)
})

test('切回历史对话：对话接入过文件且不是当前文件时才重新打开', async () => {
  const { needsReopen } = await import('../../web/src/lib/chat.ts')
  assert.equal(needsReopen(null, undefined), false)
  assert.equal(needsReopen('a', undefined), false)
  assert.equal(needsReopen('a', { id: 'a', path: '/x/a.json' }), false)
  assert.equal(needsReopen('a', { id: 'b', path: '/x/b.json' }), true)
  assert.equal(needsReopen(null, { id: 'b', path: '/x/b.json' }), true)
})

test('工具详情：结果随 tool_end 保存；JSON 格式化显示，非 JSON 与截断的文字原样保留', async () => {
  const { applyChatEvent, newAssistantTurn, prettyJson } = await import('../../web/src/lib/chat.ts')
  let turn = applyChatEvent(newAssistantTurn(), { type: 'tool', step: 1, call_id: 'c1', name: 'search_feedback', args: '{"query":"学历"}' })
  turn = applyChatEvent(turn, { type: 'tool_end', call_id: 'c1', name: 'search_feedback', ok: true, result: '{"total":3}' })
  assert.deepEqual(turn.tools[0], { call_id: 'c1', name: 'search_feedback', args: '{"query":"学历"}', ok: true, result: '{"total":3}' })
  assert.equal(prettyJson('{"a":[1,2],"b":"中文"}'), '{\n  "a": [\n    1,\n    2\n  ],\n  "b": "中文"\n}')
  assert.equal(prettyJson('第 1 条：价格贵'), '第 1 条：价格贵')
  assert.equal(prettyJson('{"a":1'), '{"a":1')
})

test('检索高亮：按检索语法拆出关键词，不区分大小写标出命中，拼回原文不变', async () => {
  const { highlightTerms, highlightSegments } = await import('../../web/src/lib/format.ts')
  assert.deepEqual(highlightTerms('  价格 贵|便宜  '), ['价格', '便宜', '贵'])
  assert.deepEqual(highlightTerms(''), [])
  const text = 'AI 价格太贵了，ai 便宜点就好(真的)'
  const parts = highlightSegments(text, highlightTerms('ai 贵|便宜 (真'))
  assert.equal(parts.map((p) => p.text).join(''), text)
  assert.deepEqual(parts.filter((p) => p.hit).map((p) => p.text), ['AI', '贵', 'ai', '便宜', '(真'])
  assert.deepEqual(highlightSegments('没有命中', ['价格']), [{ text: '没有命中', hit: false }])
  assert.deepEqual(highlightSegments('abc', []), [{ text: 'abc', hit: false }])
})

test('弹幕密度：鼠标位置换算成时间段，超出范围时取两端', async () => {
  const { binAt } = await import('../../web/src/lib/format.ts')
  assert.equal(binAt(0, 10), 0)
  assert.equal(binAt(0.55, 10), 5)
  assert.equal(binAt(1, 10), 9)
  assert.equal(binAt(-0.2, 10), 0)
  assert.equal(binAt(1.4, 10), 9)
  assert.equal(binAt(0.5, 0), -1)
})

test('自动分析：任务完成但概况里还没有它的结果时需要刷新，已经有结果或仍在进行时不刷新', async () => {
  const { tasksToLoad } = await import('../../web/src/lib/analysis.ts')
  const status = { sentiment: { state: 'done' as const, finished_at: 't1' }, topics: { state: 'running' as const } }
  // 两项同时跑：先完成的一项马上刷新，不等另一项
  assert.deepEqual(tasksToLoad(status, []), ['sentiment'])
  assert.deepEqual(tasksToLoad(status, ['sentiment']), [])
  assert.deepEqual(tasksToLoad({ sentiment: { state: 'done' }, topics: { state: 'done' } }, ['sentiment']), ['topics'])
  assert.deepEqual(tasksToLoad({ sentiment: { state: 'error' }, topics: { state: 'idle' } }, []), [])
  // 重新分析：概况里已有旧结果，上次轮询还在进行、这次完成了，也要刷新
  const previous = { sentiment: { state: 'running' as const }, topics: { state: 'done' as const } }
  assert.deepEqual(tasksToLoad({ sentiment: { state: 'done' }, topics: { state: 'done' } }, ['sentiment', 'topics'], previous), ['sentiment'])
})

test('检索高亮：命中在长文后面时列表从命中前不远处开始显示，保证三行内能看到', async () => {
  const { snippetAround } = await import('../../web/src/lib/format.ts')
  const long = `${'铺垫'.repeat(100)}这里说价格太贵`
  const cut = snippetAround(long, ['价格'], 20)
  assert.ok(cut.startsWith('…'))
  assert.ok(cut.includes('价格'))
  assert.ok(cut.indexOf('价格') <= 21)
  assert.ok(long.endsWith(cut.slice(1)))
  assert.equal(snippetAround('价格就在开头', ['价格'], 20), '价格就在开头')
  assert.equal(snippetAround(long, [], 20), long)
})
