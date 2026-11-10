import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { scenarioIds } from '../analysis/scenarios.ts'
import { getFeedback, getReplies, searchFeedback } from '../dataset/query.ts'
import { FEEDBACK_KINDS, type FeedbackItem, type FeedbackKind } from '../dataset/types.ts'
import { getEvidence } from '../dataset/evidence.ts'
import { ImportError, loadDataset } from '../ingest/index.ts'
import { checkReport, describeSource, submitMapping } from '../host/index.ts'
import { prepareHostRun } from '../host/prepare.ts'
import { positiveNumber, splitList, UsageError } from './common.ts'

export const HOST_USAGE = `用法：ugc-lens host <操作> <文件> [参数]

宿主模型模式：不读取 ugc-lens 的模型配置，由 Claude Code、Codex 等宿主自己的模型阅读分块并写报告，ugc-lens 只做导入、统计、分块、检索和引用核验。结果以 JSON 打印到标准输出。

  describe <文件>                  能否不经模型导入；不能时给出结构摘要，供宿主写映射规则
  mapping <文件> <规则.json>       校验宿主写的映射规则并试转换，通过后写入 .ugc-lens/mappings/
  prepare <文件> [选项]            写出 facts.md、guide.md、chunks/*.md 和 manifest.json
      --out <目录>                 输出目录，默认 .ugc-lens/host/<数据集ID>
      --focus <方向>               分析方向，逗号分开
      --scenario <名称>            场景手册：${scenarioIds().join('、')}
      --chars <字数>               分块的评论总字数，超出时抽样，默认 80000
  search <文件> <检索词> [选项]     空格表示都要出现，| 表示任一出现；返回真实匹配总数
      --kinds <类型>               只看这些类型：${FEEDBACK_KINDS.join('、')}
      --limit <条数>               展示条数，默认 20；--offset <条数> 翻页
  get <文件> <ID>                  一条原文的全文和直接回复
  verify <文件> <报告.md>          核对报告中的 [ID] 存在、"摘句" [ID] 逐字出现在原文；有问题时退出码 1

相对路径和 .ugc-lens/ 以当前目录为准。`

const brief = (item: FeedbackItem) => ({
  id: item.id, kind: item.kind, text: item.text, parent_id: item.parent_id, content_id: item.content_id,
  likes: item.likes, reply_count: item.reply_count, created_at: item.created_at, location: item.author?.location, video_time_sec: item.video_time_sec,
})

export interface HostIo { cwd?: string; write?: (text: string) => void }

async function load(file: string, cacheDir: string) {
  try {
    return await loadDataset(file, { cacheDir })
  } catch (error) {
    if (error instanceof ImportError && error.code === 'no_model') {
      throw new ImportError('no_model', `${error.message}。宿主模型模式下先运行 ugc-lens host describe ${file} 查看结构，再用 ugc-lens host mapping ${file} <规则.json> 提交规则`)
    }
    throw error
  }
}

export async function runHost(argv: readonly string[], io: HostIo = {}): Promise<void> {
  const cwd = io.cwd ?? process.cwd()
  const write = io.write ?? ((text: string) => { process.stdout.write(text) })
  const print = (value: unknown) => write(`${JSON.stringify(value, null, 2)}\n`)
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      out: { type: 'string' }, focus: { type: 'string' }, scenario: { type: 'string' }, chars: { type: 'string' },
      kinds: { type: 'string' }, limit: { type: 'string' }, offset: { type: 'string' },
    },
  })
  const [action, file, extra] = positionals
  if (!action) throw new UsageError('需要操作：describe、mapping、prepare、search、get 或 verify')
  if (!file) throw new UsageError(`${action} 需要数据文件路径`)
  const cacheDir = join(cwd, '.ugc-lens', 'mappings')

  switch (action) {
    case 'describe':
      return print(await describeSource(file, cacheDir))
    case 'mapping': {
      if (!extra) throw new UsageError('mapping 需要规则 JSON 文件')
      let rule: unknown
      try { rule = JSON.parse(await readFile(extra, 'utf8')) } catch (error) { throw new UsageError(`读取规则失败：${(error as Error).message}`) }
      const result = await submitMapping(file, rule, cacheDir)
      print(result)
      if (!result.ok) process.exitCode = 1
      return
    }
    case 'prepare': {
      if (values.scenario !== undefined && !scenarioIds().includes(values.scenario)) throw new UsageError(`未知的分析场景 "${values.scenario}"，可选：${scenarioIds().join(', ')}`)
      const dataset = await load(file, cacheDir)
      const outDir = values.out ?? join(cwd, '.ugc-lens', 'host', dataset.id)
      const manifest = await prepareHostRun({
        file, outDir, cacheDir, directions: splitList(values.focus), scenario: values.scenario,
        maxTotalChars: positiveNumber('chars', values.chars), memory: { cwd, onWarning: (message) => console.error(message) },
      })
      return print({ out: outDir, ...manifest })
    }
    case 'search': {
      if (extra === undefined) throw new UsageError('search 需要检索词')
      const kinds = splitList(values.kinds)
      const unknown = kinds?.filter((kind) => !(FEEDBACK_KINDS as readonly string[]).includes(kind))
      if (unknown?.length) throw new UsageError(`未知类型：${unknown.join(', ')}`)
      const dataset = await load(file, cacheDir)
      const page = searchFeedback(dataset, {
        query: extra, kinds: kinds as FeedbackKind[] | undefined,
        limit: positiveNumber('limit', values.limit) ?? 20, offset: values.offset === undefined ? 0 : Number(values.offset),
      })
      return print({ query: extra, total: page.total, items_total: dataset.items.length, offset: page.offset, items: page.items.map(brief) })
    }
    case 'get': {
      if (!extra) throw new UsageError('get 需要 ID')
      const dataset = await load(file, cacheDir)
      const item = getFeedback(dataset, extra)
      const evidence = item ?? getEvidence(dataset, extra)
      if (!evidence) throw new UsageError(`数据中没有 ID ${extra}`)
      const parent = item?.parent_id ? getFeedback(dataset, item.parent_id) : undefined
      return print({ item: item ? brief(item) : evidence, parent: parent ? brief(parent) : undefined, replies: item ? getReplies(dataset, item.id).map(brief) : [] })
    }
    case 'verify': {
      if (!extra) throw new UsageError('verify 需要报告文件')
      const dataset = await load(file, cacheDir)
      const result = checkReport(await readFile(extra, 'utf8'), dataset)
      print(result)
      if (!result.ok) process.exitCode = 1
      return
    }
    default:
      throw new UsageError(`未知操作：${action}`)
  }
}
