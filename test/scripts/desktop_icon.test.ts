import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { test } from 'node:test'
import { encodeIco, encodePng, iconFile, iconPixels, ICO_SIZES } from '../../scripts/desktop/icon.ts'

const alpha = (pixels: Uint8Array, size: number, x: number, y: number) => pixels[(y * size + x) * 4 + 3]

test('图标：四角留白透明，主体不透明，留出 macOS 图标网格的边距', () => {
  const size = 64
  const pixels = iconPixels(size)
  assert.equal(pixels.length, size * size * 4)
  for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]] as const) assert.equal(alpha(pixels, size, x, y), 0)
  // 边距约 10%：最外圈一像素透明，中心和主体边缘内侧不透明
  assert.equal(alpha(pixels, size, size / 2, 1), 0)
  assert.equal(alpha(pixels, size, size / 2, size / 2), 255)
  assert.equal(alpha(pixels, size, size / 2, Math.round(size * 0.15)), 255)
})

test('PNG 编码：签名、尺寸和像素可以原样解出', () => {
  const size = 3
  const pixels = new Uint8Array(size * size * 4).map((_, i) => i % 251)
  const png = encodePng(pixels, size)
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(png.toString('latin1', 12, 16), 'IHDR')
  assert.equal(png.readUInt32BE(16), size)
  assert.equal(png.readUInt32BE(20), size)
  const idatLength = png.readUInt32BE(33)
  assert.equal(png.toString('latin1', 37, 41), 'IDAT')
  const raw = inflateSync(png.subarray(41, 41 + idatLength))
  const rows = Array.from({ length: size }, (_, y) => raw.subarray(y * (size * 4 + 1), (y + 1) * (size * 4 + 1)))
  assert.ok(rows.every((row) => row[0] === 0))
  assert.deepEqual(Buffer.concat(rows.map((row) => row.subarray(1))), Buffer.from(pixels))
  assert.equal(png.toString('latin1', png.length - 8, png.length - 4), 'IEND')
})

test('dmg 附带放行说明，与工作流里的应用名、图标一致', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/desktop.yml', import.meta.url), 'utf8')
  const note = readFileSync(new URL('../../scripts/desktop/打开前必读.txt', import.meta.url), 'utf8')
  assert.match(workflow, /scripts\/desktop\/打开前必读\.txt/)
  assert.match(workflow, /CFBundleIconFile/)
  assert.match(workflow, /iconutil/)
  assert.match(note, /xattr -dr com\.apple\.quarantine \/Applications\/ugc-lens\.app/)
  assert.match(note, /隐私与安全性/)
  assert.match(note, /退出/)
})

test('桌面打包工作流：master 上改动打包相关文件时触发，不再依赖原型分支', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/desktop.yml', import.meta.url), 'utf8')
  const triggers = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'))
  assert.doesNotMatch(triggers, /sea-prototype/)
  assert.match(triggers, /workflow_dispatch/)
  assert.match(triggers, /push:\s*\n\s*branches: \[master\]/)
  assert.match(triggers, /pull_request:/)
  // 工作流里用到的打包脚本和桌面入口改了都要重新打包验证
  const used = new Set([...workflow.matchAll(/scripts\/[\w./-]+\.(?:ts|mjs)/g)].map((m) => m[0]))
  used.add('scripts/desktop_entry.mjs')
  used.add('src/cli/desktop.ts')
  const covered = (file: string) => triggers.includes(`- ${file}`) || (file.startsWith('scripts/desktop/') && triggers.includes('- scripts/desktop/**'))
  for (const file of used) assert.ok(covered(file), `${file} 不在触发路径里`)
  assert.ok(triggers.includes('- .github/workflows/desktop.yml'))
})

test('ICO 编码：目录项与内嵌 PNG 一一对应，256 像素记为 0', () => {
  const images = [16, 32, 256].map((size) => ({ size, png: encodePng(iconPixels(size), size) }))
  const ico = encodeIco(images)
  assert.equal(ico.readUInt16LE(0), 0)
  assert.equal(ico.readUInt16LE(2), 1)
  assert.equal(ico.readUInt16LE(4), images.length)
  images.forEach(({ size, png }, i) => {
    const entry = 6 + i * 16
    assert.equal(ico[entry], size % 256)
    assert.equal(ico[entry + 1], size % 256)
    assert.equal(ico.readUInt16LE(entry + 6), 32)
    const length = ico.readUInt32LE(entry + 8)
    const offset = ico.readUInt32LE(entry + 12)
    assert.equal(length, png.length)
    assert.deepEqual(ico.subarray(offset, offset + length), png)
  })
})

test('图标文件按扩展名输出：.png 为单张，.ico 含 Windows 常用尺寸', () => {
  const png = iconFile('icon.png', 32)
  assert.equal(png.toString('latin1', 1, 4), 'PNG')
  assert.equal(png.readUInt32BE(16), 32)
  const ico = iconFile('icon.ico')
  assert.equal(ico.readUInt16LE(4), ICO_SIZES.length)
  for (const size of [16, 32, 48, 256]) assert.ok(ICO_SIZES.includes(size))
  assert.throws(() => iconFile('icon.jpg'))
})

test('Windows 安装包：生成 .ico，安装程序、快捷方式和卸载项都使用它', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/desktop.yml', import.meta.url), 'utf8')
  const iss = readFileSync(new URL('../../scripts/desktop/ugc-lens.iss', import.meta.url), 'utf8')
  const windows = workflow.slice(workflow.indexOf('Package Windows'))
  assert.match(windows, /node scripts\/desktop\/icon\.ts build\/ugc-lens\.ico/)
  assert.match(windows, /\/DIconFile=/)
  assert.match(iss, /^SetupIconFile=\{#IconFile\}/m)
  assert.match(iss, /^UninstallDisplayIcon=\{app\}\\ugc-lens\.ico/m)
  assert.match(iss, /Source: "\{#IconFile\}"; DestDir: "\{app\}"/)
  // 每个快捷方式都要带图标
  const shortcuts = iss.slice(iss.indexOf('[Icons]'), iss.indexOf('[Tasks]')).split('\n').filter((l) => l.startsWith('Name:'))
  assert.ok(shortcuts.length > 0)
  for (const line of shortcuts) assert.match(line, /IconFilename: "\{app\}\\ugc-lens\.ico"/)
})
