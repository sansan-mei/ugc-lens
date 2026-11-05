import { basename } from 'node:path'
import * as z from 'zod'
import type { DatasetStore } from '../../dataset/store.ts'
import { defineTool } from '../define.ts'
import type { AgentTool } from '../types.ts'

export function createListDatasetsTool(store: DatasetStore): AgentTool {
  return defineTool({
    name: 'list_datasets',
    description: '列出已导入的数据集：ID、平台、文件名、内容数和互动内容条数。',
    parameters: z.object({}),
    async execute() {
      const datasets = store.list()
      if (datasets.length === 0) return '还没有导入任何数据集。'
      return datasets
        .map((d) => {
          const title = d.contents.length === 1 && d.contents[0]?.title ? ` 《${d.contents[0].title}》` : ''
          return `${d.id} ${d.platform} ${basename(d.file_path)}${title}：${d.contents.length} 个内容，${d.items.length} 条互动内容`
        })
        .join('\n')
    },
  })
}
