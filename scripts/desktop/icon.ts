/**
 * 桌面版应用图标：深色圆角方块上的白色光圈，与界面左上角的标志一致（lucide 的 aperture）。
 * 用纯 Node 画成 PNG，不引入图形依赖，也不在仓库里放二进制文件；macOS 打包时再用 sips、iconutil 转成 .icns。
 * 用法：node scripts/desktop/icon.ts <输出.png> [边长，默认 1024]
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

// lucide aperture 的六条线段，坐标在 24×24 网格里，圆心 (12,12)、半径 10
const BLADES: ReadonlyArray<readonly [number, number, number, number]> = [
  [14.31, 8, 20.05, 17.94], [9.69, 8, 21.17, 8], [7.38, 12, 13.12, 2.06],
  [9.69, 16, 3.95, 6.06], [14.31, 16, 2.83, 16], [16.62, 12, 10.88, 21.94],
]
/** macOS 图标网格：主体占约 80%，圆角约为主体边长的 22.5% */
const MARGIN = 0.1
const RADIUS = 0.8 * 0.225
const UNIT = 0.025 // 网格一格对应的边长比例：半径 10 格 → 0.25
const STROKE = UNIT // 线宽 2 格，取一半

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

const grid = (v: number) => 0.5 + (v - 12) * UNIT
const blades = BLADES.map(([ax, ay, bx, by]) => [grid(ax), grid(ay), grid(bx), grid(by)] as const)

function insideBody(x: number, y: number): boolean {
  const lo = MARGIN + RADIUS, hi = 1 - MARGIN - RADIUS
  const cx = Math.max(lo, Math.min(hi, x)), cy = Math.max(lo, Math.min(hi, y))
  return Math.hypot(x - cx, y - cy) <= RADIUS
}

function onMark(x: number, y: number): boolean {
  if (Math.abs(Math.hypot(x - 0.5, y - 0.5) - 10 * UNIT) <= STROKE) return true
  return blades.some(([ax, ay, bx, by]) => segmentDistance(x, y, ax, ay, bx, by) <= STROKE)
}

/** RGBA 像素，每像素 4×4 超采样抗锯齿 */
export function iconPixels(size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4)
  const n = 4
  for (let py = 0; py < size; py++) {
    // 背景自上而下由 #27272a 渐变到 #09090b
    const t = py / (size - 1)
    const bg = [39 + (9 - 39) * t, 39 + (9 - 39) * t, 42 + (11 - 42) * t]
    for (let px = 0; px < size; px++) {
      let cover = 0, mark = 0
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = (px + (sx + 0.5) / n) / size, y = (py + (sy + 0.5) / n) / size
          if (!insideBody(x, y)) continue
          cover++
          if (onMark(x, y)) mark++
        }
      }
      const i = (py * size + px) * 4
      if (!cover) continue
      const m = mark / cover
      for (let c = 0; c < 3; c++) out[i + c] = Math.round((bg[c] as number) * (1 - m) + 250 * m)
      out[i + 3] = Math.round((255 * cover) / (n * n))
    }
  }
  return out
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

export function encodePng(pixels: Uint8Array, size: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 6, 0, 0, 0], 8) // 8 位 RGBA，不隔行
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [out, sizeArg] = process.argv.slice(2)
  if (!out) throw new Error('用法：node scripts/desktop/icon.ts <输出.png> [边长]')
  const size = Number(sizeArg ?? 1024)
  writeFileSync(out, encodePng(iconPixels(size), size))
  console.log(`已生成 ${out}（${size}×${size}）`)
}
