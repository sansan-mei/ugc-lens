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
