/**
 * 第 9 步（三）：完整分析，生成 Markdown 报告。
 *   node examples/09_analyze.ts                          使用测试样本
 *   node examples/09_analyze.ts <文件> [--chars 80000] [--focus 价格,售后] [--concurrency 4]
 * 报告打印到标准输出并保存到 .ugc-lens/reports/，进度打印到标准错误，所以可以 > report.md。
 */
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createLlmModel } from '../src/agent/llm_model.ts'
import { loadLlmConfig } from '../src/config.ts'
import { ImportError, loadDataset } from '../src/ingest/index.ts'
import { createChatClient } from '../src/llm/client.ts'
import { analyzeDataset } from '../src/pipeline/analyze.ts'

const sample = fileURLToPath(
  new URL('../test/fixtures/bilibili/super_collect/BV1xx411c7mD/示例视频-100000001/bilibili_all.json', import.meta.url),
)
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { chars: { type: 'string' }, focus: { type: 'string' }, concurrency: { type: 'string' } },
})

try {
  const config = loadLlmConfig()
  const model = createLlmModel(createChatClient(config), { temperature: 0, maxTokens: 4_000, disableThinking: true })
  const dataset = await loadDataset(positionals[0] ?? sample, { model })
  const result = await analyzeDataset({
    model,
    dataset,
    modelName: config.model,
    directions: values.focus?.split(/[,，]/).map((d) => d.trim()).filter(Boolean),
    maxTotalChars: values.chars ? Number(values.chars) : undefined,
    concurrency: values.concurrency ? Number(values.concurrency) : undefined,
    onProgress: (event) => {
      if (event.type === 'planned') {
        console.error(`分成 ${event.chunks} 块，预计输入约 ${event.estimate.input_tokens} token`)
      } else if (event.type === 'chunk') {
        console.error(`  块 ${event.summary.chunk + 1}：${event.summary.status}，${event.summary.findings.length} 条观点`)
      } else {
        console.error(`合并成 ${event.themes} 个主题${event.called ? '' : '（不需要调用模型）'}`)
      }
    },
  })
  console.log(result.markdown)
  console.error(`报告已保存：${result.path}`)
} catch (error) {
  if (!(error instanceof ImportError)) throw error
  console.error(`\n导入失败（${error.code}）：${error.message}`)
  process.exitCode = 1
}
