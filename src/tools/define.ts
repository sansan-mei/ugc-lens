import * as z from 'zod'
import type { AgentTool, JsonSchema, ToolContext } from './types.ts'

export interface ToolSpec<S extends z.ZodObject> {
  name: string
  description: string
  /** 一份定义同时用于生成发给模型的 JSON Schema 和校验模型传回的参数 */
  parameters: S
  /** 拿到的是校验通过、已填好默认值的参数 */
  execute(args: z.output<S>, ctx: ToolContext): Promise<string>
}

/** 参数不符合定义。循环会把它和执行失败区分开，提示模型修正参数 */
export class ToolArgumentError extends Error {
  override name = 'ToolArgumentError'
}

const MAX_RECEIVED_CHARS = 100

/** 去掉对模型没有意义、部分提供商还会拒绝的字段 */
function cleanSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSchema)
  if (typeof value !== 'object' || value === null) return value
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === '$schema') continue
    // z.number().int() 会自动带上安全整数范围
    if (key === 'maximum' && item === Number.MAX_SAFE_INTEGER) continue
    if (key === 'minimum' && item === Number.MIN_SAFE_INTEGER) continue
    result[key] = cleanSchema(item)
  }
  return result
}

export function toParametersSchema(schema: z.ZodObject): JsonSchema {
  // io: 'input' 让带默认值的字段在 JSON Schema 里是可选的，和模型的视角一致
  return cleanSchema(z.toJSONSchema(schema, { io: 'input' })) as JsonSchema
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let current = input
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<PropertyKey, unknown>)[key]
  }
  return current
}

function formatReceived(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > MAX_RECEIVED_CHARS ? `${text.slice(0, MAX_RECEIVED_CHARS)}…` : text
}

/** 写给模型看：哪个参数、哪里不对、实际收到了什么，再附上完整的参数格式 */
export function formatArgumentIssues(error: z.ZodError, input: unknown, schema: JsonSchema): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '（整个参数对象）'
    const received = valueAt(input, issue.path)
    if (issue.code === 'invalid_type' && received === undefined) return `- ${path}：缺少必填参数`
    return `- ${path}：${issue.message}（收到：${formatReceived(received)}）`
  })
  return `${lines.join('\n')}\n请按参数格式修正后重试。参数格式：${JSON.stringify(schema)}`
}

export function defineTool<S extends z.ZodObject>(spec: ToolSpec<S>): AgentTool {
  const parameters = toParametersSchema(spec.parameters)
  return {
    name: spec.name,
    description: spec.description,
    parameters,
    async execute(args, ctx) {
      const parsed = spec.parameters.safeParse(args)
      if (!parsed.success) throw new ToolArgumentError(formatArgumentIssues(parsed.error, args, parameters))
      return spec.execute(parsed.data, ctx)
    },
  }
}
