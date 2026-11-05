import { parseArgs } from 'node:util'
import { initPlaybook, loadPlaybook, readProposal, reviewPlaybook, type MemoryOptions } from '../memory/playbook.ts'
import { UsageError } from './common.ts'

export const PLAYBOOK_USAGE = `用法：ugc-lens playbook [选项]

默认显示当前生效手册、来源和待审修改。
  --init          创建项目 .ugc-lens/playbook.md（已有文件不覆盖）
  --apply <ID>    应用待审修改，下次分析或新会话生效
  --reject <ID>   丢弃待审修改`

export async function runPlaybook(argv: readonly string[], memory: MemoryOptions = { cwd: process.cwd() }): Promise<void> {
  const { values, positionals } = parseArgs({ args: [...argv], options: { init: { type: 'boolean' }, apply: { type: 'string' }, reject: { type: 'string' } } })
  if (positionals.length || [values.init, values.apply, values.reject].filter((v) => v !== undefined).length > 1) throw new UsageError('一次只能选择 init、apply 或 reject 中的一项')
  if (values.init) { console.log(`项目手册：${initPlaybook(memory)}`); return }
  if (values.apply !== undefined || values.reject !== undefined) {
    console.log(reviewPlaybook(memory, values.apply ?? values.reject!, values.apply !== undefined))
    return
  }
  const current = loadPlaybook(memory)
  console.log(`来源：${current.source}\n版本：${current.version}，指纹：${current.hash}\n\n${current.text}`)
  const pending = readProposal(memory)
  if (pending) console.log(`\n待审修改：${pending.id}\n基于：${pending.base.version} / ${pending.base.hash}\n\n${pending.text}\n应用：ugc-lens playbook --apply ${pending.id}\n拒绝：ugc-lens playbook --reject ${pending.id}`)
}
