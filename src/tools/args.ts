import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

/** 第 5 步换成 Zod 校验，这里先手写最基本的检查 */
export function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string') throw new Error(`参数 ${name} 必须是字符串`)
  return value
}

export function optionalInteger(args: Record<string, unknown>, name: string, min: number): number | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(`参数 ${name} 必须是不小于 ${min} 的整数`)
  }
  return value
}

/** 相对路径以 cwd 为基准，支持 ~ 开头的路径 */
export function resolvePath(path: string, cwd: string): string {
  if (path.trim() === '') throw new Error('参数 path 不能为空')
  if (path === '~' || path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}
