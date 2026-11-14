export interface ItemView {
  id: string
  kind: string
  text: string
  author?: string
  location?: string
  created_at?: string
  likes?: number
  reply_count?: number
  video_time_sec?: number
  parent_id?: string
}

export interface Term { word: string; docs: number }

export interface Peak { start_sec: number; end_sec: number; count: number; baseline: number; groups: Array<{ id: string; text: string; count: number; first_sec?: number }>; terms: Term[] }

interface LabelBase { dir: string; coverage: number; counts: unknown }
interface Scope { scope_note?: string }
export type LabelResult = LabelBase & (
  | { task: 'sentiment'; summary: Scope & { target: string; summary: { evaluated: number; total: number; counts: Record<string, number>; proportions: Record<string, number>; mean_score: number | null } } }
  | { task: 'topics'; summary: Scope & { topics: Array<{ title: string; count: number; share: number }>; unclassified: number; uncertain: number } }
  | { task: 'business'; summary: Scope & { opportunities?: Array<{ title: string; problem: string; quote: string; refs: string[]; priority: string; effort: string; validation: string }> } }
)

export interface Overview {
  id: string
  platform: string
  file: string
  mapping: 'builtin' | 'cache' | 'model'
  contents: Array<{ id: string; title?: string; author?: string; published_at?: string; url?: string; description?: string; transcript_lines: number }>
  stats: { items: Record<string, number>; with_location: number; locations: Array<{ name: string; count: number }> }
  daily: Array<{ day: string; count: number }>
  keywords: Term[]
  danmaku?: { total: number; unique: number; bin_sec: number; timeline: number[]; terms: Term[]; peaks: Peak[] }
  top: ItemView[]
  labels: LabelResult[]
}

export interface FileEntry { path: string; size: number; mtime: string; kind?: 'data' | 'report'; opened_at?: string }

export interface FilesResponse { cwd: string; picker: boolean; recent: FileEntry[]; files: FileEntry[] }

export interface ProviderInfo { id: string; name: string; regions: boolean; key: 'required' | 'optional' | 'none'; key_env?: string; base_url?: string | Record<'cn' | 'global', string> }

export interface SettingsView {
  path: string
  providers: ProviderInfo[]
  saved: { provider?: string; region: 'cn' | 'global'; base_url?: string; model?: string; has_key: boolean; endpoint?: string } | null
  effective: { ok: true; provider: string; model: string; base_url: string; has_key: boolean } | { ok: false; error: string }
  overrides: string[]
}
