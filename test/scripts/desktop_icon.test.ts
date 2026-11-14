import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { test } from 'node:test'
import { encodePng, iconPixels } from '../../scripts/desktop/icon.ts'

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
