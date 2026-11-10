import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const skillsDir = join(root, 'skills')
const skillNames = readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)

/** 只解析本仓库技能用到的单行 `key: value` 头部字段，嵌套字段按原文保留。 */
function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  assert.ok(match, 'SKILL.md 必须以 YAML frontmatter 开头')
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split('\n')) {
    const field = /^([a-z-]+):\s*(.*)$/.exec(line)
    if (field) fields[field[1]!] = field[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  return { fields, body: match[2]! }
}

test('技能目录：至少包含 ugc-lens 与无需安装的引用分析技能', () => {
  assert.ok(skillNames.includes('ugc-lens'))
  assert.ok(skillNames.includes('cited-feedback-analysis'))
})

for (const name of skillNames) {
  test(`技能 ${name}：frontmatter 符合 Agent Skills 规范`, () => {
    const { fields } = frontmatter(readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8'))
    assert.equal(fields.name, name, 'name 必须与目录名一致')
    assert.match(fields.name!, /^[a-z0-9]+(-[a-z0-9]+)*$/)
    assert.ok(fields.name!.length <= 64)
    assert.ok(fields.description && fields.description.length <= 1024, 'description 必填且不超过 1024 字符')
    if (fields.compatibility !== undefined) assert.ok(fields.compatibility.length <= 500)
  })

  test(`技能 ${name}：正文引用的相对文件都存在`, () => {
    const { body } = frontmatter(readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8'))
    const links = [...body.matchAll(/\]\(([^)#\s]+)\)/g)].map((m) => m[1]!).filter((href) => !/^[a-z]+:/i.test(href))
    const paths = [...body.matchAll(/\b((?:scripts|references|assets)\/[\w./-]+\.\w+)/g)].map((m) => m[1]!)
    for (const path of new Set([...links, ...paths])) assert.ok(existsSync(join(skillsDir, name, path)), `${name} 引用了不存在的 ${path}`)
  })
}

test('技能随 npm 包发布', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files?: string[] }
  assert.ok(pkg.files?.includes('skills'))
})

test('ugc-lens 技能说明了未连接 MCP 时的准备和命令行退路', () => {
  const { body } = frontmatter(readFileSync(join(skillsDir, 'ugc-lens', 'SKILL.md'), 'utf8'))
  assert.match(body, /ugc-lens init/)
  assert.match(body, /claude mcp add/)
  assert.match(body, /ugc-lens analyze/)
  assert.match(body, /cited-feedback-analysis/)
})
