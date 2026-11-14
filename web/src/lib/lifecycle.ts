/** 页面心跳间隔：桌面版据此判断页面是否还开着（服务端 10 分钟没有请求就退出） */
export const HEARTBEAT_MS = 60_000

/** 心跳失败时是否说明服务已经不在了：请求发不出去，或令牌对不上（端口被新的服务占用） */
export function connectionLost(error: unknown): boolean {
  if (error instanceof TypeError) return true
  return typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 401
}
