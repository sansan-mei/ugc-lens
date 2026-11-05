import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface MemoryOptions { cwd: string; homeDir?: string; profile?: string; onWarning?: (message: string) => void }
export interface PlaybookInfo { version: number; hash: string }
export interface PlaybookSnapshot extends PlaybookInfo {
  readonly source: string
  readonly text: string
  readonly sections: Readonly<Record<PlaybookStage | 'common', string>>
}
export type PlaybookStage = 'ask' | 'summarize' | 'merge'
const headings = { common: '共同规则', ask: '追问', summarize: '分块总结', merge: '合并' } as const

export function validateMemoryText(text: string): void {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(text)) throw new Error('内容包含不可见控制字符')
  if (/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}|(?:api[_ -]?key|authorization)\s*[:=]\s*\S{12,}/i.test(text)) throw new Error('内容疑似包含密钥，请移除后重试')
  if (/忽略.{0,12}(?:之前|先前|系统|所有).{0,8}(?:指令|规则)|ignore.{0,20}(?:previous|system|all).{0,15}instructions|泄露.{0,10}(?:密钥|提示词)|reveal.{0,15}(?:secret|system prompt)/i.test(text)) throw new Error('内容包含越权指令，请只写分析规则')
}

export function parsePlaybook(text: string, source = 'explicit'): PlaybookSnapshot {
  if (text.length > 4000) throw new Error(`playbook 当前 ${text.length} 字符，上限 4000，超出 ${text.length - 4000}；请查看手册并合并或删除旧规则`)
  validateMemoryText(text)
  const version = Number(text.match(/^版本：[ \t]*(\d+)[ \t]*\r?$/m)?.[1])
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('playbook 需要正整数版本，例如“版本：1”')
  const sections = {} as Record<PlaybookStage | 'common', string>
  const blocks = [...text.matchAll(/^## ([^\r\n]+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)]
  for (const [key, heading] of Object.entries(headings)) {
    const matches = blocks.filter((b) => b[1] === heading)
    if (matches.length !== 1 || !matches[0]![2]!.trim()) throw new Error(`playbook 需要一个非空的“## ${heading}”章节`)
    sections[key as keyof typeof sections] = matches[0]![2]!.replaceAll('\r\n', '\n').trim()
  }
  if (blocks.some((b) => !Object.values(headings).includes(b[1] as typeof headings.common))) throw new Error('playbook 包含未知章节')
  return Object.freeze({ version, hash: createHash('sha256').update(text).digest('hex').slice(0, 12), source, text, sections: Object.freeze(sections) })
}
export const DEFAULT_PLAYBOOK = parsePlaybook(readFileSync(new URL('../../playbook/default.md', import.meta.url), 'utf8'), 'bundled')
export const playbookPath = (memory: MemoryOptions, global = false): string => join(global ? memory.homeDir ?? homedir() : memory.cwd, '.ugc-lens', 'playbook.md')
export function loadPlaybook(memory?: MemoryOptions): PlaybookSnapshot {
  if (!memory) return DEFAULT_PLAYBOOK
  for (const path of [playbookPath(memory), playbookPath(memory, true)]) {
    if (existsSync(path)) return parsePlaybook(readFileSync(path, 'utf8'), path)
  }
  return DEFAULT_PLAYBOOK
}
export function initPlaybook(memory: MemoryOptions, global = false): string {
  const path = playbookPath(memory, global)
  if (existsSync(path)) return path
  const text = global ? DEFAULT_PLAYBOOK.text : loadPlaybook(memory).text
  mkdirSync(join(path, '..'), { recursive: true })
  try { writeFileSync(path, text, { flag: 'wx', mode: 0o600 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return path
}
export function playbookInfo(snapshot: PlaybookInfo): PlaybookInfo { return { version: snapshot.version, hash: snapshot.hash } }
export function playbookRules(snapshot: PlaybookSnapshot, stage: PlaybookStage): string {
  return `[ugc-lens playbook ${JSON.stringify(playbookInfo(snapshot))}]\n${snapshot.sections.common}\n\n${snapshot.sections[stage]}`
}
export function promptPlaybookInfo(prompt: string): PlaybookInfo | undefined {
  const match = prompt.match(/\[ugc-lens playbook (\{[^\n]+\})\]/)
  if (!match) return undefined
  try {
    const value = JSON.parse(match[1]!) as PlaybookInfo
    if (Number.isSafeInteger(value.version) && typeof value.hash === 'string') return playbookInfo(value)
  } catch { /* 外部传入的历史可能不包含本工具的标记。 */ }
  return undefined
}

export type PlaybookChange = { operation: 'add' | 'patch' | 'remove'; section: PlaybookStage | 'common'; text?: string; match?: string }
export interface PlaybookProposal { id: string; base: PlaybookInfo; created_at: string; change: PlaybookChange; text: string }
const pendingPath = (memory: MemoryOptions): string => join(memory.cwd, '.ugc-lens', 'playbook.pending.json')
export function readProposal(memory: MemoryOptions): PlaybookProposal | undefined {
  const path = pendingPath(memory)
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as PlaybookProposal
}
export function proposePlaybook(memory: MemoryOptions, change: PlaybookChange): PlaybookProposal {
  const base = loadPlaybook(memory)
  const old = base.sections[change.section]
  if (!old) throw new Error('未知规则章节')
  let next: string
  if (change.operation === 'add') {
    if (!change.text?.trim()) throw new Error('新增规则不能为空')
    next = `${old}\n${change.text.trim()}`
  } else {
    if (!change.match || old.split(change.match).length !== 2) throw new Error('match 必须在指定章节中恰好匹配一次')
    if (change.operation === 'patch' && !change.text?.trim()) throw new Error('替换内容不能为空')
    next = old.replace(change.match, () => change.operation === 'remove' ? '' : change.text!.trim()).trim()
  }
  const sections = { ...base.sections, [change.section]: next }
  const text = `# ugc-lens 分析手册\n版本：${base.version + 1}\n\n${Object.entries(headings).map(([key, title]) => `## ${title}\n${sections[key as keyof typeof sections]}`).join('\n\n')}\n`
  try { parsePlaybook(text) } catch (error) {
    if (text.length > 4000) throw new Error(`${(error as Error).message}\n现有规则：\n${base.text}`)
    throw error
  }
  const proposal: PlaybookProposal = { id: randomUUID(), base: playbookInfo(base), created_at: new Date().toISOString(), change, text }
  const path = pendingPath(memory)
  mkdirSync(join(path, '..'), { recursive: true })
  try { writeFileSync(path, JSON.stringify(proposal, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('已有待审修改，请先应用或拒绝')
    throw error
  }
  return proposal
}
export function reviewPlaybook(memory: MemoryOptions, id: string, apply: boolean): string {
  const proposal = readProposal(memory)
  if (!proposal || proposal.id !== id) throw new Error('待审修改 ID 不匹配')
  if (apply) {
    if (loadPlaybook(memory).hash !== proposal.base.hash) throw new Error('规则已被编辑，待审修改已过期；请拒绝后重新提出')
    parsePlaybook(proposal.text)
    const path = playbookPath(memory)
    const temp = `${path}.${randomUUID()}.tmp`
    writeFileSync(temp, proposal.text, { flag: 'wx', mode: 0o600 })
    try { renameSync(temp, path) } catch (error) { unlinkSync(temp); throw error }
  }
  unlinkSync(pendingPath(memory))
  return apply ? playbookPath(memory) : '已拒绝待审修改'
}
