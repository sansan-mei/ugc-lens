/**
 * 第 7 步：读入一个 bilibili_all.json，转换成统一格式并打印统计。不调用模型。
 *   node examples/07_dataset_stats.ts                       使用测试样本
 *   node examples/07_dataset_stats.ts <bilibili_all.json>   使用自己的文件
 */
import { fileURLToPath } from 'node:url'
import { computeStats } from '../src/dataset/stats.ts'
import { loadDataset, SourceError } from '../src/sources/index.ts'

const sample = fileURLToPath(
  new URL('../test/fixtures/media_crawl/bilibili/super_collect/BV1xx411c7mD/示例视频-100000001/bilibili_all.json', import.meta.url),
)
const filePath = process.argv[2] ?? sample

try {
  const dataset = await loadDataset(filePath)
  const stats = computeStats(dataset)
  const content = dataset.contents[0]

  console.log(`文件：${dataset.file_path}`)
  console.log(`数据集 ID：${dataset.id}（${dataset.source}）`)
  if (content) {
    console.log(`\n内容：${content.title}`)
    console.log(`  ID：${content.id}　链接：${content.url ?? '无'}`)
    console.log(`  发布：${content.published_at ?? '未知'}　平台数据：${JSON.stringify(content.stats ?? {})}`)
    console.log(`  AI 总结：${content.summary ? '有' : '无'}　字幕：${content.transcript?.length ?? 0} 行`)
  }

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
  if (!(error instanceof SourceError)) throw error
  console.error(error.message)
  process.exitCode = 1
}
