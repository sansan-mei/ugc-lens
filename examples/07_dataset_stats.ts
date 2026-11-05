/**
 * 第 7 步：读入任意 JSON 文件，由模型识别结构、代码按规则转换成统一格式，打印统计。
 *   node examples/07_dataset_stats.ts                   使用测试样本
 *   node examples/07_dataset_stats.ts <文件>             使用自己的文件
 *   node examples/07_dataset_stats.ts <文件> --fresh     不用缓存，重新让模型识别
 * 映射规则缓存在 .ugc-lens/mappings/，结构相同的文件第二次读入不调用模型。
 */
import { fileURLToPath } from 'node:url'
import { createLlmModel } from '../src/agent/llm_model.ts'
import { formatEvent } from '../src/cli/format_event.ts'
import { loadLlmConfig } from '../src/config.ts'
import { computeStats } from '../src/dataset/stats.ts'
import { formatReport, ImportError, loadDataset } from '../src/ingest/index.ts'
import { createChatClient } from '../src/llm/client.ts'

const sample = fileURLToPath(
  new URL('../test/fixtures/bilibili/super_collect/BV1xx411c7mD/示例视频-100000001/bilibili_all.json', import.meta.url),
)
const args = process.argv.slice(2)
const fresh = args.includes('--fresh')
const filePath = args.find((arg) => !arg.startsWith('--')) ?? sample

try {
  const model = createLlmModel(createChatClient(loadLlmConfig()), { temperature: 0 })
  const dataset = await loadDataset(filePath, {
    model,
    useCache: !fresh,
    onEvent: (event) => console.log(formatEvent(event)),
  })
  const stats = computeStats(dataset)

  console.log(`\n文件：${dataset.file_path}`)
  console.log(`数据集 ID：${dataset.id}　平台：${dataset.platform}`)
  console.log(`映射规则：${dataset.mapping.fingerprint}（${dataset.mapping.from_cache ? '来自缓存，没有调用模型' : '模型刚生成'}）`)
  console.log(`\n试转换报告：\n${formatReport(dataset.report)}`)

  for (const content of dataset.contents.slice(0, 3)) {
    console.log(`\n内容：${content.title ?? '（无标题）'}`)
    console.log(`  ID：${content.id}　链接：${content.url ?? '无'}`)
    console.log(`  发布：${content.published_at ?? '未知'}　平台数据：${JSON.stringify(content.stats ?? {})}`)
    console.log(`  摘要：${content.summary ? '有' : '无'}　字幕：${content.transcript?.length ?? 0} 行`)
  }
  if (dataset.contents.length > 3) console.log(`……共 ${dataset.contents.length} 个内容`)

  console.log('\n条目数量：')
  for (const [kind, count] of Object.entries(stats.items)) if (count > 0) console.log(`  ${kind}：${count}`)
  const { reported, collected } = stats.replies
  const coverage = reported > 0 ? `${((collected / reported) * 100).toFixed(1)}%` : '—'
  console.log(`  回复：平台显示 ${reported}，实际搜集 ${collected}（覆盖率 ${coverage}）`)
  if (stats.time_range) console.log(`时间范围：${stats.time_range.from} ~ ${stats.time_range.to}`)
  console.log(`IP 属地（${stats.with_location} 条有属地）：${stats.locations.map((l) => `${l.name} ${l.count}`).join('、') || '无'}`)

  console.log('\n前 3 条：')
  for (const item of dataset.items.slice(0, 3)) console.log(JSON.stringify(item))
} catch (error) {
  if (!(error instanceof ImportError)) throw error
  console.error(`\n导入失败（${error.code}）：${error.message}`)
  process.exitCode = 1
}
