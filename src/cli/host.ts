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
import { briefImport, exportLabels, importLabels, type LabelTask } from '../host/labels.ts'
import { collectRecheckCandidates } from '../pipeline/recheck.ts'
import type { Insight } from '../pipeline/insights.ts'
import { proposePlaybook, type PlaybookChange } from '../memory/playbook.ts'
import type { TopicDefinition } from '../analysis/topics.ts'
import { DEFAULT_SENTIMENT_TARGET } from '../sentiment/index.ts'
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
  label-export <文件> <任务> [选项]  导出逐条标注任务：sentiment（情感）、topics（主题归类）、business（商业机会）
      --target <对象>              sentiment 的评价对象，默认文本整体情绪
      --topics <topics.json>       topics 的主题定义：[{"id","title","criteria"}]，1～20 个
      --goal <目标>                business 的分析目标；--background <背景> 可选
      --kinds <类型> --content <内容ID>  限定范围
      --sample <条数> --seed <数>  数据很大时随机抽样标注，结果注明为样本
      --batch <条数>               每批条数，默认 50；--out <目录> 默认 .ugc-lens/host/<ID>/labels-<任务>
  label-import <文件> <任务目录>    校验 answers/*.jsonl 并汇总分布、占比或机会列表；有错误或遗漏时退出码 1
  recheck <文件> --query <检索词>   补查：找出未被引用的相关原文供核对反例，--query 最多 3 个，--exclude 已引用 ID（逗号分开）
  propose <章节> <add|patch|remove> --text <规则> [--match <原文>]
                                   提出分析手册修改（章节：common、ask、summarize、merge），由用户 ugc-lens playbook --apply 生效

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
      target: { type: 'string' }, topics: { type: 'string' }, goal: { type: 'string' }, background: { type: 'string' },
      content: { type: 'string' }, sample: { type: 'string' }, seed: { type: 'string' }, batch: { type: 'string' },
      query: { type: 'string', multiple: true }, exclude: { type: 'string' }, text: { type: 'string' }, match: { type: 'string' },
    },
  })
  const [action, file, extra] = positionals
  if (!action) throw new UsageError('需要操作：describe、mapping、prepare、search、get、verify、label-export、label-import、recheck 或 propose')
  if (action === 'propose') {
    const section = file as PlaybookChange['section'] | undefined
    const operation = extra as PlaybookChange['operation'] | undefined
    if (!section || !['common', 'ask', 'summarize', 'merge'].includes(section)) throw new UsageError('propose 需要章节：common、ask、summarize 或 merge')
    if (!operation || !['add', 'patch', 'remove'].includes(operation)) throw new UsageError('propose 需要操作：add、patch 或 remove')
    const proposal = proposePlaybook({ cwd }, { section, operation, text: values.text, match: values.match })
    return print({ id: proposal.id, base: proposal.base, apply: `ugc-lens playbook --apply ${proposal.id}`, reject: `ugc-lens playbook --reject ${proposal.id}`, text: proposal.text })
  }
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
    case 'label-export': {
      const type = extra
      if (type !== 'sentiment' && type !== 'topics' && type !== 'business') throw new UsageError('label-export 需要任务：sentiment、topics 或 business')
      let task: LabelTask
      if (type === 'topics') {
        if (!values.topics) throw new UsageError('topics 任务需要 --topics <topics.json>')
        let topics: TopicDefinition[]
        try { topics = JSON.parse(await readFile(values.topics, 'utf8')) } catch (error) { throw new UsageError(`读取主题定义失败：${(error as Error).message}`) }
        task = { type, topics }
      } else task = type === 'sentiment' ? { type, target: values.target?.trim() || DEFAULT_SENTIMENT_TARGET } : { type, goal: values.goal, background: values.background }
      const kinds = splitList(values.kinds)
      const unknown = kinds?.filter((kind) => !(FEEDBACK_KINDS as readonly string[]).includes(kind))
      if (unknown?.length) throw new UsageError(`未知类型：${unknown.join(', ')}`)
      const dataset = await load(file, cacheDir)
      const outDir = values.out ?? join(cwd, '.ugc-lens', 'host', dataset.id, `labels-${type}`)
      const integer = (name: string, value: string | undefined) => {
        const n = positiveNumber(name, value)
        if (n !== undefined && !Number.isInteger(n)) throw new UsageError(`--${name} 需要整数`)
        return n
      }
      let manifest
      try {
        manifest = await exportLabels({ dataset, task, outDir, kinds: kinds as FeedbackKind[] | undefined, contentId: values.content, sample: integer('sample', values.sample), seed: integer('seed', values.seed), batchSize: integer('batch', values.batch) })
      } catch (error) { throw new UsageError((error as Error).message) }
      return print({ out: outDir, task: manifest.task.type, rules: 'task.md', batches: manifest.batches.map((b) => ({ file: b.file, items: b.ids.length })), items: manifest.batches.reduce((n, b) => n + b.ids.length, 0), skipped: manifest.skipped.length, scope: manifest.scope })
    }
    case 'label-import': {
      if (!extra) throw new UsageError('label-import 需要任务目录')
      const dataset = await load(file, cacheDir)
      const result = await importLabels(dataset, extra)
      print(briefImport(result))
      if (!result.ok) process.exitCode = 1
      return
    }
    case 'recheck': {
      const queries = values.query ?? []
      if (!queries.length || queries.length > 3) throw new UsageError('recheck 需要 1～3 个 --query')
      const dataset = await load(file, cacheDir)
      const exclude = splitList(values.exclude) ?? []
      const insight = { finding: '', evidence: exclude.length ? [{ point: '', refs: exclude.map((id) => ({ id, quote: '' })) }] : [], counterevidence: [], boundary: '', meaning: '', verify: '', recheck_queries: queries } as Insight
      const [plan] = collectRecheckCandidates(dataset, [insight], { perInsight: positiveNumber('limit', values.limit) ?? 8 })
      return print({ queries: plan!.queries, matched: plan!.matched, relaxed: plan!.relaxed, candidates: plan!.candidates, note: '补查只覆盖这些检索词命中的原文；逐条判断为反例、限定、支持或无关，反例和限定在报告中用 "摘句" [ID] 引用。未发现反例不等于不存在反例。' })
    }
    default:
      throw new UsageError(`未知操作：${action}`)
  }
}
