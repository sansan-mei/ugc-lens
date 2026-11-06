import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import type { ApprovalRequest, Approver } from '../tools/approval.ts'

export function describeApproval(request: ApprovalRequest): string {
  switch (request.kind) {
    case 'run_command':
      return `执行命令\n  $ ${request.command}\n  目录：${request.cwd}`
    case 'overwrite_file':
      return `覆盖文件\n  ${request.path}\n  原大小 ${request.old_bytes} 字节 → 新大小 ${request.new_bytes} 字节`
    case 'after_web':
      return `本对话已读取外部网页，模型请求写入本地记录\n  工具：${request.tool}\n  网页内容可能包含诱导指令，确认内容来自你本人的要求后再允许`
  }
}

export interface ConsoleApproverOptions {
  input?: Readable
  output?: Writable
}

/** 在命令行里逐条询问 y/N，只有明确输入 y 或 yes 才算允许 */
export function createConsoleApprover(options: ConsoleApproverOptions = {}): Approver {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout

  return async (request) => {
    // 每次新建、用完关闭，否则 readline 会一直占着 stdin，进程无法退出
    const rl = createInterface({ input, output, terminal: false })
    // 输入流结束（如 stdin 被关闭）时 question 不会返回也不会报错，必须单独监听 close
    const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)))
    const question = rl.question(`\n需要确认：${describeApproval(request)}\n允许吗？[y/N] `).catch(() => null)
    try {
      const answer = await Promise.race([question, closed])
      return answer !== null && /^(y|yes)$/i.test(answer.trim())
    } finally {
      rl.close()
    }
  }
}
