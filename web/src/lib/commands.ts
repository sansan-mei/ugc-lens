// 对话框里的斜杠命令。纯逻辑，浏览器和 Node 测试共用，不依赖 DOM。
// local：界面本地动作，不调用模型；prompt：展开成提示词发给对话模型，由它调用对应工具。

export type LocalAction = 'new' | 'open' | 'search'

export interface ChatCommand {
  name: string
  /** 参数提示；required 为 true 时必须填写 */
  arg?: { hint: string; required?: boolean }
  description: string
  group: '界面' | '分析' | '文件'
  run: { action: LocalAction } | { prompt: (arg: string) => string }
}

const focus = (arg: string) => (arg ? `\n关注点：${arg}` : '')

export const COMMANDS: readonly ChatCommand[] = [
  { name: 'new', description: '开始新对话，清空当前上下文', group: '界面', run: { action: 'new' } },
  { name: 'open', description: '打开数据文件', group: '界面', run: { action: 'open' } },
  { name: 'search', arg: { hint: '关键词', required: true }, description: '在原文页检索，不调用模型', group: '界面', run: { action: 'search' } },
  { name: 'summary', arg: { hint: '关注点' }, description: '概括主要讨论和代表性原文', group: '分析', run: { prompt: (arg) => `先用 get_dataset_stats 了解当前数据，再检索代表性原文，概括主要讨论点、正反观点和代表性原文，每个观点附引用 ID。${focus(arg)}` } },
  { name: 'report', arg: { hint: '关注点' }, description: '生成完整分析报告并保存', group: '分析', run: { prompt: (arg) => `用 analyze_dataset 为当前数据生成完整分析报告，完成后说明保存位置并列出核心结论。${focus(arg)}` } },
  { name: 'reputation', arg: { hint: '关注点' }, description: '口碑与危机报告', group: '分析', run: { prompt: (arg) => `用 analyze_dataset 并设置 scenario=reputation，为当前数据生成口碑与危机分析报告，完成后说明保存位置并列出核心结论。${focus(arg)}` } },
  { name: 'competitor', arg: { hint: '关注点' }, description: '竞品对比报告', group: '分析', run: { prompt: (arg) => `用 analyze_dataset 并设置 scenario=competitor，为当前数据生成竞品对比报告，完成后说明保存位置并列出核心结论。${focus(arg)}` } },
  { name: 'sentiment', arg: { hint: '评价对象' }, description: '逐条情感评估，统计比例', group: '分析', run: { prompt: (arg) => `用 analyze_sentiment 对当前数据做逐条情感评估，给出数量、比例、覆盖率和典型原文引用。${arg ? `\n评价对象：${arg}` : ''}` } },
  { name: 'topics', arg: { hint: '关注点' }, description: '主题归类与占比', group: '分析', run: { prompt: (arg) => `用 analyze_topics 对当前数据做主题归类，给出各主题的纳入标准、样本内占比、覆盖率和代表性原文引用。${focus(arg)}` } },
  { name: 'business', arg: { hint: '关注点' }, description: '痛点、购买意愿与商业机会', group: '分析', run: { prompt: (arg) => `用 analyze_business 从当前数据识别痛点、购买意愿、价格、竞品和转化阻力，按优先级列出机会，附摘句引用和验证方式。${focus(arg)}` } },
  { name: 'files', arg: { hint: '目录' }, description: '查看目录里的数据文件', group: '文件', run: { prompt: (arg) => `用 list_files 查看 ${arg || '启动目录'} 里有哪些可分析的数据文件，按类型简要列出，不要导入。` } },
  { name: 'watch', arg: { hint: '目录', required: true }, description: '后台监听目录，新文件自动生成报告', group: '文件', run: { prompt: (arg) => `用 start_watch 开始后台监听目录 ${arg}，说明监听的文件规则和报告位置。` } },
]

const find = (name: string) => COMMANDS.find((c) => c.name === name.toLowerCase())

/** 输入以 / 开头时给出候选：还在输命令名时按前缀筛选，已输入参数时只保留该命令 */
export function matchCommands(input: string): ChatCommand[] {
  const m = /^\/(\S*)(\s[^]*)?$/.exec(input)
  if (!m) return []
  const name = m[1]!.toLowerCase()
  if (m[2] !== undefined) { const c = find(name); return c ? [c] : [] }
  return COMMANDS.filter((c) => c.name.startsWith(name))
}

export type ParsedCommand = { action: LocalAction; arg?: string } | { prompt: string } | { error: string }

/** 不是斜杠命令返回 undefined */
export function parseCommand(input: string): ParsedCommand | undefined {
  const m = /^\/(\S+)\s*([^]*)$/.exec(input.trim())
  if (!m) return undefined
  const command = find(m[1]!)
  if (!command) return { error: `未知命令 /${m[1]}，输入 / 查看可用命令` }
  const arg = m[2]!.trim()
  if (command.arg?.required && !arg) return { error: `/${command.name} 需要填写${command.arg.hint}` }
  if ('action' in command.run) return arg ? { action: command.run.action, arg } : { action: command.run.action }
  return { prompt: command.run.prompt(arg) }
}
