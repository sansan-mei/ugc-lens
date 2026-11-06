/** 需要用户确认的操作。新增种类时，命令行的确认提示也要对应补上 */
export type ApprovalRequest =
  | { kind: 'run_command'; command: string; cwd: string }
  | { kind: 'overwrite_file'; path: string; old_bytes: number; new_bytes: number }
  /** 对话已读取联网内容后，写入画像、经验或手册等本地记录 */
  | { kind: 'after_web'; tool: string }

/** 返回 true 表示允许。由入口层（命令行、图形界面、代码调用方）提供 */
export type Approver = (request: ApprovalRequest) => Promise<boolean>

/** 没有提供确认函数时使用：一律拒绝 */
export const denyAll: Approver = async () => false

export class ApprovalDeniedError extends Error {
  override name = 'ApprovalDeniedError'
}
