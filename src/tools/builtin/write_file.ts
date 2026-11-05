import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import * as z from 'zod'
import { ApprovalDeniedError } from '../approval.ts'
import { defineTool } from '../define.ts'
import { resolvePath } from '../paths.ts'
import type { AgentTool } from '../types.ts'

export function createWriteFileTool(): AgentTool {
  return defineTool({
    name: 'write_file',
    description:
      '把完整内容写入文本文件，上级目录不存在时自动创建。新建文件直接写入；' +
      '覆盖已有文件前需要用户确认，用户拒绝时会返回错误，此时不要重复尝试覆盖同一个文件。',
    parameters: z.object({
      path: z.string().min(1).describe('文件路径，相对路径以工作目录为基准'),
      content: z.string().describe('要写入的完整内容'),
    }),

    async execute(args, ctx) {
      const path = resolvePath(args.path, ctx.cwd)
      const bytes = Buffer.byteLength(args.content)

      const existing = await stat(path).catch(() => undefined)
      if (existing?.isDirectory()) throw new Error(`${path} 是目录，不能写入`)
      if (existing) {
        const approved = await ctx.approve({ kind: 'overwrite_file', path, old_bytes: existing.size, new_bytes: bytes })
        if (!approved) throw new ApprovalDeniedError(`用户拒绝覆盖 ${path}`)
      }

      ctx.signal.throwIfAborted()
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, args.content, { signal: ctx.signal })
      return `已${existing ? '覆盖' : '新建'} ${path}（${bytes} 字节）`
    },
  })
}
