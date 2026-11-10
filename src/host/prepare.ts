import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { summarizeDanmaku } from '../analysis/danmaku.ts'
import { countTerms, createTokenizerFor, topTerms } from '../analysis/keywords.ts'
import { applyScenario, loadScenario } from '../analysis/scenarios.ts'
import { computeStats } from '../dataset/stats.ts'
import { loadDataset } from '../ingest/index.ts'
import { loadPlaybook, playbookRules, type MemoryOptions } from '../memory/playbook.ts'
import { planChunks } from '../pipeline/chunk.ts'
import { renderFacts } from '../pipeline/report.ts'
import { defaultDirections } from '../pipeline/summarize.ts'
import { hostChunkText } from './index.ts'

export interface PrepareOptions {
  file: string
  outDir: string
  cacheDir: string
  directions?: readonly string[]
  scenario?: string
  maxTotalChars?: number
  memory?: MemoryOptions
}

export interface PrepareManifest {
  file: string
  dataset_id: string
  platform: string
  directions: string[]
  scenario?: string
  facts: string
  guide: string
  chunks: Array<{ file: string; kind: string; items: number; represents: number; chars: number }>
  coverage: ReturnType<typeof planChunks>['coverage']
  items_total: number
}

function guideText(directions: readonly string[], hasDanmaku: boolean, rules: { summarize: string; merge: string }): string {
  return `# 宿主分析说明

由 ugc-lens 生成。你（宿主模型）负责阅读分块并写报告；统计、分块、抽样和引用核验由 ugc-lens 完成。

## 分块格式

- 评论块每行一条：\`[ID] 赞数 回复数 日期 IP属地 用户名：正文\`。以 ↳ 开头的是回复，花括号里的 parent/root/content 是直接回复对象、根评论和内容归属；排列顺序不代表回复关系。“（同样 +N）”表示另有 N 条内容相同。
- 字幕块：\`[ID] 字幕 content=内容ID 时间 正文\`，是源内容事实，不是观众立场。${hasDanmaku ? '\n- 弹幕块：`[ID] ×重复次数 首次出现时间 正文`，ID 是同一句弹幕的代表条目。' : ''}
- 正文里“…（全文 N 字）”表示被截断，需要完整原文时运行 \`ugc-lens host get <文件> <ID>\`。

## 分析方向

${directions.map((d, i) => `${i + 1}. ${d}`).join('\n')}

## 分析规则（来自当前分析手册）

${rules.summarize}

${rules.merge}

## 写报告

1. 按顺序读完全部块，每块记下候选观点：一句结论、纳入标准、2～5 个支持 ID、估计支持条数（“同样 +N”“×N”要算进去）。
2. 合并各块中意思相同的观点，保留双方证据的分歧，不把少数意见写成普遍观点。
3. 需要精确数量时运行 \`ugc-lens host search <文件> "词1|词2"\`，报告 total 并写明检索词；模型估计的数量写“约”。
4. 报告结构：标题、核心结论（每条带证据与反例/分歧）、各方向主题、需求与建议、附录（直接附上 facts.md 的统计内容）、局限（抽样范围、未读内容）。
5. 引用写成 \`[ID]\`；直接引用原文写成 \`"原文摘句" [ID]\`，摘句逐字复制，可用 … 省略中间部分，不改写、不拼接两条内容。
6. 写完运行 \`ugc-lens host verify <文件> <报告.md>\`，修正全部问题直到 ok 为 true。
`
}

/** 导入（不调用模型）、统计、分块，写出 facts.md、guide.md、chunks/*.md 和 manifest.json */
export async function prepareHostRun(options: PrepareOptions): Promise<PrepareManifest> {
  const dataset = await loadDataset(options.file, { cacheDir: options.cacheDir })
  const scenario = options.scenario ? loadScenario(options.scenario) : undefined
  const base = loadPlaybook(options.memory)
  const playbook = scenario ? applyScenario(base, scenario) : base
  const directions = [...(options.directions?.length ? options.directions : scenario?.directions ?? defaultDirections(dataset))]

  const stats = computeStats(dataset)
  const { tokenizer } = createTokenizerFor(dataset.items.map((item) => item.text))
  const keywords = topTerms(countTerms(dataset.items.filter((item) => item.kind !== 'danmaku'), tokenizer), 20)
  const danmaku = stats.items.danmaku > 0 ? summarizeDanmaku(dataset.items, tokenizer) : undefined
  const plan = planChunks(dataset, { danmaku, maxTotalChars: options.maxTotalChars })

  const outDir = resolve(options.outDir)
  await rm(join(outDir, 'chunks'), { recursive: true, force: true })
  await mkdir(join(outDir, 'chunks'), { recursive: true })
  const facts = renderFacts({ dataset, stats, coverage: plan.coverage, keywords, danmaku, directions, scenario: scenario ? { id: scenario.id, title: scenario.title, hash: scenario.hash } : undefined })
  await writeFile(join(outDir, 'facts.md'), facts)
  await writeFile(join(outDir, 'guide.md'), guideText(directions, plan.chunks.some((c) => c.kind === 'danmaku'), { summarize: playbookRules(playbook, 'summarize'), merge: playbookRules(playbook, 'merge') }))
  const width = String(plan.chunks.length).length
  const chunks: PrepareManifest['chunks'] = []
  for (const chunk of plan.chunks) {
    const name = `chunks/${String(chunk.index + 1).padStart(Math.max(width, 3), '0')}.md`
    await writeFile(join(outDir, name), hostChunkText(chunk, plan.chunks.length))
    chunks.push({ file: name, kind: chunk.kind, items: chunk.ids.length, represents: chunk.represents, chars: chunk.chars })
  }
  const manifest: PrepareManifest = {
    file: dataset.file_path, dataset_id: dataset.id, platform: dataset.platform, directions, scenario: scenario?.id,
    facts: 'facts.md', guide: 'guide.md', chunks, coverage: plan.coverage, items_total: dataset.items.length,
  }
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}
