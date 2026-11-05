import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { configureProfile, learnProfile, loadProfile, profilePath } from '../memory/profile.ts'
import type { MemoryOptions } from '../memory/playbook.ts'
import { loadLlmConfig } from '../config.ts'
import { analysisModel, UsageError } from './common.ts'

export const PROFILE_USAGE = `用法：ugc-lens profile [选项]
默认查看本地关注点与画像（初始开启），不需要模型。
  --enable / --disable   开启或关闭历史学习及画像读取
  --set <键> --text <值>  用户修正，优先于自动学习
  --project              修正只适用于当前项目，默认全局
  --confirm <ID>         确认候选条目
  --delete <ID>          删除条目及相关修订，阻止旧历史重学
  --clear                清空画像及修订并关闭学习
  --learn <文件>         从明确选择的用户历史 TXT 学习（每个空行分段，需先 enable）`

export async function runProfile(argv: readonly string[], memory: MemoryOptions = { cwd: process.cwd() }) {
  const { values, positionals } = parseArgs({ args: [...argv], options: { enable: { type: 'boolean' }, disable: { type: 'boolean' }, clear: { type: 'boolean' }, delete: { type: 'string' }, confirm: { type: 'string' }, set: { type: 'string' }, text: { type: 'string' }, project: { type: 'boolean' }, learn: { type: 'string' } } })
  const actions = ['enable', 'disable', 'clear', 'delete', 'confirm', 'set', 'learn'] as const
  const selected = actions.filter((a) => values[a] !== undefined)
  if (positionals.length || selected.length > 1 || (values.text !== undefined && !values.set) || (values.project && !values.set)) throw new UsageError('一次选择一个画像操作；text 和 project 仅用于 set')
  const action = selected[0]
  if (action === 'learn') {
    if (!loadProfile(memory).enabled) throw new UsageError('请先 profile --enable')
    const file = resolve(memory.cwd, values.learn!)
    if (statSync(file).size > 100_000) throw new UsageError('历史文件上限 100 KB')
    const text = readFileSync(file, 'utf8')
    if (text.length > 20_000) throw new UsageError('历史文件上限 20000 字符，请分文件导入')
    const paragraphs = text.split(/\r?\n\s*\r?\n/).filter((p) => p.trim())
    if (paragraphs.length > 20 || paragraphs.some((p) => p.length > 4000)) throw new UsageError('每次最多 20 段用户发言，每段最多 4000 字符，请分文件导入')
    const model = analysisModel(loadLlmConfig({}, memory.cwd))
    const results = []
    for (const paragraph of paragraphs) results.push(await learnProfile(memory, model, paragraph))
    console.log(JSON.stringify({ path: profilePath(memory), results }, null, 2)); return
  }
  if (action) { console.log(configureProfile(memory, action, { id: values.delete ?? values.confirm, key: values.set, text: values.text, scope: values.project ? 'project' : 'global' })); return }
  console.log(JSON.stringify({ path: profilePath(memory), ...loadProfile(memory) }, null, 2))
}
