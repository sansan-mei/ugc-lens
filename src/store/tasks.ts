import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import * as z from 'zod'

// 旧记录的 cached_input_tokens 总是数字；新记录未返回缓存字段时省略它，并记录未知次数
const usageSchema = z.object({ input_tokens: z.number(), output_tokens: z.number(), cached_input_tokens: z.number().optional(), cached_unreported_calls: z.number().optional() })

const taskUsageSchema = z.object({
  task_id: z.string(), token_budget: z.number(), known_tokens: z.number(), unknown_estimated_tokens: z.number(), unknown_calls: z.number(),
  calls: z.array(z.object({ id: z.string(), stage: z.string(), final: z.boolean(), status: z.enum(['pending', 'ok', 'failed']), input_tokens: z.number().nullable(), output_tokens: z.number().nullable() })),
  web: z.object({ searches: z.number(), fetches: z.number(), bytes: z.number(), cache_hits: z.number() }).optional(),
})

const taskSchema = z.object({
  /** 绝对路径，也是任务的唯一标识 */
  file: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  added_at: z.string(),
  started_at: z.string().optional(),
  finished_at: z.string().optional(),
  report: z.string().optional(),
  calls: z.number().optional(),
  usage: usageSchema.optional(),
  task_usage: taskUsageSchema.optional(),
  error: z.string().optional(),
})

const fileSchema = z.object({ version: z.literal(1), tasks: z.array(taskSchema) })

export type Task = z.output<typeof taskSchema>
export type TaskStatus = Task['status']

export interface TaskStore {
  readonly path: string
  list(): Task[]
  get(file: string): Task | undefined
  /** 新增或整条替换，写入磁盘后才返回 */
  put(task: Task): Promise<void>
}

export function defaultTasksPath(cwd: string = process.cwd()): string {
  return join(cwd, '.ugc-lens', 'tasks.json')
}

/**
 * 文件不存在时从空列表开始。内容损坏时报错而不是清空：
 * 清空后已经分析过的文件会被当成新文件，重复花 token。
 */
export async function openTaskStore(path: string = defaultTasksPath()): Promise<TaskStore> {
  const tasks = new Map<string, Task>()
  let text: string | undefined
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (text !== undefined) {
    let parsed
    try {
      parsed = fileSchema.safeParse(JSON.parse(text))
    } catch {
      parsed = undefined
    }
    if (!parsed?.success) throw new Error(`任务文件格式不对：${path}。修好或删掉后再启动（删掉后已分析过的文件会被当成新文件）`)
    for (const task of parsed.data.tasks) tasks.set(task.file, task)
  }

  // 串行写入：两次 put 同时改名时，后写的可能被先写的覆盖
  let writing: Promise<void> = Promise.resolve()
  const save = async () => {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify({ version: 1, tasks: [...tasks.values()] }, null, 2)}\n`)
    await rename(temporary, path)
  }

  return {
    path,
    list: () => [...tasks.values()].map((task) => ({ ...task })),
    get: (file) => {
      const task = tasks.get(file)
      return task && { ...task }
    },
    put(task) {
      tasks.set(task.file, { ...task })
      writing = writing.then(save, save)
      return writing
    },
  }
}
