import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

/** 相对路径以 cwd 为基准，支持 ~ 开头的路径 */
export function resolvePath(path: string, cwd: string): string {
  if (path === '~' || path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}
