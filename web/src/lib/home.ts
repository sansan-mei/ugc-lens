// 首页与顶栏文件入口的规则，浏览器和 Node 测试共用。

export const FORMAT_GROUPS = [
  { label: 'JSON', exts: ['.json', '.jsonl', '.ndjson'] },
  { label: '表格', exts: ['.csv', '.tsv'] },
  { label: '文本', exts: ['.txt', '.md', '.markdown', '.log'] },
] as const

export const DATA_EXT = FORMAT_GROUPS.flatMap((g) => g.exts).join(',')

/**
 * 顶栏右侧的文件入口。
 * 首页空状态已有醒目的选择按钮，顶栏再放一个“打开数据”只会让人困惑；
 * 打开文件后改成显示当前文件名，点击可切换，用户能看出它管的是什么。
 */
export function headerFileAction(tab: string, hasData: boolean): 'none' | 'open' | 'current' {
  if (hasData) return 'current'
  return tab === 'overview' || tab === 'items' ? 'none' : 'open'
}

const TABS = ['overview', 'items', 'reports', 'chat'] as const

/** 检索页只用于查找已打开数据里的原文，没有数据时与首页重复，直接不显示 */
export function visibleTabs(hasData: boolean): string[] {
  return hasData ? [...TABS] : TABS.filter((t) => t !== 'items')
}
