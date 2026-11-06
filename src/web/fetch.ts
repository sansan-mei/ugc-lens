import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { WebError } from './search.ts'

export interface FetchPolicy {
  /** 判断解析出的地址能否连接；默认拒绝回环、私网、保留地址等 */
  isAllowed?: (address: string) => boolean
  /** DNS 查询函数，默认 node:dns 的 lookup；测试用来模拟解析结果 */
  lookup?: LookupFunction
}

export interface FetchOptions {
  timeoutMs: number
  maxBytes: number
  maxChars: number
  signal?: AbortSignal
  policy?: FetchPolicy
}

export interface FetchedPage {
  url: string
  final_url: string
  status: number
  content_type: string
  title: string
  text: string
  /** 实际收到的响应字节数（压缩时为压缩后的大小） */
  bytes: number
  truncated: boolean
}

const MAX_REDIRECTS = 5
const TYPES = ['text/html', 'application/xhtml+xml', 'text/plain']

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(network, prefix, 'ipv6')

/** IPv4 映射地址（::ffff:a.b.c.d）按其中的 IPv4 判断 */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const family = isIP(ip)
  if (family === 4) return blocked.check(ip, 'ipv4')
  if (family !== 6) return true
  const mapped = ip.match(/^::ffff:(?:0{1,4}:)?(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return blocked.check(mapped[1]!, 'ipv4')
  const hexMapped = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16)
    const lo = parseInt(hexMapped[2]!, 16)
    return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4')
  }
  return blocked.check(ip, 'ipv6')
}

const DENIED = '禁止访问内网、回环或保留地址'

function checkUrl(input: string, allowed: (address: string) => boolean): URL {
  let url: URL
  try { url = new URL(input) } catch { throw new WebError(`无效的 URL：${input.slice(0, 200)}`) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebError(`只允许 http/https 协议，收到 ${url.protocol}`)
  if (url.username || url.password) throw new WebError('不允许在 URL 中包含账号密码')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && !allowed(host)) throw new WebError(`${DENIED}：${host}`)
  if (/^localhost$|\.localhost$/i.test(host)) throw new WebError(`${DENIED}：${host}`)
  return url
}

/** 在连接时校验实际解析出的地址，避免先查 DNS 再连接之间被换成内网地址 */
function guardedLookup(policy: FetchPolicy, allowed: (address: string) => boolean): LookupFunction {
  const base = policy.lookup ?? (dnsLookup as unknown as LookupFunction)
  return ((hostname: string, options: LookupOptions, callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void) => {
    base(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) { callback(error, ''); return }
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses as unknown as string, family: isIP(addresses as unknown as string) }]) as LookupAddress[]
      const denied = list.find((item) => !allowed(item.address))
      if (denied || list.length === 0) { callback(new WebError(`${DENIED}：${hostname} 解析到 ${denied?.address ?? '空地址'}`), ''); return }
      if (options.all) callback(null, list)
      else callback(null, list[0]!.address, list[0]!.family)
    })
  }) as LookupFunction
}

function open(url: URL, lookup: LookupFunction, signal: AbortSignal): Promise<IncomingMessage> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET', lookup, agent: false, signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ugc-lens; +https://github.com/sansan-mei/ugc-lens)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
      },
    }, resolve)
    req.on('error', reject)
    req.end()
  })
}

async function readBody(response: IncomingMessage, maxBytes: number): Promise<{ body: Buffer; bytes: number }> {
  const declared = Number(response.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy()
    throw new WebError(`网页超过大小上限 ${maxBytes} 字节`)
  }
  let bytes = 0
  response.on('data', (chunk: Buffer) => { bytes += chunk.length })
  const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase().trim()
  const stream = encoding === 'gzip' || encoding === 'x-gzip' ? response.pipe(createGunzip())
    : encoding === 'deflate' ? response.pipe(createInflate())
      : encoding === 'br' ? response.pipe(createBrotliDecompress())
        : response
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of stream) {
      size += (chunk as Buffer).length
      // 解压后同样受限，防止压缩炸弹
      if (size > maxBytes) throw new WebError(`网页超过大小上限 ${maxBytes} 字节`)
      chunks.push(chunk as Buffer)
    }
  } finally {
    if (size > maxBytes) response.destroy()
  }
  return { body: Buffer.concat(chunks), bytes }
}

function decode(body: Buffer, contentType: string): string {
  const declared = contentType.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]
  const head = body.subarray(0, 4096).toString('latin1')
  const meta = head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)?.[1]
  for (const label of [declared, meta, 'utf-8']) {
    if (!label) continue
    try { return new TextDecoder(label).decode(body) } catch { /* 不认识的编码换下一个 */ }
  }
  return body.toString('utf8')
}

function clean(text: string): string {
  return text.replace(/\r/g, '').replace(/[ \t\f\v\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 解析库只在真正读取网页时加载，不拖慢命令行启动 */
async function extract(source: string, contentType: string): Promise<{ title: string; text: string }> {
  if (contentType.startsWith('text/plain')) return { title: '', text: clean(source) }
  const [{ parseHTML }, { Readability }] = await Promise.all([import('linkedom'), import('@mozilla/readability')])
  const { document } = parseHTML(source)
  const title = clean(document.title ?? '')
  for (const node of [...document.querySelectorAll('script, style, noscript, template, iframe, svg')]) node.remove()
  const body = clean(document.body?.textContent ?? document.documentElement?.textContent ?? '')
  let article = ''
  try { article = clean(new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse()?.textContent ?? '') } catch { /* 抽取失败时用整页文本 */ }
  // 正文抽取对短页面常常只拿到很少内容，此时整页文本更完整
  const text = article.length >= 200 || (article && article.length >= body.length * 0.5) ? article : body
  return { title, text }
}

/** 只读取公开网页正文：不执行脚本、不带 cookie，重定向逐跳校验地址 */
export async function fetchPage(input: string, options: FetchOptions): Promise<FetchedPage> {
  const policy = options.policy ?? {}
  const allowed = policy.isAllowed ?? ((address: string) => !isBlockedAddress(address))
  const lookup = guardedLookup(policy, allowed)
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let url = checkUrl(input, allowed)
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await open(url, lookup, signal)
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        if (redirects >= MAX_REDIRECTS) throw new WebError(`重定向次数超过 ${MAX_REDIRECTS} 次`)
        url = checkUrl(new URL(response.headers.location, url).href, allowed)
        continue
      }
      if (status < 200 || status >= 300) { response.resume(); throw new WebError(`网页返回 ${status}`) }
      const contentType = String(response.headers['content-type'] ?? 'text/html').toLowerCase()
      if (!TYPES.some((type) => contentType.startsWith(type))) {
        response.destroy()
        throw new WebError(`不支持的内容类型：${contentType.split(';')[0]}，只读取网页和纯文本`)
      }
      const { body, bytes } = await readBody(response, options.maxBytes)
      const { title, text } = await extract(decode(body, contentType), contentType)
      const truncated = text.length > options.maxChars
      return { url: input, final_url: url.href, status, content_type: contentType.split(';')[0]!.trim(), title, text: truncated ? text.slice(0, options.maxChars) : text, bytes, truncated }
    }
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (timeout.aborted) throw new WebError(`读取网页超时（${options.timeoutMs} 毫秒）`)
    if (error instanceof WebError) throw error
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof WebError) throw cause
    throw new WebError(`读取网页失败：${(error as Error).message}`)
  }
}
