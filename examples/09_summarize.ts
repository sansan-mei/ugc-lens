/**
 * 第 9 步（二）：分块总结，调用真实模型。
 *   node examples/09_summarize.ts                         使用测试样本
 *   node examples/09_summarize.ts <文件> [--chars 80000] [--focus 价格,售后] [--concurrency 4]
 * 打印：开始前的 token 估算、每块进度、各方向的观点（引用由代码显示原文）、校验丢掉的内容、实际用量。
 */
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createLlmModel } from '../src/agent/llm_model.ts'
import { summarizeDanmaku } from '../src/analysis/danmaku.ts'
import { createTokenizerFor } from '../src/analysis/keywords.ts'
import { loadLlmConfig } from '../src/config.ts'
import { getFeedback } from '../src/dataset/query.ts'
import { ImportError, loadDataset } from '../src/ingest/index.ts'
import { createChatClient } from '../src/llm/client.ts'
import { DEFAULT_MAX_TOTAL_CHARS, planChunks } from '../src/pipeline/chunk.ts'
import { estimateSummarize, summarizeChunks, type Dropped } from '../src/pipeline/summarize.ts'
import { oneLine } from '../src/tools/data/format.ts'
import { formatCachedTokens } from '../src/llm/usage.ts'

const sample = fileURLToPath(
  new URL('../test/fixtures/bilibili/super_collect/BV1xx411c7mD/示例视频-100000001/bilibili_all.json', import.meta.url),
)
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { chars: { type: 'string' }, focus: { type: 'string' }, concurrency: { type: 'string' } },
})
const filePath = positionals[0] ?? sample
const directions = values.focus?.split(/[,，]/).map((d) => d.trim()).filter(Boolean)

try {
  const model = createLlmModel(createChatClient(loadLlmConfig()), { temperature: 0, maxTokens: 4_000, disableThinking: true })
  const dataset = await loadDataset(filePath, { model })
  const { tokenizer } = createTokenizerFor(dataset.items.map((item) => item.text))
  const plan = planChunks(dataset, {
    danmaku: summarizeDanmaku(dataset.items, tokenizer),
    maxTotalChars: values.chars ? Number(values.chars) : DEFAULT_MAX_TOTAL_CHARS,
  })
  const c = plan.coverage
  console.log(`${dataset.id}：${dataset.items.length} 条，分成 ${plan.chunks.length} 块，共 ${plan.chunks.reduce((s, x) => s + x.chars, 0)} 字`)
  console.log(`  评论和回复放进 ${c.items_included}/${c.items_total} 条${c.sampled ? '（已抽样）' : ''}，低信息内容 ${c.low_info} 条未发送`)
  const estimate = estimateSummarize({ dataset, plan, directions })
  console.log(`  估算：${estimate.calls} 次调用，输入约 ${estimate.input_tokens} token，输出约 ${estimate.output_tokens} token 以内\n`)

  const result = await summarizeChunks({
    model,
    dataset,
    plan,
    directions,
    concurrency: values.concurrency ? Number(values.concurrency) : 4,
    onChunk: (s) => {
      const usage = s.usage ? `，输入 ${s.usage.input_tokens}（缓存 ${s.usage.cached_input_tokens ?? '?'}） 输出 ${s.usage.output_tokens}` : ''
      console.log(`  块 ${s.chunk + 1}：${s.status}，${s.findings.length} 条观点${usage}${s.error ? `，${s.error}` : ''}`)
    },
  })

  const byDirection = new Map<string, typeof result.findings>()
  for (const f of result.findings) byDirection.set(f.direction, [...(byDirection.get(f.direction) ?? []), f])
  for (const [direction, findings] of byDirection) {
    console.log(`\n## ${direction}`)
    for (const f of findings.sort((a, b) => b.support - a.support)) {
      console.log(`- ${f.title}（约 ${f.support} 条，块 ${f.chunk + 1}）\n  标准：${f.criteria}`)
      for (const ref of f.refs.slice(0, 2)) {
        const text = ref.quote ?? oneLine(getFeedback(dataset, ref.id)?.text ?? '').slice(0, 60)
        console.log(`    [${ref.id}] ${text}`)
      }
    }
  }

  const dropped = result.chunks.reduce<Dropped>((sum, s) => {
    for (const key of Object.keys(sum) as Array<keyof Dropped>) sum[key] += s.dropped[key]
    return sum
  }, { invalid_finding: 0, unknown_ref: 0, bad_quote: 0, no_valid_refs: 0, over_limit: 0 })
  const u = result.usage
  console.log(`\n校验丢掉：${JSON.stringify(dropped)}`)
  console.log(`实际：${result.calls} 次调用，输入 ${u.input_tokens}（缓存命中 ${formatCachedTokens(u)}），输出 ${u.output_tokens}，耗时 ${(result.duration_ms / 1000).toFixed(1)} 秒`)
} catch (error) {
  if (!(error instanceof ImportError)) throw error
  console.error(`\n导入失败（${error.code}）：${error.message}`)
  process.exitCode = 1
}
