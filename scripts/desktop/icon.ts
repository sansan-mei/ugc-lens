/**
 * 桌面版应用图标：深色圆角方块上，一枚白色放大镜罩着三行“评论”，三行分别用界面里情感分布的正面、中性偏黄、负面三色，
 * 表达“从原文里看清反馈”。用纯 Node 画成 PNG / ICO，不引入图形依赖，也不在仓库里放二进制文件；
 * macOS 打包时再用 sips、iconutil 转成 .icns，Windows 安装包直接用 .ico。
 * 用法：node scripts/desktop/icon.ts <输出.png|输出.ico> [PNG 边长，默认 1024]
 */
import { writeFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

type Rgb = readonly [number, number, number]

/** macOS 图标网格：主体占约 80%，圆角约为主体边长的 22.5% */
const MARGIN = 0.1
const RADIUS = 0.8 * 0.225
// 以下坐标都是边长的比例
const LENS = { x: 0.445, y: 0.435, r: 0.19, half: 0.032 }
const HANDLE = { ax: LENS.x + (LENS.r + 0.02) * Math.SQRT1_2, ay: LENS.y + (LENS.r + 0.02) * Math.SQRT1_2, bx: 0.71, by: 0.70, half: 0.046 }
const BAR_HALF = 0.021
const BARS: ReadonlyArray<{ y: number; x1: number; x2: number; color: Rgb }> = [
  { y: LENS.y - 0.062, x1: 0.34, x2: 0.53, color: [52, 199, 123] },
  { y: LENS.y, x1: 0.34, x2: 0.465, color: [245, 177, 61] },
  { y: LENS.y + 0.062, x1: 0.34, x2: 0.5, color: [242, 85, 90] },
]
const WHITE: Rgb = [250, 250, 250]

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

function insideBody(x: number, y: number): boolean {
  const lo = MARGIN + RADIUS, hi = 1 - MARGIN - RADIUS
  const cx = Math.max(lo, Math.min(hi, x)), cy = Math.max(lo, Math.min(hi, y))
  return Math.hypot(x - cx, y - cy) <= RADIUS
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** 主体内某一点的颜色：背景渐变 → 镜片 → 三行评论 → 镜框和手柄 */
function colorAt(x: number, y: number): Rgb {
  // 自上而下 #2c2c31 → #0a0a0c，左上角加一点柔光
  let c = mix([44, 44, 49], [10, 10, 12], (y - MARGIN) / (1 - 2 * MARGIN))
  c = mix(c, WHITE, 0.07 * Math.max(0, 1 - Math.hypot(x - 0.28, y - 0.2) / 0.55))
  const d = Math.hypot(x - LENS.x, y - LENS.y)
  if (d < LENS.r) c = mix(c, WHITE, 0.08)
  for (const bar of BARS) if (segmentDistance(x, y, bar.x1, bar.y, bar.x2, bar.y) <= BAR_HALF) c = bar.color
  if (Math.abs(d - LENS.r) <= LENS.half) c = WHITE
  if (segmentDistance(x, y, HANDLE.ax, HANDLE.ay, HANDLE.bx, HANDLE.by) <= HANDLE.half) c = WHITE
  return c
}

/** RGBA 像素，每像素 4×4 超采样抗锯齿 */
export function iconPixels(size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4)
  const n = 4
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let cover = 0
      const sum = [0, 0, 0]
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = (px + (sx + 0.5) / n) / size, y = (py + (sy + 0.5) / n) / size
          if (!insideBody(x, y)) continue
          cover++
          const c = colorAt(x, y)
          for (let k = 0; k < 3; k++) sum[k]! += c[k]!
        }
      }
      if (!cover) continue
      const i = (py * size + px) * 4
      for (let k = 0; k < 3; k++) out[i + k] = Math.round(sum[k]! / cover)
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

/** Windows 资源管理器、任务栏、开始菜单会用到的尺寸 */
export const ICO_SIZES: readonly number[] = [16, 24, 32, 48, 64, 128, 256]

/** ICO 容器，每个尺寸内嵌一张 PNG（Windows Vista 起支持） */
export function encodeIco(images: ReadonlyArray<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, i) => {
    const entry = 6 + i * 16
    header[entry] = size % 256 // 256 记为 0
    header[entry + 1] = size % 256
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map((image) => image.png)])
}

export function iconFile(path: string, size = 1024): Buffer {
  const ext = extname(path).toLowerCase()
  if (ext === '.png') return encodePng(iconPixels(size), size)
  if (ext === '.ico') return encodeIco(ICO_SIZES.map((s) => ({ size: s, png: encodePng(iconPixels(s), s) })))
  throw new Error(`只支持输出 .png 或 .ico，收到 ${path}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [out, sizeArg] = process.argv.slice(2)
  if (!out) throw new Error('用法：node scripts/desktop/icon.ts <输出.png|输出.ico> [PNG 边长]')
  writeFileSync(out, iconFile(out, Number(sizeArg ?? 1024)))
  console.log(`已生成 ${out}`)
}
