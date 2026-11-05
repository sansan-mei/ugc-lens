import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_PATTERNS = ['*_all.json']

/** 只支持 * 和 ?，按文件名（不含目录）匹配，不区分大小写 */
export function compilePatterns(patterns: readonly string[]): (name: string) => boolean {
  const regexes = patterns.map((pattern) => {
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
    return new RegExp(`^${source}$`, 'i')
  })
  return (name) => regexes.some((regex) => regex.test(name))
}

export function parsePatterns(value: string | undefined): string[] {
  const patterns = (value ?? '').split(/[,，]/).map((p) => p.trim()).filter(Boolean)
  return patterns.length > 0 ? patterns : DEFAULT_PATTERNS
}

/** .ugc-lens、.git 这类目录和 node_modules 不进去 */
function skipDir(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules'
}

/** 递归列出匹配的文件，返回绝对路径；读不了的子目录跳过 */
export async function scanFiles(dir: string, match: (name: string) => boolean): Promise<string[]> {
  const found: string[] = []
  const walk = async (current: string, root: boolean) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if (root) throw error
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (!skipDir(entry.name)) await walk(path, false)
      } else if (entry.isFile() && match(entry.name)) {
        found.push(path)
      }
    }
  }
  await walk(dir, true)
  return found.sort()
}
