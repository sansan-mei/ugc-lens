/**
 * 桌面单文件包的冒烟检查：命令行能启动、能读到内置手册，界面首页和静态资源都能从虚拟文件系统返回。
 * 用法：node scripts/desktop_smoke.ts <可执行文件>
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 首页里引用的同源资源（/assets/...），外部链接不算 */
export function assetPaths(html: string): string[] {
  return [...html.matchAll(/(?:src|href)="(\/[^"/][^"]*)"/g)].map((match) => match[1] as string)
}

async function smoke(exe: string): Promise<void> {
  const run = (args: string[]) => execFileSync(exe, args, { encoding: 'utf8', timeout: 60_000 })
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string
  const printed = run(['--version']).trim()
  if (printed !== version) throw new Error(`--version 输出 ${printed}，期望 ${version}`)
  if (!run(['--help']).includes('ugc-lens')) throw new Error('--help 没有输出用法')
  if (!run(['playbook']).trim()) throw new Error('playbook 没有输出内置手册')
  console.log(`命令行正常：${printed}`)

  const cwd = mkdtempSync(join(tmpdir(), 'ugc-lens-smoke-'))
  const child = spawn(exe, ['ui', '--no-open', '--port', '0', '--cwd', cwd], { stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    const url = await new Promise<string>((done, fail) => {
      let out = ''
      const timer = setTimeout(() => fail(new Error(`界面 30 秒内没有启动，输出：${out}`)), 30_000)
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        const found = out.match(/https?:\/\/127\.0\.0\.1:\d+\/\S*/)
        if (found) { clearTimeout(timer); done(found[0]) }
      })
      child.once('exit', (code) => { clearTimeout(timer); fail(new Error(`界面进程退出（${code}），输出：${out}`)) })
    })
    const page = await fetch(url)
    const html = await page.text()
    if (page.status !== 200 || !html.includes('<div id="root"')) throw new Error(`首页返回 ${page.status}`)
    const assets = assetPaths(html)
    if (!assets.length) throw new Error('首页没有引用静态资源')
    for (const path of assets) {
      const response = await fetch(new URL(path, url))
      await response.arrayBuffer()
      if (response.status !== 200) throw new Error(`${path} 返回 ${response.status}`)
    }
    console.log(`界面正常：首页和 ${assets.length} 个静态资源`)
  } finally {
    child.kill()
    rmSync(cwd, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exe = process.argv[2]
  if (!exe) throw new Error('用法：node scripts/desktop_smoke.ts <可执行文件>')
  await smoke(resolve(exe))
}
