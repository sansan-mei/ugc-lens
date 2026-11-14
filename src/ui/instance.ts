import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 桌面版的单实例记录（docs/architecture.md 第 2.1 节“退出与桌面单实例”）。
 * 记录里有令牌，所以权限 600；判断是否在运行不看 pid，而是用令牌请求 /api/ping：
 * pid 可能被复用，端口也可能被别的程序占用，只有令牌和目录都对上才是同一个界面。
 */

export interface InstanceInfo { pid: number; port: number; token: string; cwd: string }

/** 桌面版页面关闭后多久自动退出 */
export const DESKTOP_IDLE_MS = 10 * 60_000

export const instancePath = (home: string): string => join(home, '.ugc-lens', 'ui', 'instance.json')

export async function writeInstance(home: string, info: InstanceInfo): Promise<void> {
  await mkdir(join(home, '.ugc-lens', 'ui'), { recursive: true, mode: 0o700 })
  await writeFile(instancePath(home), JSON.stringify(info), { mode: 0o600 })
}

export async function readInstance(home: string): Promise<InstanceInfo | undefined> {
  try {
    const value = JSON.parse(await readFile(instancePath(home), 'utf8')) as Partial<InstanceInfo>
    if (typeof value.pid === 'number' && typeof value.port === 'number' && typeof value.token === 'string' && typeof value.cwd === 'string') {
      return { pid: value.pid, port: value.port, token: value.token, cwd: value.cwd }
    }
  } catch { /* 没有记录或记录损坏都按没有实例处理 */ }
  return undefined
}

/** 只删除指定进程写的记录：后启动的实例可能已经覆盖了它 */
export async function removeInstance(home: string, pid: number): Promise<void> {
  if ((await readInstance(home))?.pid === pid) await rm(instancePath(home), { force: true })
}

/** 返回运行中且目录一致的界面网址（带令牌），没有则返回 undefined */
export async function findRunning(home: string, cwd: string, timeoutMs = 1500): Promise<string | undefined> {
  const info = await readInstance(home)
  if (!info || info.cwd !== cwd) return undefined
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/ping`, { headers: { 'x-ugc-lens-token': info.token }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return undefined
    const body = await res.json() as { ok?: unknown; cwd?: unknown }
    if (body.ok !== true || body.cwd !== cwd) return undefined
  } catch { return undefined }
  return `http://127.0.0.1:${info.port}/#token=${info.token}`
}

export function idleExpired(activity: { inflight: number; last: number }, now: number, idleMs: number): boolean {
  return activity.inflight === 0 && now - activity.last > idleMs
}
