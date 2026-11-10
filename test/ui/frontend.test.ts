import assert from 'node:assert/strict'
import { test } from 'node:test'
// @ts-expect-error 前端模块是无类型的浏览器 ES 模块，测试只检查输出字符串
import { escapeHtml, renderMarkdown } from '../../ui/markdown.js'
// @ts-expect-error 同上
import { area, clock, donut, hBars } from '../../ui/charts.js'

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

test('charts：标签转义、空数据提示、零值环形图与时间格式', () => {
  const svg: string = hBars([{ label: '<b>广东</b>', value: 3 }, { label: '江苏', value: 1 }])
  assert.match(svg, /&lt;b&gt;广东&lt;\/b&gt;/)
  assert.doesNotMatch(svg, /style=/)
  assert.match(hBars([]), /暂无数据/)
  assert.match(area([], 5), /暂无弹幕/)
  assert.match(donut([{ label: 'a', value: 0, color: '#000' }]), /<text[^>]*>0<\/text>/)
  assert.deepEqual([clock(5), clock(65), clock(3725)], ['0:05', '1:05', '1:02:05'])
})
