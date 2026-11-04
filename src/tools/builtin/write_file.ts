import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ApprovalDeniedError } from '../approval.ts'
import type { AgentTool } from '../types.ts'
import { requireString, resolvePath } from '../args.ts'

export function createWriteFileTool(): AgentTool {
  return {
    name: 'write_file',
    description:
      '把完整内容写入文本文件，上级目录不存在时自动创建。新建文件直接写入；' +
      '覆盖已有文件前需要用户确认，用户拒绝时会返回错误，此时不要重复尝试覆盖同一个文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对路径以工作目录为基准' },
        content: { type: 'string', description: '要写入的完整内容' },
      },
      required: ['path', 'content'],
    },

    async execute(args, ctx) {
      const path = resolvePath(requireString(args, 'path'), ctx.cwd)
      const content = requireString(args, 'content')
      const bytes = Buffer.byteLength(content)

      const existing = await stat(path).catch(() => undefined)
      if (existing?.isDirectory()) throw new Error(`${path} 是目录，不能写入`)
      if (existing) {
        const approved = await ctx.approve({ kind: 'overwrite_file', path, old_bytes: existing.size, new_bytes: bytes })
        if (!approved) throw new ApprovalDeniedError(`用户拒绝覆盖 ${path}`)
      }

      ctx.signal.throwIfAborted()
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, { signal: ctx.signal })
      return `已${existing ? '覆盖' : '新建'} ${path}（${bytes} 字节）`
    },
  }
}
