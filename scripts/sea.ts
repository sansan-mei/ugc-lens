/**
 * 桌面单文件包（原型）：把编译产物、界面、手册和生产依赖放进 Node SEA 的虚拟文件系统，
 * 入口是 scripts/desktop_entry.mjs。需要 Node 26.9+（useVfs 与 ESM 入口），只在打包机器上需要。
 * 用法：node scripts/sea.ts --deps <只装了生产依赖的目录>
 * 依赖目录由 `bun install --production --frozen-lockfile --linker hoisted` 生成，版本跟 bun.lock 一致。
 */
import { execFileSync } from 'node:child_process'
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/** 仓库里随包运行需要的目录；node_modules 单独来自生产依赖目录 */
const PACKED_DIRS = ['dist', 'ui', 'playbook', 'skills'] as const

export function shouldPack(name: string): boolean {
  if (name.endsWith('.d.ts') || name.endsWith('.d.mts') || name.endsWith('.d.cts') || name.endsWith('.map')) return false
  return !name.split('/').includes('.bin')
}

function walk(dir: string): string[] {
  let entries
  try { entries = readdirSync(dir, { recursive: true, withFileTypes: true }) } catch { return [] }
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
}

/** [源文件, 归档内名称]，名称用正斜杠，按名称排序保证每次打包内容一致 */
export function archiveEntries(root: string, nodeModules: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [[join(root, 'package.json'), 'package.json']]
  for (const dir of PACKED_DIRS) {
    for (const file of walk(join(root, dir))) entries.push([file, relative(root, file).split(sep).join('/')])
  }
  for (const file of walk(nodeModules)) entries.push([file, `node_modules/${relative(nodeModules, file).split(sep).join('/')}`])
  return entries.filter(([, name]) => shouldPack(name)).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
}

export function seaConfig(options: { main: string; archive: string; outDir: string; platform: NodeJS.Platform }) {
  return {
    main: options.main,
    mainFormat: 'module',
    output: join(options.outDir, options.platform === 'win32' ? 'ugc-lens.exe' : 'ugc-lens'),
    disableExperimentalSEAWarning: true,
    // 虚拟文件系统不能和代码缓存、启动快照同时用
    useSnapshot: false,
    useCodeCache: false,
    useVfs: true,
    vfsArchive: options.archive,
    // 虚拟文件系统和 ZIP 读取都是实验功能，会打印警告；双击启动时用户看不懂，只关掉这一类
    execArgv: ['--disable-warning=ExperimentalWarning'],
  }
}

async function build(): Promise<void> {
  const { values } = parseArgs({ options: { deps: { type: 'string' }, out: { type: 'string' } } })
  if (!values.deps) throw new Error('需要 --deps <只装了生产依赖的目录>')
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  if (major < 26 || (major === 26 && minor < 9)) throw new Error(`需要 Node 26.9 以上打包，当前 ${process.version}`)

  const root = fileURLToPath(new URL('..', import.meta.url))
  const outDir = resolve(values.out ?? join(root, 'build', 'sea'))
  rmSync(join(outDir, 'app.zip'), { force: true })
  mkdirSync(outDir, { recursive: true })

  const entries = archiveEntries(root, join(resolve(values.deps), 'node_modules'))
  for (const required of ['dist/cli/index.js', 'ui/index.html', 'playbook/default.md']) {
    if (!entries.some(([, name]) => name === required)) throw new Error(`缺少 ${required}，请先运行 npm run build`)
  }
  // node:zlib 的 ZIP 接口 26.8 才有，放到这里加载，测试在 Node 22 上也能导入本文件
  const { zipFiles } = (await import('node:zlib')) as unknown as { zipFiles: (files: Iterable<[string, string]>) => NodeJS.ReadableStream }
  const archive = join(outDir, 'app.zip')
  await pipeline(zipFiles(entries), createWriteStream(archive))

  const config = seaConfig({ main: join(root, 'scripts', 'desktop_entry.mjs'), archive, outDir, platform: process.platform })
  const configPath = join(outDir, 'sea-config.json')
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  execFileSync(process.execPath, ['--build-sea', configPath], { stdio: 'inherit' })
  const mb = (file: string) => (statSync(file).size / 1048576).toFixed(1)
  console.log(`已打包 ${entries.length} 个文件：归档 ${mb(archive)} MB，可执行文件 ${config.output}（${mb(config.output)} MB）`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build()
