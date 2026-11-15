import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (name: string) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8')
/** 取出某个顶层 job 的文本（到下一个两格缩进的 job 名为止） */
function job(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  assert.ok(start >= 0, `找不到 job ${name}`)
  const rest = workflow.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

test('桌面打包工作流可以被发版工作流调用', () => {
  const desktop = read('desktop.yml')
  const triggers = desktop.slice(desktop.indexOf('\non:'), desktop.indexOf('\npermissions:'))
  assert.match(triggers, /\n {2}workflow_call:/)
})

test('发版：版本号变化时构建桌面包，并把 dmg 和 Windows 安装包挂到同版本的 GitHub Release', () => {
  const release = read('release.yml')
  const desktop = read('desktop.yml')
  const build = job(release, 'desktop')
  assert.match(build, /uses: \.\/\.github\/workflows\/desktop\.yml/)
  assert.match(build, /needs: publish/)
  assert.match(build, /if: needs\.publish\.outputs\.desktop == 'true'/)
  // 发布检查要给出 desktop 输出：Release 上还没有桌面包时为 true，npm 已发布后重跑也能补上
  assert.match(job(release, 'publish'), /desktop: \$\{\{ steps\.version\.outputs\.desktop \}\}/)
  assert.match(job(release, 'publish'), /gh release view/)

  const upload = job(release, 'github-release')
  assert.match(upload, /needs: \[publish, desktop\]/)
  // 下载的产物名与桌面打包上传的一致
  const uploaded = desktop.match(/name: (ugc-lens-)\$\{\{ matrix\.target \}\}/)
  assert.ok(uploaded)
  assert.match(upload, new RegExp(`pattern: ${uploaded[1]}\\*`))
  assert.match(upload, /\.dmg/)
  assert.match(upload, /-setup\.exe/)
  // 标签与 npm 发版一致，都取自 package.json 的版本号
  assert.match(upload, /v\$\{\{ needs\.publish\.outputs\.version \}\}/)
  assert.match(upload, /gh release create/)
  assert.match(upload, /gh release upload/)
  assert.match(upload, /--clobber/)
})

test('工作流里引用的 action 都固定到完整版本号', () => {
  for (const name of ['ci.yml', 'desktop.yml', 'release.yml']) {
    for (const [, ref] of read(name).matchAll(/uses: [\w-]+\/[\w-]+@(\S+)/g)) assert.match(ref!, /^v\d+\.\d+\.\d+$/, `${name}: @${ref}`)
  }
})
