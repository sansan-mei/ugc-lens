import { ArrowUp, Check, LoaderCircle, MessageCircle, RotateCcw, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Badge, Card, Notice } from '../components/ui/card.tsx'
import { Button } from '../components/ui/button.tsx'
import { api, ApiError, streamChat } from '../lib/api.ts'
import { applyChatEvent, newAssistantTurn, toolLabel, type AssistantTurn, type ChatTurn } from '../lib/chat.ts'
import { baseName } from '../lib/format.ts'
import { renderMarkdown } from '../lib/markdown.ts'
import type { Overview } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'

export interface ChatState {
  turns: ChatTurn[]
  busy: boolean
  send: (text: string, datasetId?: string) => Promise<void>
  stop: () => void
  reset: () => void
}

/** 对话状态放在 App 里，切换标签页时回答继续生成、历史不丢 */
export function useChat(): ChatState {
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [busy, setBusy] = useState(false)
  const session = useRef<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const updateLast = (fn: (turn: AssistantTurn) => AssistantTurn) => setTurns((list) => {
    const last = list.at(-1)
    return last?.role === 'assistant' ? [...list.slice(0, -1), fn(last)] : list
  })

  async function send(text: string, datasetId?: string) {
    const question = text.trim()
    if (!question || controller.current) return
    const abort = controller.current = new AbortController()
    setBusy(true)
    setTurns((list) => [...list, { role: 'user', text: question }, newAssistantTurn()])
    try {
      session.current ??= (await api<{ id: string }>('chat', { method: 'POST', body: '{}' })).id
      await streamChat(session.current, question, datasetId, (event) => updateLast((turn) => applyChatEvent(turn, event)), abort.signal)
      updateLast((turn) => turn.status === 'streaming' ? { ...turn, status: 'error', error: '连接中断，回答没有完成' } : turn)
    } catch (error) {
      if (abort.signal.aborted) updateLast((turn) => ({ ...turn, status: 'stopped' }))
      else {
        if (error instanceof ApiError && error.status === 404) session.current = null
        updateLast((turn) => ({ ...turn, status: 'error', error: (error as Error).message }))
      }
    } finally {
      controller.current = null
      setBusy(false)
    }
  }

  return {
    turns, busy, send,
    stop: () => controller.current?.abort(),
    reset: () => {
      controller.current?.abort()
      const id = session.current
      session.current = null
      if (id) void api(`chat/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
      setTurns([])
    },
  }
}

const CARET = '<span class="chat-caret"></span>'
/** 光标放进最后一个文本块里，而不是另起一行 */
const withCaret = (html: string) => {
  const m = /(<\/(?:p|li|h[1-6]|td|code)>(?:<\/(?:ul|ol|tr|tbody|table|pre|div|blockquote)>)*)$/.exec(html)
  return m ? html.slice(0, m.index) + CARET + m[1] : html + CARET
}

const SUGGESTIONS_WITH_DATA = ['大家主要在讨论什么？', '负面评价集中在哪些方面？', '点赞最多的评论说了什么？']
const SUGGESTIONS_WITHOUT_DATA = ['看看启动目录里有哪些数据', '帮我导入最新的数据文件并概括评论']

function AssistantMessage({ turn, openItem }: { turn: AssistantTurn; openItem: (id: string) => void }) {
  const body = useRef<HTMLDivElement>(null)
  const invalid = new Set(turn.citations?.invalid ?? [])
  useEffect(() => {
    if (!body.current || !invalid.size) return
    for (const b of body.current.querySelectorAll<HTMLButtonElement>('.cite')) {
      if (invalid.has(b.dataset.id!)) { b.classList.add('plain'); b.textContent = `[${b.dataset.id}]`; b.disabled = true; b.title = '数据中找不到这个 ID' }
    }
  })
  const streaming = turn.status === 'streaming'
  return <div className="space-y-2.5">
    {turn.tools.length > 0 && <div className="flex flex-wrap gap-1.5">{turn.tools.map((t) => <Badge key={t.call_id} title={t.args} className="font-normal text-muted-foreground">
      {t.ok === undefined ? <LoaderCircle className="size-3 animate-spin" /> : t.ok ? <Check className="size-3" /> : <X className="size-3 text-destructive" />}{toolLabel(t.name)}
    </Badge>)}</div>}
    {turn.text ? <div ref={body} className="prose-report prose-chat" onClick={(e) => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.cite'); if (b && !b.disabled && b.dataset.id) openItem(b.dataset.id) }} dangerouslySetInnerHTML={{ __html: streaming ? withCaret(renderMarkdown(turn.text)) : renderMarkdown(turn.text) }} />
      : streaming && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{turn.tools.some((t) => t.ok === undefined) ? '正在调用工具…' : '思考中…'}</p>}
    {turn.status === 'error' && <Notice className="border-destructive/30 text-destructive">{turn.error}</Notice>}
    {turn.status === 'stopped' && <p className="text-xs text-muted-foreground">已停止</p>}
    {turn.warnings.map((w) => <p key={w} className="text-xs text-muted-foreground">{w}</p>)}
    {turn.status === 'done' && <p className="text-xs text-muted-foreground">
      {turn.stop_reason && turn.stop_reason !== 'completed' ? `未完整结束（${turn.stop_reason}）· ` : ''}
      {invalid.size ? `${invalid.size} 个引用在数据中找不到 · ` : ''}已知 token {turn.tokens ?? 0}
    </p>}
  </div>
}

export function ChatView({ chat, o, openItem }: { chat: ChatState; o: Overview | null; openItem: (id: string) => void }) {
  const [draft, setDraft] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const last = chat.turns.at(-1)
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }) }, [chat.turns.length, last?.role === 'assistant' ? last.text : ''])
  const submit = (text = draft) => {
    if (!text.trim() || chat.busy) return
    setDraft('')
    void chat.send(text, o?.id)
  }
  const suggestions = o ? SUGGESTIONS_WITH_DATA : SUGGESTIONS_WITHOUT_DATA
  return <Card className="flex h-[calc(100dvh-8.5rem)] min-h-[480px] flex-col gap-0 p-0">
    <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5">
      <div className="min-w-0">
        <h1 className="font-semibold leading-none">对话</h1>
        <p className="mt-1.5 truncate text-xs text-muted-foreground">{o ? `已接入：${baseName(o.file)}` : '未打开数据：可以让模型从启动目录查找并导入文件'}</p>
      </div>
      <Button variant="outline" size="sm" onClick={() => { chat.reset(); setDraft('') }} disabled={!chat.turns.length}><RotateCcw />新对话</Button>
    </div>
    <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
      {chat.turns.length === 0 ? <div className="mx-auto flex max-w-xl flex-col items-center py-[6vh] text-center">
        <span className="mb-4 grid size-10 place-items-center rounded-lg border shadow-xs"><MessageCircle className="size-5" /></span>
        <h2 className="text-lg font-semibold">用自然语言追问数据</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">回答会引用原文 ID，点击即可查看原文。对话使用 ugc-lens 配置的模型，会产生调用费用。</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">{suggestions.map((s) => <Button key={s} variant="outline" size="sm" className="font-normal" onClick={() => submit(s)}>{s}</Button>)}</div>
      </div> : <div className="mx-auto max-w-3xl space-y-6">
        {chat.turns.map((turn, i) => turn.role === 'user'
          ? <div key={i} className="flex justify-end"><p className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground">{turn.text}</p></div>
          : <AssistantMessage key={i} turn={turn} openItem={openItem} />)}
      </div>}
    </div>
    <form className="border-t p-3 sm:p-4" onSubmit={(e) => { e.preventDefault(); submit() }}>
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-lg border bg-background p-2 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        <textarea aria-label="输入问题" value={draft} rows={1} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
          placeholder={o ? '问问这份数据，例如：价格相关的抱怨有哪些？' : '描述要做的事，例如：分析 data 目录里最新的文件'}
          className={cn('max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground', '[field-sizing:content]')} />
        {chat.busy
          ? <Button type="button" size="icon" variant="outline" aria-label="停止" onClick={chat.stop}><Square className="size-3.5 fill-current" /></Button>
          : <Button type="submit" size="icon" aria-label="发送" disabled={!draft.trim()}><ArrowUp /></Button>}
      </div>
      <p className="mx-auto mt-1.5 max-w-3xl px-1 text-[11px] text-muted-foreground">Enter 发送，Shift+Enter 换行</p>
    </form>
  </Card>
}
