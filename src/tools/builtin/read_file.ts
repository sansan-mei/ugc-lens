import { readFile, stat } from 'node:fs/promises'
import type { AgentTool } from '../types.ts'
import { optionalInteger, requireString, resolvePath } from '../args.ts'

export interface ReadFileOptions {
  /** 返回给模型的最大字符数 */
  maxOutputChars?: number
  maxFileBytes?: number
  defaultLimit?: number
}

const MAX_LINE_CHARS = 2_000

export function createReadFileTool(options: ReadFileOptions = {}): AgentTool {
  const maxOutputChars = options.maxOutputChars ?? 10_000
  const maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024
  const defaultLimit = options.defaultLimit ?? 500

  return {
    name: 'read_file',
    description:
      '读取文本文件内容，每行前面带行号。文件较长时分段读取：返回结果末尾会提示下一段的 offset。' +
      '只能读取文本文件；查看目录内容请用 run_command 执行 ls。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对路径以工作目录为基准' },
        offset: { type: 'integer', minimum: 1, description: '从第几行开始读，默认 1' },
        limit: { type: 'integer', minimum: 1, description: `最多读多少行，默认 ${defaultLimit}` },
      },
      required: ['path'],
    },

    async execute(args, ctx) {
      const path = resolvePath(requireString(args, 'path'), ctx.cwd)
      const offset = optionalInteger(args, 'offset', 1) ?? 1
      const limit = optionalInteger(args, 'limit', 1) ?? defaultLimit

      const info = await stat(path).catch(() => undefined)
      if (!info) throw new Error(`文件不存在：${path}`)
      if (info.isDirectory()) throw new Error(`${path} 是目录，请用 run_command 执行 ls 查看`)
      if (info.size > maxFileBytes) {
        const mb = (info.size / 1024 / 1024).toFixed(1)
        throw new Error(`文件过大（${mb} MB），请用 run_command 配合 head、rg 等命令查看部分内容`)
      }

      const buffer = await readFile(path, { signal: ctx.signal })
      if (buffer.subarray(0, 8_000).includes(0)) throw new Error(`${path} 看起来是二进制文件，无法按文本读取`)

      const lines = buffer.toString('utf8').split(/\r?\n/)
      if (lines.at(-1) === '') lines.pop()
      const total = lines.length
      if (total === 0) return `文件：${path}\n（空文件）`
      if (offset > total) throw new Error(`offset=${offset} 超出范围，文件共 ${total} 行`)

      const body: string[] = []
      let chars = 0
      let last = offset - 1
      for (let index = offset - 1; index < total && index < offset - 1 + limit; index++) {
        let line = lines[index] ?? ''
        if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}…（本行已截断）`
        const formatted = `${index + 1}| ${line}`
        // 至少返回一行，否则模型永远读不到超长的那一行
        if (body.length > 0 && chars + formatted.length > maxOutputChars) break
        body.push(formatted)
        chars += formatted.length + 1
        last = index + 1
      }

      const header = `文件：${path}（共 ${total} 行，显示第 ${offset}-${last} 行）`
      const footer = last < total ? `\n（还有 ${total - last} 行未显示，用 offset=${last + 1} 继续读取）` : ''
      return `${header}\n${body.join('\n')}${footer}`
    },
  }
}
