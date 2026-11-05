import * as z from 'zod'
import { FEEDBACK_KINDS } from '../dataset/types.ts'

/**
 * 规则用 regex 写，会出现在 JSON Schema 的 pattern 里，模型提交前就能看到。
 * 对象都用 strictObject：模型把字段写错位置时（如 title 没放进 fields）报错，而不是被悄悄丢掉。
 */
const KEY = '[^.\\[\\]]+'
/** 相对路径的第一个字段不能以 $ 开头，否则和绝对路径混淆 */
const FIRST_KEY = '[^.\\[\\]$][^.\\[\\]]*'
const RELATIVE = `${FIRST_KEY}(?:\\.${KEY})*`

const absolutePath = z
  .string()
  .regex(new RegExp(`^\\$(?:\\[\\])?(?:\\.${KEY}(?:\\[\\])?)*$`))
  .describe('绝对路径：$ 开头，. 分隔字段，[] 展开数组，如 $.data.comments 或 $.answers[].comments；$ 表示文件顶层')

const relativePath = z
  .string()
  .regex(new RegExp(`^${RELATIVE}$`))
  .describe('相对当前元素的字段路径，只用 . 分隔，如 content 或 user_info.nickname')

const fieldPath = z
  .string()
  .regex(new RegExp(`^(?:\\$(?:\\.${KEY})+|${RELATIVE})$`))
  .describe('字段路径：相对当前元素（如 user.name），或 $ 开头从文件顶层取（如 $.info.title）')

const kind = z.enum(FEEDBACK_KINDS)

const itemFields = z.strictObject({
  text: fieldPath.describe('正文，必填'),
  id: fieldPath.optional().describe('条目自己的 ID'),
  author_id: fieldPath.optional(),
  author_name: fieldPath.optional(),
  author_gender: fieldPath.optional(),
  author_location: fieldPath.optional().describe('IP 属地'),
  likes: fieldPath.optional(),
  reply_count: fieldPath.optional().describe('平台显示的回复数'),
  created_at: fieldPath.optional().describe('发布时间，秒、毫秒或日期字符串都可以'),
  video_time: fieldPath.optional().describe('弹幕在视频中的时间点，秒数或 01:23'),
  danmaku_mode: fieldPath.optional(),
  content_id: fieldPath.optional().describe('扁平文件里，条目所属内容的 ID'),
  parent_id: fieldPath.optional().describe('扁平文件里，上一级条目的 ID；为空或 0 表示一级评论'),
})

const grandchild = z.strictObject({
  kind: kind.default('reply'),
  path: relativePath.describe('下一级数组相对上一级元素的路径，如 replyList'),
  fields: itemFields.optional().describe('这一级的完整字段规则。不写时沿用上一级的规则，上一级有而这一级没有的字段自动忽略'),
  recursive: z.boolean().default(false).describe('同名字段在更深层重复出现（回复的回复）时为 true'),
})

const child = grandchild.extend({ children: z.array(grandchild).optional() })

const collection = z.strictObject({
  kind,
  path: absolutePath.describe('互动内容数组的绝对路径'),
  fields: itemFields,
  children: z.array(child).optional().describe('嵌套在元素里的下一级，如评论下的回复'),
})

const content = z.strictObject({
  path: absolutePath.describe('被评论对象（视频、笔记、问题）的路径：一个对象，或一个数组（每个元素是一个内容）'),
  id_from_path: z.string().optional().describe('文件里没有内容 ID 时，从文件路径中取 ID 的正则，取第一个捕获组'),
  url_template: z.string().optional().describe('文件里没有链接时用 ID 拼链接，{id} 会被替换'),
  fields: z
    .object({
      id: fieldPath,
      title: fieldPath,
      url: fieldPath,
      author: fieldPath,
      description: fieldPath,
      published_at: fieldPath,
      summary: fieldPath.describe('平台提供的内容摘要'),
    })
    .partial()
    .default({}),
  stats: z.record(z.string(), fieldPath).optional().describe('平台显示的数据，如 { "views": "view", "likes": "stat.like" }'),
  transcript: z
    .object({ path: fieldPath.describe('字幕数组'), start: relativePath, end: relativePath, text: relativePath })
    .optional()
    .describe('字幕，时间单位为秒'),
})

export const mappingSchema = z.strictObject({
  platform: z.string().min(1).describe('平台：bilibili、douyin、xhs、zhihu、youtube、weibo、kuaishou，判断不了填 unknown'),
  content: content.optional(),
  collections: z.array(collection).min(1).describe('互动内容集合：评论、弹幕、回答等'),
})

export type Mapping = z.output<typeof mappingSchema>
export type CollectionRule = Mapping['collections'][number]
export type ChildRule = NonNullable<CollectionRule['children']>[number]
export type ItemFields = CollectionRule['fields']
