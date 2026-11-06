import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { fetchPage, isBlockedAddress, type FetchPolicy } from '../../src/web/fetch.ts'

type Route = (req: IncomingMessage, res: ServerResponse) => void

async function startSite(routes: Record<string, Route>) {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(req.url ?? '')
    const route = routes[new URL(req.url ?? '/', 'http://x').pathname]
    if (route) route(req, res)
    else { res.writeHead(404); res.end() }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { origin, hits, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

/** 测试只放行本地模拟站点，其余地址仍按默认规则判断 */
const local: FetchPolicy = { isAllowed: (address) => address === '127.0.0.1' || !isBlockedAddress(address) }
const options = { timeoutMs: 2_000, maxBytes: 200_000, maxChars: 5_000 }

const ARTICLE = `<html><head><title>事件说明</title><script>window.secret = 1</script><style>p{}</style></head>
<body><nav>首页 登录</nav><article><h1>官方回应</h1><p>${'官方在十月发布了说明，确认价格调整的原因是原材料上涨。'.repeat(20)}</p></article></body></html>`

function html(body: string | Buffer, type = 'text/html; charset=utf-8'): Route {
  return (_req, res) => { res.writeHead(200, { 'Content-Type': type }); res.end(body) }
}

describe('fetchPage 正常读取', () => {
  test('抽取标题和正文，去掉脚本，记录最终地址和字节数', async () => {
    const site = await startSite({ '/a': html(ARTICLE) })
    try {
      const page = await fetchPage(`${site.origin}/a`, { ...options, policy: local })
      assert.equal(page.title, '事件说明')
      assert.match(page.text, /原材料上涨/)
      assert.ok(!page.text.includes('window.secret'))
      assert.equal(page.final_url, `${site.origin}/a`)
      assert.ok(page.bytes > 0)
      assert.equal(page.truncated, false)
    } finally { await site.close() }
  })

  test('正文超过 maxChars 时截断并标记', async () => {
    const site = await startSite({ '/a': html(ARTICLE) })
    try {
      const page = await fetchPage(`${site.origin}/a`, { ...options, maxChars: 50, policy: local })
      assert.ok(page.text.length <= 50)
      assert.equal(page.truncated, true)
    } finally { await site.close() }
  })

  test('跟随重定向，gzip 解压，按 charset 解码 GBK', async () => {
    const gbk = Buffer.concat([Buffer.from('<html><head><title>t</title></head><body><p>'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('</p></body></html>')])
    const site = await startSite({
      '/old': (_req, res) => { res.writeHead(302, { Location: '/new' }); res.end() },
      '/new': (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip' }); res.end(gzipSync(ARTICLE)) },
      '/gbk': html(gbk, 'text/html; charset=gbk'),
    })
    try {
      const page = await fetchPage(`${site.origin}/old`, { ...options, policy: local })
      assert.equal(page.final_url, `${site.origin}/new`)
      assert.match(page.text, /官方回应|原材料/)
      const zh = await fetchPage(`${site.origin}/gbk`, { ...options, policy: local })
      assert.match(zh.text, /中文/)
    } finally { await site.close() }
  })
})

describe('fetchPage 限制', () => {
  test('超过字节上限、非文本类型、超时都报错', async () => {
    const site = await startSite({
      '/big': html(`<p>${'长'.repeat(10_000)}</p>`),
      '/pdf': html('%PDF-1.7', 'application/pdf'),
      '/hang': () => {},
    })
    try {
      await assert.rejects(fetchPage(`${site.origin}/big`, { ...options, maxBytes: 1_000, policy: local }), /超过/)
      await assert.rejects(fetchPage(`${site.origin}/pdf`, { ...options, policy: local }), /类型/)
      await assert.rejects(fetchPage(`${site.origin}/hang`, { ...options, timeoutMs: 200, policy: local }), /超时/)
    } finally { await site.close() }
  })

  test('重定向次数过多时停止', async () => {
    const site = await startSite({ '/loop': (_req, res) => { res.writeHead(302, { Location: '/loop' }); res.end() } })
    try {
      await assert.rejects(fetchPage(`${site.origin}/loop`, { ...options, policy: local }), /重定向/)
      assert.ok(site.hits.length <= 6)
    } finally { await site.close() }
  })
})

describe('SSRF 防护', () => {
  test('回环、私网、metadata、映射地址及零地址的字面量都被拒绝', async () => {
    for (const url of [
      'http://127.0.0.1/', 'http://localhost/', 'http://[::1]/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/', 'http://0.0.0.0/', 'http://[::ffff:127.0.0.1]/', 'http://[fd00::1]/',
      'http://[64:ff9b::a00:1]/', 'http://2130706433/',
    ]) {
      await assert.rejects(fetchPage(url, options), /禁止访问/, url)
    }
  })

  test('只允许 http/https，拒绝 URL 中的账号密码', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/a', 'gopher://example.com/', 'data:text/html,hi']) {
      await assert.rejects(fetchPage(url, options), /协议/, url)
    }
    await assert.rejects(fetchPage('http://user:pass@example.com/', options), /账号/)
  })

  test('域名解析到内网地址时在连接前拒绝', async () => {
    const lookup: FetchPolicy['lookup'] = ((_host: string, opts: unknown, callback: (...args: unknown[]) => void) => {
      const all = typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all
      if (all) callback(null, [{ address: '127.0.0.1', family: 4 }])
      else callback(null, '127.0.0.1', 4)
    }) as FetchPolicy['lookup']
    await assert.rejects(fetchPage('http://rebind.example/', { ...options, policy: { lookup } }), /禁止访问/)
  })

  test('重定向到内网地址时逐跳校验并拒绝', async () => {
    const site = await startSite({ '/jump': (_req, res) => { res.writeHead(302, { Location: 'http://10.0.0.1/admin' }); res.end() } })
    try {
      await assert.rejects(fetchPage(`${site.origin}/jump`, { ...options, policy: local }), /禁止访问/)
    } finally { await site.close() }
  })

  test('isBlockedAddress 放行公网地址', () => {
    assert.equal(isBlockedAddress('93.184.216.34'), false)
    assert.equal(isBlockedAddress('2606:4700:4700::1111'), false)
    assert.equal(isBlockedAddress('10.0.0.1'), true)
    assert.equal(isBlockedAddress('::ffff:10.0.0.1'), true)
    assert.equal(isBlockedAddress('fe80::1'), true)
  })
})
