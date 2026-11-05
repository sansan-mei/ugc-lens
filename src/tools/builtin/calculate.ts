import * as z from 'zod'
import { defineTool } from '../define.ts'
import type { AgentTool } from '../types.ts'

const OPERATIONS = {
  add: (a: number, b: number) => a + b,
  subtract: (a: number, b: number) => a - b,
  multiply: (a: number, b: number) => a * b,
  divide: (a: number, b: number) => {
    if (b === 0) throw new Error('除数不能为 0')
    return a / b
  },
  power: (a: number, b: number) => a ** b,
  mod: (a: number, b: number) => {
    if (b === 0) throw new Error('取余的除数不能为 0')
    return a % b
  },
} as const

type Operation = keyof typeof OPERATIONS

export function createCalculateTool(): AgentTool {
  return defineTool({
    name: 'calculate',
    description: '对两个数做一次精确的四则运算、乘方或取余，返回结果。需要多步计算时多次调用。',
    parameters: z.object({
      operation: z.enum(Object.keys(OPERATIONS) as [Operation, ...Operation[]]).describe('运算类型'),
      a: z.number().describe('第一个数'),
      b: z.number().describe('第二个数'),
    }),

    async execute({ operation, a, b }) {
      const result = OPERATIONS[operation](a, b)
      if (!Number.isFinite(result)) throw new Error(`结果不是有限数：${result}`)
      return String(result)
    },
  })
}
