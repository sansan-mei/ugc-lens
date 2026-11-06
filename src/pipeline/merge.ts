import { completeTracked, currentTask, withTask, TaskBudgetError } from '../agent/usage.ts'
import { DEFAULT_PLAYBOOK, playbookRules, type PlaybookSnapshot } from '../memory/playbook.ts'
import * as z from 'zod'
import type { AgentModel } from '../agent/model.ts'
import type { ChatMessage, ToolDefinition, Usage } from '../llm/types.ts'
import { toParametersSchema } from '../tools/define.ts'
import { rejectsToolChoice, type Finding, type FindingRef } from './summarize.ts'

export interface Theme {
  direction: string
  title: string
  /** 来源观点的 support 之和，是模型估计的条数 */
  support: number
  /** 来源观点的引用，按 ID 去重 */
  refs: FindingRef[]
  /** 来源观点在 findings 里的下标，含子主题的 */
  sources: number[]
  /** 最多一层 */
  children: Theme[]
}

export interface MergeOptions {
  playbook?: PlaybookSnapshot
  model: AgentModel
  findings: readonly Finding[]
  /** 和分块总结用的方向相同，顺序决定报告里的顺序 */
  directions: readonly string[]
  /** 支持条数少于这个数的主题和子主题去掉，默认 2 */
  minSupport?: number
  signal?: AbortSignal
}

export interface MergeResult {
  themes: Theme[]
  /** 是否调用了模型：观点都来自同一块或只有一条时不调用 */
  called: boolean
  usage?: Usage
  /** 合并调用失败的原因；失败时每个观点单独成为主题 */
  error?: string
  /** 模型给出的不存在、方向不符或重复使用的观点编号 */
  invalid_refs: number
}

const TOOL_NAME = 'submit_themes'

const SYSTEM_PROMPT = `下面是从一批用户内容里分块找出的观点。因为是分块找的，不同块里常有说同一件事的观点。
每行一个观点：F编号 [方向编号] 结论｜纳入标准｜约多少条。

任务：把说同一件事的观点合并成主题，调用 ${TOOL_NAME} 一次性提交。
要求：
- 每个主题：direction 填方向编号；title 概括合并后的结论，不超过 30 字；findings 列出合并进来的观点编号。
- 主题里有明显不同的几个方面时，可以用 children 分成子主题（只分一层），子主题的观点不要再写进上一级的 findings。
- 每个观点只能用一次。`

const looseNumber = z.union([z.number(), z.string()]).transform((value) => {
  const n = typeof value === 'number' ? value : Number(value.match(/\d+/)?.[0])
  return Number.isInteger(n) ? n : undefined
})
const looseGroup = z.object({ title: z.string().trim().min(1), findings: z.array(looseNumber).nullish() })
const looseTheme = looseGroup.extend({ direction: looseNumber, children: z.array(looseGroup).nullish() })

function toolDefinition(directions: number): ToolDefinition {
  const group = {
    title: z.string().describe('概括合并后的结论，不超过 30 字'),
    findings: z.array(z.number().int()).describe('合并进来的观点编号（F 后面的数字）'),
  }
  const schema = z.object({
    themes: z.array(
      z.object({
        direction: z.number().int().min(1).max(directions).describe('方向编号'),
        ...group,
        children: z.array(z.object(group)).optional().describe('子主题，只分一层；没有就不写'),
      }),
    ),
  })
  return { type: 'function', function: { name: TOOL_NAME, description: '提交合并后的主题。只调用一次。', parameters: toParametersSchema(schema) } }
}

export function findingLines(findings: readonly Finding[], directions: readonly string[]): string {
  return findings
    .map((f, i) => `F${i + 1} [${directions.indexOf(f.direction) + 1}] ${f.title}｜${f.criteria}｜约${f.support}条`)
    .join('\n')
}

function buildTheme(direction: string, title: string, sources: number[], findings: readonly Finding[], children: Theme[] = []): Theme {
  const all = [...sources, ...children.flatMap((child) => child.sources)]
  const refs = new Map<string, FindingRef>()
  for (const index of all) {
    for (const ref of findings[index]!.refs) {
      const known = refs.get(ref.id)
      if (!known) refs.set(ref.id, { ...ref })
      else if (!known.quote && ref.quote) known.quote = ref.quote
    }
  }
  return {
    direction,
    title,
    support: all.reduce((sum, index) => sum + findings[index]!.support, 0),
    refs: [...refs.values()],
    sources: all,
    children,
  }
}

function standalone(findings: readonly Finding[], indexes: Iterable<number>): Theme[] {
  return [...indexes].map((i) => buildTheme(findings[i]!.direction, findings[i]!.title, [i], findings))
}

