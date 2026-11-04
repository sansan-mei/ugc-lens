import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIXES = ['UGC_LENS_']
const KEY_SUFFIX = '_API_KEY'

/**
 * 隔离环境变量和工作目录：清掉本机可能已经设置的提供商配置和 key，
 * 返回一个空的临时目录，结束时恢复原样。
 */
export function isolateEnv(): { dir: string; restore: () => void } {
  const saved = { ...process.env }
  for (const name of Object.keys(process.env)) {
    if (PREFIXES.some((p) => name.startsWith(p)) || name.endsWith(KEY_SUFFIX)) delete process.env[name]
  }
  const dir = mkdtempSync(join(tmpdir(), 'ugc-lens-test-'))
  return {
    dir,
    restore() {
      for (const name of Object.keys(process.env)) {
        if (!(name in saved)) delete process.env[name]
      }
      Object.assign(process.env, saved)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
