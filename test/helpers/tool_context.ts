import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalRequest, Approver } from '../../src/tools/approval.ts'
import type { ToolContext } from '../../src/tools/types.ts'

/** 记录每次确认请求，并按预设回答 */
export function recordingApprover(answer: boolean): Approver & { requests: ApprovalRequest[] } {
  const requests: ApprovalRequest[] = []
  const approver = async (request: ApprovalRequest) => {
    requests.push(request)
    return answer
  }
  return Object.assign(approver, { requests })
}

/** 临时工作目录 + 工具上下文，结束时调用 cleanup 删除目录 */
export function toolSandbox(options: { approve?: Approver; signal?: AbortSignal } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ugc-lens-tool-'))
  const ctx: ToolContext = {
    run_id: 'test-run',
    signal: options.signal ?? new AbortController().signal,
    cwd: dir,
    approve: options.approve ?? (async () => false),
  }
  return { dir, ctx, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
