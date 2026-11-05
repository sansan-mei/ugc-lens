/**
 * 发布前编译：src/ → dist/。
 * tsc 会把 .js 里的 "./x.ts" 改成 "./x.js"，但 .d.ts 里保持 "./x.ts"，
 * 使用者的 TypeScript 按这个路径找不到文件，所以这里再改一遍声明文件。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RELATIVE_TS = /((?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g

/** 只改相对路径的导入，包名里的 .ts 不动 */
export function fixDeclarationImports(text: string): string {
  return text.replace(RELATIVE_TS, '$1$2$3.js$2')
}

function build(): void {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const dist = join(root, 'dist')
  rmSync(dist, { recursive: true, force: true })
  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' })

  let changed = 0
  for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue
    const file = join(entry.parentPath, entry.name)
    const text = readFileSync(file, 'utf8')
    const fixed = fixDeclarationImports(text)
    if (fixed !== text) {
      writeFileSync(file, fixed)
      changed++
    }
  }
  console.log(`已编译到 dist/，修正了 ${changed} 个声明文件里的导入路径`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) build()
