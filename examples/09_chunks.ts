/**
 * 第 9 步（一）：分析前的纯代码处理，不调用模型做分析（导入时如果没有缓存规则，会调用模型识别结构）。
 *   node examples/09_chunks.ts            使用测试样本
 *   node examples/09_chunks.ts <文件>      使用自己的文件
 * 打印：从数据里发现的新词、评论关键词、弹幕去重与高峰时段、分块结果和覆盖率。
 */
import { fileURLToPath } from 'node:url'
import { createLlmModel } from '../src/agent/llm_model.ts'
import { summarizeDanmaku } from '../src/analysis/danmaku.ts'
import { countTerms, createTokenizerFor, topTerms } from '../src/analysis/keywords.ts'
import { loadLlmConfig } from '../src/config.ts'
import { ImportError, loadDataset } from '../src/ingest/index.ts'
import { createChatClient } from '../src/llm/client.ts'
import { planChunks } from '../src/pipeline/chunk.ts'
import { clock } from '../src/tools/data/format.ts'

const sample = fileURLToPath(
  new URL('../test/fixtures/bilibili/super_collect/BV1xx411c7mD/示例视频-100000001/bilibili_all.json', import.meta.url),
)
const filePath = process.argv[2] ?? sample
const ms = (start: number) => `${Math.round(performance.now() - start)}ms`

try {
  const dataset = await loadDataset(filePath, { model: createLlmModel(createChatClient(loadLlmConfig()), { temperature: 0 }) })
  console.log(`${dataset.id}：${dataset.items.length} 条（规则${dataset.mapping.from_cache ? '来自缓存' : '由模型生成'}）\n`)

  let start = performance.now()
  const { tokenizer, words } = createTokenizerFor(dataset.items.map((item) => item.text))
  console.log(`新词发现（${ms(start)}）：${words.slice(0, 30).map((w) => `${w.word}(${w.count})`).join(' ') || '无'}`)

  start = performance.now()
  const comments = dataset.items.filter((item) => item.kind !== 'danmaku').sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))
  const terms = topTerms(countTerms(comments, tokenizer), 30)
  console.log(`评论关键词（${ms(start)}，按包含它的条数）：${terms.map((t) => `${t.word}(${t.docs})`).join(' ') || '无'}`)

  start = performance.now()
  const danmaku = summarizeDanmaku(dataset.items, tokenizer)
  console.log(`\n弹幕（${ms(start)}）：${danmaku.total} 条，去重后 ${danmaku.unique} 条，每段 ${danmaku.bin_sec} 秒`)
  console.log(`  重复最多：${danmaku.groups.slice(0, 10).map((g) => `${g.text.slice(0, 20)}×${g.count}`).join(' | ') || '无'}`)
  for (const peak of danmaku.peaks) {
    console.log(`  高峰 ${clock(peak.start_sec)}-${clock(peak.end_sec)}：${peak.count} 条（平时每段 ${peak.baseline.toFixed(1)} 条，z=${peak.z.toFixed(1)}）`)
    console.log(`    弹幕：${peak.groups.slice(0, 5).map((g) => `${g.text.slice(0, 20)}×${g.count}`).join(' | ')}`)
    console.log(`    特有的词：${peak.terms.map((t) => t.word).join(' ') || '无'}`)
  }

  start = performance.now()
  const plan = planChunks(dataset, { danmaku })
  const c = plan.coverage
  console.log(`\n分块（${ms(start)}）：${plan.chunks.length} 块，共 ${plan.chunks.reduce((s, x) => s + x.chars, 0)} 字`)
  console.log(`  一级内容 ${c.threads_total} 条，合并重复 ${c.threads_merged} 条，放进 ${c.threads_included} 条${c.sampled ? '（超出预算，已抽样）' : ''}`)
  console.log(`  评论和回复 ${c.items_total} 条，放进 ${c.items_included} 条`)
  console.log(`  弹幕 ${c.danmaku_total} 条，放进 ${c.danmaku_groups_included} 组，代表 ${c.danmaku_represented} 条`)
  console.log(`\n第 1 块前 5 行：\n${plan.chunks[0]?.lines.slice(0, 5).join('\n') ?? '无'}`)
} catch (error) {
  if (!(error instanceof ImportError)) throw error
  console.error(`\n导入失败（${error.code}）：${error.message}`)
  process.exitCode = 1
}
