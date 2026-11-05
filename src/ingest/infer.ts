import * as z from 'zod'
import type { RunEventListener } from '../agent/events.ts'
import { runAgent, type AgentRunResult } from '../agent/loop.ts'
import type { AgentModel } from '../agent/model.ts'
import { defineTool } from '../tools/define.ts'
import { applyMapping, formatReport, type ApplyResult } from './apply.ts'
import { mappingSchema, type Mapping } from './mapping.ts'
import type { Shape } from './shape.ts'

export type InferOutcome =
  | { type: 'mapping'; mapping: Mapping; result: ApplyResult }
  | { type: 'rejected'; reason: string }

export interface InferOptions {
  model: AgentModel
  data: unknown
  shape: Shape
  file_path: string
  signal?: AbortSignal
  onEvent?: RunEventListener
}

export interface InferResult {
  outcome?: InferOutcome
  run: AgentRunResult
  /** 没有得到结果时，最后一次工具错误，便于说明原因 */
  last_error?: string
}

export const INFER_LIMITS = { maxSteps: 6, maxConsecutiveToolErrors: 3, tokenBudget: 80_000 }

const SYSTEM_PROMPT = `你负责识别一个 JSON 数据文件的结构，告诉程序怎样把其中的用户互动内容（评论、回复、弹幕、回答等）转换成统一格式。
你看不到整个文件，只能看到结构摘要：每行一个路径、类型、数组长度和示例值。路径中 [] 表示数组的元素。

做法：
1. 判断文件来自哪个平台，找出被评论的对象（视频、笔记、问题）和所有互动内容数组。
2. 调用 submit_mapping 提交映射规则。程序会用规则试转换全部数据，并返回每个集合导入了多少条、每个字段的命中率。
3. 如果返回错误，按错误修改规则后重新提交。警告不影响通过，但如果提示有数组没被使用，想一想是否漏掉了弹幕、回复之类的集合。
4. 文件里没有任何用户互动内容（如搜索结果、用户列表）时，调用 reject_file 说明原因。
5. 规则通过或文件被拒绝后，回复“完成”。

注意：
- 集合的 path 指向数组本身，不以 [] 结尾，如 $.comments；文件顶层就是数组时写 $。
- kind：直接评论内容的是 comment，对评论的回复是 reply，弹幕是 danmaku；知乎的回答是 answer，回答下的评论是 comment。
- 文件只有评论、没有内容详情（每条评论带着视频或笔记 ID）时，不写 content，用 fields.content_id 关联。
- 你只负责说明“哪个字段是什么”。时间单位（秒、毫秒、日期字符串）、"1.2万" 这类数字由程序转换，不用在规则里处理。
- 不要编造路径，只用摘要里出现的路径。没有对应字段的项不要写。
- 回复嵌套在评论里时用 children；所有评论在一个数组里、用 parent_id 关联时，写 fields.parent_id。
- 文件里没有内容 ID 但文件路径里有时（如路径中的 BV 号），用 content.id_from_path。`

export async function inferMapping(options: InferOptions): Promise<InferResult> {
  let outcome: InferOutcome | undefined

  const submit = defineTool({
    name: 'submit_mapping',
    description: '提交映射规则。程序会用它试转换全部数据：有错误时返回错误，请修改后重新提交；通过时返回试转换报告。',
    parameters: mappingSchema,
    async execute(mapping) {
      const result = applyMapping(options.data, mapping, { file_path: options.file_path, arrays: options.shape.arrays })
      const report = formatReport(result.report)
      if (result.report.errors.length > 0) throw new Error(`规则没有通过试转换，请修改后重新提交。\n${report}`)
      outcome = { type: 'mapping', mapping, result }
      return `规则已通过。\n${report}\n请回复“完成”。`
    },
  })

  const reject = defineTool({
    name: 'reject_file',
    description: '文件里没有用户互动内容（评论、回复、弹幕、回答）时调用，说明原因。',
    parameters: z.object({ reason: z.string().min(1).describe('为什么这个文件没有互动内容，如“这是搜索结果列表”') }),
    async execute({ reason }) {
      outcome = { type: 'rejected', reason }
      return '已记录。请回复“完成”。'
    },
  })

  const run = await runAgent({
    model: options.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `文件路径：${options.file_path}\n\n结构摘要：\n${options.shape.text}` },
    ],
    tools: [submit, reject],
    limits: INFER_LIMITS,
    signal: options.signal,
    onEvent: options.onEvent,
  })

  const failures = run.steps.flatMap((step) => step.tool_calls.filter((call) => !call.ok))
  return { outcome, run, last_error: outcome ? undefined : failures.at(-1)?.result }
}
