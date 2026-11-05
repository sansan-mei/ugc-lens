import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { loadLlmConfig } from '../config.ts'
import { loadDataset } from '../ingest/index.ts'
import { analyzeDataset } from '../pipeline/analyze.ts'
import { abortOnInterrupt, analysisModel, formatAnalyzeProgress, positiveNumber, splitList, UsageError } from './common.ts'

export const ANALYZE_USAGE = `用法：ugc-lens analyze <文件> [选项]

分析一个数据文件，Markdown 报告打印到标准输出，并保存到 .ugc-lens/reports/。

  -o, --output <文件>    报告另存到这个文件，不再打印到标准输出
  --no-save              不保存到 .ugc-lens/reports/
  --chars <字数>         交给模型的评论总字数，默认 80000
  --focus <方向>         只分析这些方向，逗号分开，例如 价格,售后
  --concurrency <数>     同时调用模型的块数，默认 4`

export interface AnalyzeArgs {
  file: string
  output?: string
  save: boolean
  maxTotalChars?: number
  directions?: string[]
  concurrency?: number
}

export function parseAnalyzeArgs(argv: readonly string[]): AnalyzeArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' },
      'no-save': { type: 'boolean', default: false },
      chars: { type: 'string' },
      focus: { type: 'string' },
      concurrency: { type: 'string' },
    },
  })
  if (positionals.length !== 1) throw new UsageError('需要一个要分析的文件')
  const concurrency = positiveNumber('concurrency', values.concurrency)
  if (concurrency !== undefined && !Number.isInteger(concurrency)) throw new UsageError(`--concurrency 需要整数，收到 ${values.concurrency}`)
  return {
    file: positionals[0]!,
    output: values.output,
    save: !values['no-save'],
    maxTotalChars: positiveNumber('chars', values.chars),
    directions: splitList(values.focus),
    concurrency,
  }
}

export async function runAnalyze(argv: readonly string[]): Promise<void> {
  const args = parseAnalyzeArgs(argv)
  const config = loadLlmConfig()
  const model = analysisModel(config)
  const { signal } = abortOnInterrupt('正在取消')

  const dataset = await loadDataset(args.file, { model, signal })
  console.error(`已导入 ${dataset.items.length} 条（文件结构${dataset.mapping.from_cache ? '规则来自缓存' : '由模型识别'}）`)
  const result = await analyzeDataset({
    model,
    dataset,
    signal,
    modelName: config.model,
    directions: args.directions,
    maxTotalChars: args.maxTotalChars,
    concurrency: args.concurrency,
    outDir: args.save ? undefined : false,
    onProgress: (event) => console.error(formatAnalyzeProgress(event)),
  })

  if (args.output) {
    await writeFile(args.output, result.markdown)
    console.error(`报告已写入：${args.output}`)
  } else {
    process.stdout.write(result.markdown)
  }
  if (result.path) console.error(`报告已保存：${result.path}`)
}
