/**
 * 第 8 步：读入文件，用数据工具追问，回答带 [ID] 引用。
 *   node examples/08_ask.ts                              测试样本 + 两个默认问题（第二个是追问）
 *   node examples/08_ask.ts <文件...> "问题" "追问"...      参数里存在的文件作为数据集，其余作为依次提出的问题
 * 每个问题都接着上一轮的对话，最后核对回答里引用的 ID 是否真的存在。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createLlmModel } from '../src/agent/llm_model.ts'
import type { AgentRunResult } from '../src/agent/loop.ts'
import { askDataset } from '../src/ask/index.ts'
import { formatEvent } from '../src/cli/format_event.ts'
import { loadLlmConfig } from '../src/config.ts'
import { getFeedback } from '../src/dataset/query.ts'
import { ImportError, loadDataset } from '../src/ingest/index.ts'
import { createChatClient } from '../src/llm/client.ts'
import { formatItem } from '../src/tools/data/format.ts'

const sample = fileURLToPath(
  new URL('../test/fixtures/bilibili/super_collect/BV1xx411c7mD/示例视频-100000001/bilibili_all.json', import.meta.url),
)
const args = process.argv.slice(2)
const files = args.filter((arg) => existsSync(arg))
const questions = args.filter((arg) => !existsSync(arg))
if (files.length === 0) files.push(sample)
if (questions.length === 0) questions.push('这个视频的评论主要在吐槽什么？', '点赞最多的那条吐槽，下面的回复是怎么说的？')

const config = loadLlmConfig()
const model = createLlmModel(createChatClient(config), { temperature: 0.2 })

try {
  const datasets = []
  for (const file of files) {
    const dataset = await loadDataset(file, { model, onEvent: (event) => console.log(formatEvent(event)) })
    console.log(`已导入 ${dataset.id}：${dataset.items.length} 条（规则${dataset.mapping.from_cache ? '来自缓存' : '由模型生成'}）`)
    datasets.push(dataset)
  }

  let history: AgentRunResult['messages'] | undefined
  for (const question of questions) {
    console.log(`\n[${config.provider} / ${config.model}] ${question}\n`)
    const result = await askDataset({ model, datasets, question, history, onEvent: (event) => console.log(formatEvent(event)) })
    history = result.run.messages

    console.log(`\n回答：\n${result.answer}`)
    console.log(`\n停止原因：${result.run.stop_reason}　步数：${result.run.steps.length}　token：${result.run.usage.input_tokens}+${result.run.usage.output_tokens}`)
    console.log(`引用核对：${result.citations.valid.length} 个存在，${result.citations.invalid.length} 个不存在${result.citations.invalid.length ? `（${result.citations.invalid.join(', ')}）` : ''}`)
    for (const id of result.citations.valid.slice(0, 5)) {
      const item = datasets.map((dataset) => getFeedback(dataset, id)).find(Boolean)
      if (item) console.log(`  ${formatItem(item, { maxChars: 60 })}`)
    }
  }
} catch (error) {
  if (!(error instanceof ImportError)) throw error
  console.error(`\n导入失败（${error.code}）：${error.message}`)
  process.exitCode = 1
}
