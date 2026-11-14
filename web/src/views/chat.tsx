import { ArrowUp, Check, History, LoaderCircle, MessageCircle, Plus, Settings, Square, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Badge, Card, Empty, Notice } from '../components/ui/card.tsx'
import { Button } from '../components/ui/button.tsx'
import { Sheet } from '../components/ui/dialog.tsx'
import { api, ApiError, streamChat } from '../lib/api.ts'
import { applyChatEvent, newAssistantTurn, relativeTime, toolLabel, type AssistantTurn, type ChatSummary, type ChatTurn } from '../lib/chat.ts'
import { matchCommands, parseCommand, type ChatCommand } from '../lib/commands.ts'
import { baseName } from '../lib/format.ts'
import { renderMarkdown } from '../lib/markdown.ts'
import type { Overview } from '../lib/types.ts'
import { cn } from '../lib/utils.ts'

export interface ChatState {
  turns: ChatTurn[]
  busy: boolean
  chats: ChatSummary[]
  current: string | null
  loading: boolean
  /** display 是界面上显示的原话（斜杠命令），text 是发给模型的内容 */
  send: (text: string, datasetId?: string, display?: string) => Promise<void>
  stop: () => void
  reset: () => void
  select: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  refresh: () => Promise<void>
}

/** 对话状态放在 App 里，切换标签页时回答继续生成、历史不丢 */
export function useChat(): ChatState {
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [busy, setBusy] = useState(false)
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const session = useRef<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  // 切换或新建对话后，旧请求的收尾不能改到新显示的内容
  const generation = useRef(0)
  const updateLast = (fn: (turn: AssistantTurn) => AssistantTurn) => setTurns((list) => {
    const last = list.at(-1)
    return last?.role === 'assistant' ? [...list.slice(0, -1), fn(last)] : list
  })
  const refresh = async () => { try { setChats((await api<{ chats: ChatSummary[] }>('chats')).chats) } catch { /* 没有令牌或服务未启动时保持空列表 */ } }
  useEffect(() => { void refresh() }, [])

  async function send(text: string, datasetId?: string, display?: string) {
    const question = text.trim()
    if (!question || controller.current) return
    const abort = controller.current = new AbortController()
    const mine = generation.current
    const update = (fn: (turn: AssistantTurn) => AssistantTurn) => { if (generation.current === mine) updateLast(fn) }
    setBusy(true)
    setTurns((list) => [...list, { role: 'user', text: display?.trim() || question }, newAssistantTurn()])
    try {
      if (!session.current) {
        const id = (await api<{ id: string }>('chat', { method: 'POST', body: '{}' })).id
        if (generation.current !== mine) return
        session.current = id
        setCurrent(id)
      }
      await streamChat(session.current!, question, datasetId, (event) => update((turn) => applyChatEvent(turn, event)), abort.signal, display)
      update((turn) => turn.status === 'streaming' ? { ...turn, status: 'error', error: '连接中断，回答没有完成' } : turn)
    } catch (error) {
      if (abort.signal.aborted) update((turn) => ({ ...turn, status: 'stopped' }))
      else {
        if (error instanceof ApiError && error.status === 404 && generation.current === mine) { session.current = null; setCurrent(null) }
        update((turn) => ({ ...turn, status: 'error', error: (error as Error).message }))
      }
    } finally {
      if (controller.current === abort) { controller.current = null; setBusy(false) }
      void refresh()
    }
  }

  const reset = () => {
    generation.current++
    controller.current?.abort()
    controller.current = null
    setBusy(false)
    session.current = null
    setCurrent(null)
    setTurns([])
  }

  return {
    turns, busy, chats, current, loading, send, reset, refresh,
    stop: () => controller.current?.abort(),
    async select(id) {
      if (id === session.current) return
      reset()
      setLoading(true)
      try {
        const record = await api<{ turns: ChatTurn[] }>(`chats/${encodeURIComponent(id)}`)
        session.current = id
        setCurrent(id)
        setTurns(record.turns)
      } catch (error) {
        setTurns([{ role: 'assistant', text: '', status: 'error', tools: [], warnings: [], error: (error as Error).message }])
        void refresh()
      } finally { setLoading(false) }
    },
    async remove(id) {
      if (id === session.current) reset()
      try { await api(`chat/${encodeURIComponent(id)}`, { method: 'DELETE' }) } finally { void refresh() }
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

function AssistantMessage({ turn, openItem, settings }: { turn: AssistantTurn; openItem: (id: string) => void; settings: () => void }) {
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
      {t.ok === undefined ? (streaming ? <LoaderCircle className="size-3 animate-spin" /> : <X className="size-3" />) : t.ok ? <Check className="size-3" /> : <X className="size-3 text-destructive" />}{toolLabel(t.name)}
    </Badge>)}</div>}
    {turn.text ? <div ref={body} className="prose-report prose-chat" onClick={(e) => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.cite'); if (b && !b.disabled && b.dataset.id) openItem(b.dataset.id) }} dangerouslySetInnerHTML={{ __html: streaming ? withCaret(renderMarkdown(turn.text)) : renderMarkdown(turn.text) }} />
      : streaming && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{turn.tools.some((t) => t.ok === undefined) ? '正在调用工具…' : '思考中…'}</p>}
    {turn.status === 'error' && <Notice className="border-destructive/30 text-destructive">{turn.error}{/模型设置/.test(turn.error ?? '') && <Button size="sm" variant="outline" className="mt-2 flex text-foreground" onClick={settings}><Settings />打开模型设置</Button>}</Notice>}
    {turn.status === 'stopped' && <p className="text-xs text-muted-foreground">已停止</p>}
    {turn.warnings.map((w) => <p key={w} className="text-xs text-muted-foreground">{w}</p>)}
    {turn.status === 'done' && <p className="text-xs text-muted-foreground">
      {turn.stop_reason && turn.stop_reason !== 'completed' ? `未完整结束（${turn.stop_reason}）· ` : ''}
      {invalid.size ? `${invalid.size} 个引用在数据中找不到 · ` : ''}已知 token {turn.tokens ?? 0}
    </p>}
  </div>
}

function ChatHistory({ chat, onPick }: { chat: ChatState; onPick?: () => void }) {
  return <div className="flex min-h-0 flex-1 flex-col">
    <Button variant="outline" className="m-3 mb-2" onClick={() => { chat.reset(); onPick?.() }}><Plus />新对话</Button>
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      {chat.chats.length === 0 ? <Empty>还没有历史对话</Empty> : chat.chats.map((c) => <div key={c.id} className={cn('group flex items-center rounded-md transition-colors', chat.current === c.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60')}>
        <button type="button" className="min-w-0 flex-1 px-3 py-2 text-left" onClick={() => { void chat.select(c.id); onPick?.() }}>
          <span className="block truncate text-sm">{c.title}</span>
          <small className="block truncate text-[11px] text-muted-foreground">{relativeTime(c.updated_at)} · {Math.ceil(c.turns / 2)} 轮</small>
        </button>
        <button type="button" aria-label={`删除对话 ${c.title}`} className="mr-1.5 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 max-lg:opacity-100"
          onClick={() => { if (confirm(`删除对话“${c.title}”？删除后无法恢复。`)) void chat.remove(c.id) }}><Trash2 className="size-3.5" /></button>
      </div>)}
    </div>
  </div>
}

function CommandMenu({ commands, active, onPick }: { commands: ChatCommand[]; active: number; onPick: (c: ChatCommand) => void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { box.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' }) }, [active])
  return <div ref={box} role="listbox" aria-label="命令" className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-72 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg">
    {commands.map((c, i) => <button key={c.name} type="button" role="option" aria-selected={i === active} data-active={i === active || undefined}
      onMouseDown={(e) => { e.preventDefault(); onPick(c) }}
      className="flex w-full items-baseline gap-2 rounded-md px-2.5 py-2 text-left text-sm data-[active]:bg-accent data-[active]:text-accent-foreground">
      <span className="font-mono font-medium">/{c.name}</span>
      {c.arg && <span className="font-mono text-xs text-muted-foreground">{c.arg.required ? `<${c.arg.hint}>` : `[${c.arg.hint}]`}</span>}
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.description}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground">{'action' in c.run ? '本地' : '模型'}</span>
    </button>)}
  </div>
}

export interface ChatActions { open: () => void; search: (query: string) => void; settings: () => void }

export function ChatView({ chat, o, openItem, actions, modelReady }: { chat: ChatState; o: Overview | null; openItem: (id: string) => void; actions: ChatActions; modelReady: boolean | null }) {
  const [draft, setDraft] = useState('')
  const [hint, setHint] = useState('')
  const [active, setActive] = useState(0)
  const [menuClosed, setMenuClosed] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const last = chat.turns.at(-1)
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }) }, [chat.turns.length, last?.role === 'assistant' ? last.text : ''])
  const commands = menuClosed ? [] : matchCommands(draft)
  const typingName = /^\/\S*$/.test(draft)
  const edit = (value: string) => { setDraft(value); setHint(''); setActive(0); setMenuClosed(false) }

  const submit = (text = draft) => {
    if (!text.trim() || chat.busy) return
    const parsed = parseCommand(text)
    if (parsed && 'error' in parsed) { setHint(parsed.error); return }
    setDraft(''); setHint('')
    if (!parsed) return void chat.send(text, o?.id)
    if ('prompt' in parsed) return void chat.send(parsed.prompt, o?.id, text.trim())
    if (parsed.action === 'new') chat.reset()
    else if (parsed.action === 'open') actions.open()
    else if (o) actions.search(parsed.arg ?? '')
    else { setDraft(text); setHint('先打开数据文件，才能在原文页检索') }
  }
  const pick = (c: ChatCommand) => {
    if (c.arg) { edit(`/${c.name} `); input.current?.focus() } else submit(`/${c.name}`)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (commands.length && typingName) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : commands.length - 1)) % commands.length); return }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pick(commands[Math.min(active, commands.length - 1)]!); return }
    }
    if (e.key === 'Escape' && commands.length) { e.preventDefault(); setMenuClosed(true); return }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
  }
  const suggestions = o ? SUGGESTIONS_WITH_DATA : SUGGESTIONS_WITHOUT_DATA
  const title = chat.chats.find((c) => c.id === chat.current)?.title
  const height = 'h-[calc(100dvh-8.5rem)] min-h-[480px]'

  return <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
    <Card className={cn('hidden flex-col gap-0 p-0 lg:flex', height)}>
      <p className="border-b px-4 py-3.5 text-sm font-semibold">历史对话</p>
      <ChatHistory chat={chat} />
    </Card>
    <Sheet open={historyOpen} onOpenChange={setHistoryOpen} title="历史对话"><div className="-mx-3 flex h-full flex-col"><ChatHistory chat={chat} onPick={() => setHistoryOpen(false)} /></div></Sheet>
    <Card className={cn('flex flex-col gap-0 p-0', height)}>
      <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5">
        <div className="min-w-0">
          <h1 className="truncate font-semibold leading-none">{title ?? '对话'}</h1>
          <p className="mt-1.5 truncate text-xs text-muted-foreground">{o ? `已接入：${baseName(o.file)}` : '未打开数据：可以让模型查找并导入文件'}</p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button variant="outline" size="sm" className="lg:hidden" aria-label="历史对话" onClick={() => { void chat.refresh(); setHistoryOpen(true) }}><History /><span className="hidden sm:inline">历史</span></Button>
          <Button variant="outline" size="sm" className="lg:hidden" aria-label="新对话" onClick={() => { chat.reset(); setDraft('') }} disabled={!chat.turns.length}><Plus /><span className="hidden sm:inline">新对话</span></Button>
        </div>
      </div>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        {chat.loading ? <p className="flex justify-center py-10 text-sm text-muted-foreground"><LoaderCircle className="mr-2 size-4 animate-spin" />读取对话…</p>
          : chat.turns.length === 0 ? <div className="mx-auto flex max-w-xl flex-col items-center py-[6vh] text-center">
            <span className="mb-4 grid size-10 place-items-center rounded-lg border shadow-xs"><MessageCircle className="size-5" /></span>
            <h2 className="text-lg font-semibold">用自然语言追问数据</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">回答会引用原文 ID，点击即可查看原文。输入 <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-foreground">/</code> 查看快捷命令。对话使用 ugc-lens 配置的模型，会产生调用费用。</p>
            {modelReady === false && <Notice className="mt-5 flex flex-wrap items-center justify-center gap-3 text-left">还没有配置模型，对话需要先填写 API key 和模型。<Button size="sm" onClick={actions.settings}><Settings />配置模型</Button></Notice>}
            <div className="mt-6 flex flex-wrap justify-center gap-2">{suggestions.map((s) => <Button key={s} variant="outline" size="sm" className="font-normal" onClick={() => submit(s)}>{s}</Button>)}</div>
          </div> : <div className="mx-auto max-w-3xl space-y-6">
            {chat.turns.map((turn, i) => turn.role === 'user'
              ? <div key={i} className="flex justify-end"><p className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground">{turn.text}</p></div>
              : <AssistantMessage key={i} turn={turn} openItem={openItem} settings={actions.settings} />)}
          </div>}
      </div>
      <form className="border-t p-3 sm:p-4" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <div className="relative mx-auto max-w-3xl">
          {commands.length > 0 && <CommandMenu commands={commands} active={typingName ? active : -1} onPick={pick} />}
          <div className="flex items-end gap-2 rounded-lg border bg-background p-2 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
            <textarea ref={input} aria-label="输入问题" value={draft} rows={1} onChange={(e) => edit(e.target.value)} onKeyDown={onKeyDown}
              placeholder={o ? '问问这份数据，或输入 / 查看命令' : '描述要做的事，或输入 / 查看命令'}
              className={cn('max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground', '[field-sizing:content]')} />
            {chat.busy
              ? <Button type="button" size="icon" variant="outline" aria-label="停止" onClick={chat.stop}><Square className="size-3.5 fill-current" /></Button>
              : <Button type="submit" size="icon" aria-label="发送" disabled={!draft.trim()}><ArrowUp /></Button>}
          </div>
        </div>
        <p className={cn('mx-auto mt-1.5 max-w-3xl px-1 text-[11px]', hint ? 'text-destructive' : 'text-muted-foreground')}>{hint || 'Enter 发送，Shift+Enter 换行，输入 / 查看命令'}</p>
      </form>
    </Card>
  </div>
}
