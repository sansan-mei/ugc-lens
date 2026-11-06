import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { UsageError } from './common.ts'

export const MCP_USAGE = `用法：ugc-lens mcp [--cwd <目录>] [--web]

通过 stdio 提供 MCP 工具，由 Claude Code 等宿主启动。
  --cwd <目录>   配置、缓存、报告和相对数据路径的基准目录，默认当前目录
  --web          允许 ask 工具内部联网搜索（需配置 web）；不会向宿主直接提供联网工具

标准输出仅用于 MCP 协议，不能作为交互对话终端使用。`

export function parseMcpArgs(argv: readonly string[]): { cwd: string; web: boolean } {
  const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, options: { cwd: { type: 'string' }, web: { type: 'boolean', default: false } } })
  if (positionals.length) throw new UsageError('mcp 不接受位置参数，请用 --cwd 指定工作目录')
  if (values.cwd !== undefined && !values.cwd.trim()) throw new UsageError('--cwd 需要目录路径')
  return { cwd: resolve(values.cwd ?? process.cwd()), web: values.web }
}

export async function runMcp(argv: readonly string[]): Promise<void> {
  const { cwd, web } = parseMcpArgs(argv)
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error('不是目录')
  } catch { throw new UsageError(`MCP 工作目录不存在或不是目录：${cwd}`) }
  const [{ serveStdio }, { createMcpServer }, { webEnabled, loadWebConfig }, { createWebSession, defaultWebCacheDir }] = await Promise.all([
    import('@modelcontextprotocol/server/stdio'), import('../mcp/server.ts'), import('../web/config.ts'), import('../web/tools.ts'),
  ])
  // 启动时校验配置，避免宿主调用 ask 时才发现联网配置有误
  const webConfig = webEnabled(web ? { enabled: true } : {}, cwd) ? loadWebConfig({}, cwd) : undefined
  const webFactory = webConfig ? () => createWebSession({ config: webConfig, cacheDir: defaultWebCacheDir(cwd) }) : undefined
  let finished!: () => void
  const done = new Promise<void>((resolve) => { finished = resolve })
  const handle = serveStdio(() => {
    const server = createMcpServer({ cwd, memory: { cwd }, web: webFactory })
    const onclose = server.server.onclose
    server.server.onclose = () => { onclose?.(); finished() }
    return server
  }, { onerror: (error) => console.error(`MCP：${error.message}`) })
  const stop = () => {
    void handle.close().then(finished, (error: unknown) => {
      console.error(`MCP 关闭失败：${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
      finished()
    })
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  // 没有握手就 EOF 时也应退出；有请求时由 SDK 取消并清理。
  process.stdin.once('end', stop)
  try { await done } finally {
    await handle.close()
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    process.stdin.removeListener('end', stop)
  }
}
