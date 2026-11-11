import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { archiveEntries, seaConfig, shouldPack } from '../../scripts/sea.ts'
import { assetPaths } from '../../scripts/desktop_smoke.ts'

test('打包时跳过类型声明、源码映射和可执行链接目录', () => {
  assert.equal(shouldPack('dist/cli/index.js'), true)
  assert.equal(shouldPack('ui/assets/index-abc.css'), true)
  assert.equal(shouldPack('node_modules/zod/package.json'), true)
  assert.equal(shouldPack('dist/cli/index.d.ts'), false)
  assert.equal(shouldPack('dist/cli/index.js.map'), false)
  assert.equal(shouldPack('node_modules/.bin/foo'), false)
  assert.equal(shouldPack('node_modules/linkedom/types/index.d.ts'), false)
})

test('归档条目用正斜杠相对路径，覆盖仓库产物与生产依赖，并去掉不需要的文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'sea-root-'))
  const deps = mkdtempSync(join(tmpdir(), 'sea-deps-'))
  try {
    const put = (base: string, rel: string) => {
      mkdirSync(join(base, rel, '..'), { recursive: true })
      writeFileSync(join(base, rel), 'x')
    }
    put(root, 'package.json')
    put(root, 'dist/cli/index.js')
    put(root, 'dist/cli/index.d.ts')
    put(root, 'ui/index.html')
    put(root, 'playbook/scenarios/crisis.md')
    put(root, 'skills/ugc-lens/SKILL.md')
    put(root, 'src/not_packed.ts')
    put(deps, 'node_modules/zod/package.json')
    put(deps, 'node_modules/.bin/zod')
    put(deps, 'package.json')

    const entries = archiveEntries(root, join(deps, 'node_modules'))
    const names = entries.map(([, name]) => name)
    assert.deepEqual(names, [
      'dist/cli/index.js',
      'node_modules/zod/package.json',
      'package.json',
      'playbook/scenarios/crisis.md',
      'skills/ugc-lens/SKILL.md',
      'ui/index.html',
    ])
    assert.equal(entries.find(([, name]) => name === 'node_modules/zod/package.json')?.[0], join(deps, 'node_modules', 'zod', 'package.json'))
    assert.equal(entries.find(([, name]) => name === 'package.json')?.[0], join(root, 'package.json'))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(deps, { recursive: true, force: true })
  }
})

test('SEA 配置使用 ESM 入口和压缩虚拟文件系统，Windows 输出带 .exe', () => {
  const unix = seaConfig({ main: '/b/entry.mjs', archive: '/b/app.zip', outDir: '/b', platform: 'darwin' })
  assert.equal(unix.mainFormat, 'module')
  assert.equal(unix.useVfs, true)
  assert.equal(unix.vfsArchive, '/b/app.zip')
  assert.equal(unix.output, join('/b', 'ugc-lens'))
  assert.equal(unix.useCodeCache, false)
  assert.equal(unix.useSnapshot, false)
  assert.ok(!('assets' in unix), 'vfsArchive 不能与 assets 同时使用')
  assert.equal(seaConfig({ main: 'e', archive: 'a', outDir: '/b', platform: 'win32' }).output, join('/b', 'ugc-lens.exe'))
})

test('冒烟检查从界面首页提取同源静态资源路径', () => {
  const html = '<script type="module" crossorigin src="/assets/index-a1.js"></script><link rel="stylesheet" href="/assets/index-b2.css"><link rel="icon" href="https://example.com/x.ico">'
  assert.deepEqual(assetPaths(html), ['/assets/index-a1.js', '/assets/index-b2.css'])
})
