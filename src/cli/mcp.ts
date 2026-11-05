import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { UsageError } from './common.ts'

export const MCP_USAGE = `用法：ugc-lens mcp [--cwd <目录>]

通过 stdio 提供 MCP 工具，由 Claude Code 等宿主启动。
  --cwd <目录>   配置、缓存、报告和相对数据路径的基准目录，默认当前目录

标准输出仅用于 MCP 协议，不能作为交互对话终端使用。`

export function parseMcpArgs(argv: readonly string[]): { cwd: string } {
  const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, options: { cwd: { type: 'string' } } })
  if (positionals.length) throw new UsageError('mcp 不接受位置参数，请用 --cwd 指定工作目录')
  if (values.cwd !== undefined && !values.cwd.trim()) throw new UsageError('--cwd 需要目录路径')
  return { cwd: resolve(values.cwd ?? process.cwd()) }
}

export async function runMcp(argv: readonly string[]): Promise<void> {
  const { cwd } = parseMcpArgs(argv)
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error('不是目录')
  } catch { throw new UsageError(`MCP 工作目录不存在或不是目录：${cwd}`) }
  const [{ serveStdio }, { createMcpServer }] = await Promise.all([
    import('@modelcontextprotocol/server/stdio'), import('../mcp/server.ts'),
  ])
  let finished!: () => void
  const done = new Promise<void>((resolve) => { finished = resolve })
  const handle = serveStdio(() => {
    const server = createMcpServer({ cwd })
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
