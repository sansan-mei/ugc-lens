import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIXES = ['UGC_LENS_']
const KEY_SUFFIX = '_API_KEY'

/**
 * 隔离环境变量、工作目录和用户主目录：清掉本机可能已经设置的提供商配置和 key，
 * 并把 HOME 指向空的临时目录，避免读到本机的 ~/.ugc-lens/config.json。
 * 返回一个空的临时目录，结束时恢复原样。
 */
export function isolateEnv(): { dir: string; home: string; restore: () => void } {
  const saved = { ...process.env }
  for (const name of Object.keys(process.env)) {
    if (PREFIXES.some((p) => name.startsWith(p)) || name.endsWith(KEY_SUFFIX)) delete process.env[name]
  }
  const dir = mkdtempSync(join(tmpdir(), 'ugc-lens-test-'))
  // os.homedir() 在类 Unix 系统上优先读取 HOME，Windows 读取 USERPROFILE
  const home = mkdtempSync(join(tmpdir(), 'ugc-lens-home-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  return {
    home,
    dir,
    restore() {
      for (const name of Object.keys(process.env)) {
        if (!(name in saved)) delete process.env[name]
      }
      Object.assign(process.env, saved)
      rmSync(dir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    },
  }
}
