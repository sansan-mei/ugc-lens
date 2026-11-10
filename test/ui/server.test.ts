import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { ConfigError } from '../../src/config.ts'
import { createUiServer } from '../../src/ui/server.ts'
import { BV_FIXTURE } from '../helpers/fixtures.ts'

const root = mkdtempSync(join(tmpdir(), 'ugc-lens-ui-'))
const cwd = join(root, 'project')
const outside = join(root, 'outside')
mkdirSync(join(cwd, 'data'), { recursive: true })
mkdirSync(outside, { recursive: true })
copyFileSync(BV_FIXTURE, join(cwd, 'data', 'bilibili_all.json'))
writeFileSync(join(cwd, 'report.md'), '# 报告\n\n- "x" [no_such]\n')
writeFileSync(join(outside, 'secret.md'), '# secret')
symlinkSync(join(outside, 'secret.md'), join(cwd, 'link.md'))

// 模型不可用：未知结构只能得到可读错误，测试不访问任何真实模型接口
const ui = createUiServer({ cwd, token: 'test-token', model: { complete: async () => { throw new ConfigError('没有配置模型') } } })
let port = 0
before(async () => { await new Promise<void>((done) => ui.server.listen(0, '127.0.0.1', done)); port = (ui.server.address() as AddressInfo).port })
after(async () => { ui.server.closeAllConnections(); await new Promise((done) => ui.server.close(done)); rmSync(root, { recursive: true, force: true }) })

function call(path: string, options: { method?: string; body?: unknown; token?: string | null; host?: string; origin?: string } = {}): Promise<{ status: number; headers: Record<string, unknown>; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: options.host ?? `127.0.0.1:${port}` }
    if (options.token !== null) headers['x-ugc-lens-token'] = options.token ?? 'test-token'
    if (options.origin) headers.origin = options.origin
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let json: unknown
        try { json = JSON.parse(text) } catch { json = undefined }
        resolve({ status: res.statusCode!, headers: res.headers, json, text })
      })
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(JSON.stringify(options.body))
    req.end()
  })
}

test('ui：前端文件随 npm 包发布', async () => {
  const { readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { files: string[] }
  assert.ok(pkg.files.includes('ui'))
})

test('ui：静态页面无需令牌并带内容安全策略；网址中的令牌放在 # 片段', async () => {
  const page = await call('/', { token: null })
  assert.equal(page.status, 200)
  assert.match(page.text, /<script type="module" src="\/app.js">/)
  assert.match(String(page.headers['content-security-policy']), /script-src 'self'/)
  assert.equal((await call('/app.js', { token: null })).status, 200)
  assert.equal((await call('/../package.json', { token: null })).status, 404)
  assert.equal(ui.url(1234), 'http://127.0.0.1:1234/#token=test-token')
})

test('ui：接口要求令牌、本机 Host 和同源', async () => {
  assert.equal((await call('/api/files', { token: null })).status, 401)
  assert.equal((await call('/api/files', { token: 'wrong-token' })).status, 401)
  assert.equal((await call('/api/files', { host: `evil.example:${port}` })).status, 421)
  assert.equal((await call('/api/files', { origin: 'http://evil.example' })).status, 403)
  assert.equal((await call('/api/files', { origin: `http://127.0.0.1:${port}` })).status, 200)
})

test('ui：列出数据文件，打开后返回概况、检索、详情和引用核对', async () => {
  const files = await call('/api/files')
  assert.ok(files.json.files.some((f: { path: string }) => f.path === 'data/bilibili_all.json'))

  const opened = await call('/api/open', { method: 'POST', body: { path: 'data/bilibili_all.json' } })
  assert.equal(opened.status, 200, opened.text)
  const o = opened.json
  assert.equal(o.mapping, 'builtin')
  assert.ok(o.stats.items.comment > 0)
  assert.ok(o.danmaku.timeline.length > 0)
  assert.deepEqual(o.labels, [])
  assert.ok(o.top.length > 0)

  const all = await call(`/api/datasets/${o.id}/items?limit=5&kinds=comment`)
  assert.equal(all.json.items.length, Math.min(5, all.json.total))
  assert.ok(all.json.items.every((i: { kind: string }) => i.kind === 'comment'))
  const first = all.json.items[0]
  const detail = await call(`/api/datasets/${o.id}/items/${encodeURIComponent(first.id)}`)
  assert.equal(detail.json.item.id, first.id)
  assert.ok(Array.isArray(detail.json.replies))
  assert.equal((await call(`/api/datasets/${o.id}/items/nope`)).status, 404)

  const ids = await call(`/api/datasets/${o.id}/check-ids`, { method: 'POST', body: { ids: [first.id, 'doge', 42] } })
  assert.deepEqual(ids.json.existing, [first.id])
  assert.equal((await call('/api/datasets/unknown/overview')).status, 404)
})

test('ui：报告只能读启动目录内的 Markdown，拒绝越界和指向外部的链接', async () => {
  const list = await call('/api/reports')
  assert.ok(list.json.reports.some((r: { path: string }) => r.path === 'report.md'))
  const report = await call('/api/report?path=report.md')
  assert.match(report.json.text, /# 报告/)
  assert.equal((await call('/api/report?path=../outside/secret.md')).status, 403)
  assert.equal((await call('/api/report?path=link.md')).status, 403)
  assert.equal((await call('/api/report?path=data/bilibili_all.json')).status, 400)
  assert.equal((await call('/api/open', { method: 'POST', body: { path: '../outside/secret.md' } })).status, 403)
})

test('ui：无法识别结构且没有模型配置时返回可读错误', async () => {
  writeFileSync(join(cwd, 'data', 'odd.json'), JSON.stringify({ posts: [{ body: 'a' }, { body: 'b' }] }))
  const result = await call('/api/open', { method: 'POST', body: { path: 'data/odd.json' } })
  assert.equal(result.status, 422, result.text)
  assert.doesNotMatch(result.json.error, /服务内部错误/)
})
