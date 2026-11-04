import type { ToolDefinition } from '../llm/types.ts'

export type JsonSchema = Record<string, unknown>

export interface ToolContext {
  run_id: string
  /** 运行被取消或超时时触发，耗时长的工具应该监听它 */
  signal: AbortSignal
}

export interface AgentTool {
  /** snake_case，如 search_feedback */
  name: string
  /** 写给模型看：做什么、什么时候用、返回什么 */
  description: string
  /** 参数的 JSON Schema。第 5 步改为由 Zod 生成 */
  parameters: JsonSchema
  /** 返回给模型的文本。抛出的错误会被循环捕获，作为错误结果返回给模型 */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>
}

export function toToolDefinition(tool: AgentTool): ToolDefinition {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }
}