/** 子主题太少时并回上一级；只剩一个子主题时不再分层 */
function finish(themes: Theme[], directions: readonly string[], minSupport: number): Theme[] {
  const bySupport = (a: Theme, b: Theme) => b.support - a.support
  return themes
    .map((theme) => {
      const children = theme.children.filter((child) => child.support >= minSupport).sort(bySupport)
      return { ...theme, children: children.length >= 2 ? children : [] }
    })
    .filter((theme) => theme.support >= minSupport)
    .sort((a, b) => directions.indexOf(a.direction) - directions.indexOf(b.direction) || bySupport(a, b))
}

/** 校验模型的分组：编号必须存在、方向一致、只用一次；漏掉的观点单独成为主题 */
export function parseThemes(
  args: unknown,
  findings: readonly Finding[],
  directions: readonly string[],
): { themes: Theme[]; invalid_refs: number } {
  const raw = (args as { themes?: unknown } | null)?.themes
  if (!Array.isArray(raw)) throw new Error('参数里没有 themes 数组')
  const used = new Set<number>()
  let invalid = 0
  const take = (direction: string, numbers: ReadonlyArray<number | undefined> | null | undefined): number[] => {
    const result: number[] = []
    for (const n of numbers ?? []) {
      const index = n === undefined ? -1 : n - 1
      if (!findings[index] || findings[index].direction !== direction || used.has(index)) invalid++
      else {
        used.add(index)
        result.push(index)
      }
    }
    return result
  }

  const themes: Theme[] = []
  for (const item of raw) {
    const parsed = looseTheme.safeParse(item)
    const direction = parsed.success && parsed.data.direction !== undefined ? directions[parsed.data.direction - 1] : undefined
    if (!parsed.success || direction === undefined) continue
    const own = take(direction, parsed.data.findings)
    const children = (parsed.data.children ?? [])
      .map((child) => ({ title: child.title, sources: take(direction, child.findings) }))
      .filter((child) => child.sources.length > 0)
      .map((child) => buildTheme(direction, child.title, child.sources, findings))
    if (own.length === 0 && children.length === 0) continue
    themes.push(buildTheme(direction, parsed.data.title, own, findings, children))
  }
  const left = findings.map((_, i) => i).filter((i) => !used.has(i))
  return { themes: [...themes, ...standalone(findings, left)], invalid_refs: invalid }
}

export async function mergeFindings(options: MergeOptions): Promise<MergeResult> {
  if (!currentTask()) return withTask(() => mergeFindings(options))
  const { findings, directions } = options
  const minSupport = options.minSupport ?? 2
  const all = findings.map((_, i) => i)
  if (findings.length <= 1 || new Set(findings.map((f) => f.chunk)).size <= 1) {
    return { themes: finish(standalone(findings, all), directions, minSupport), called: false, invalid_refs: 0 }
  }

  const tool = toolDefinition(directions.length)
  const messages: ChatMessage[] = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${playbookRules(options.playbook ?? DEFAULT_PLAYBOOK, 'merge')}\n\n方向：\n${directions.map((d, i) => `${i + 1}. ${d}`).join('\n')}` },
    { role: 'user', content: findingLines(findings, directions) },
  ]
  const signal = options.signal ?? new AbortController().signal
  const call = (forced: boolean) =>
    completeTracked(options.model, { messages, tools: [tool], toolChoice: forced ? { type: 'function', function: { name: TOOL_NAME } } : 'auto', signal }, 'merge')

  let usage: Usage | undefined
  try {
    let result
    try {
      result = await call(true)
    } catch (error) {
      if (!rejectsToolChoice(error)) throw error
      result = await call(false)
    }
    usage = result.usage
    if (result.finishReason === 'length') throw new Error('输出达到 max_tokens 被截断')
    const toolCall = result.message.tool_calls?.find((item) => item.function.name === TOOL_NAME)
    if (!toolCall) throw new Error(`模型没有调用 ${TOOL_NAME}`)
    let args: unknown
    try {
      args = JSON.parse(toolCall.function.arguments)
    } catch {
      throw new Error('参数不是合法的 JSON')
    }
    const parsed = parseThemes(args, findings, directions)
    return { themes: finish(parsed.themes, directions, minSupport), called: true, usage, invalid_refs: parsed.invalid_refs }
  } catch (error) {
    if (signal.aborted) throw error
    return {
      themes: finish(standalone(findings, all), directions, minSupport),
      called: !(error instanceof TaskBudgetError),
      usage,
      error: (error as Error).message,
      invalid_refs: 0,
    }
  }
}
