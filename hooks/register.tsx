import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { AgentRow, TaskRow } from '../types'

type Api = Parameters<Hook<'turn.complete'>>[0]

const PANE = 'session-monitor'
const POLL_MS = 3000
const LIVE = new Set(['pending', 'running', 'waiting'])

const model = atom({ plugin: 'session-monitor', key: 'model' } as const, '')
const effort = atom({ plugin: 'session-monitor', key: 'effort' } as const, '')
const agents = atom({ plugin: 'session-monitor', key: 'agents' } as const, [])
const isBandOpen = atom({ plugin: 'session-monitor', key: 'isBandOpen' } as const, false)
const quota = atom({ plugin: 'session-monitor', key: 'quota' } as const, {})
const isCollapsed = atom({ plugin: 'session-monitor', key: 'isCollapsed' } as const, false)
// The buddy's mood between turns, and whether a tool call is waiting on the person.
const mood = atom({ plugin: 'session-monitor', key: 'mood' } as const, 'idle')
const isAsking = atom({ plugin: 'session-monitor', key: 'isAsking' } as const, false)
// The off-Claude worker a foreground Bash call is waiting on right now (kimi, gemini, openrouter).
const activeWorker = atom({ plugin: 'session-monitor', key: 'activeWorker' } as const, '')
// When the main thread last called the model (each call refreshes the prompt cache; -1 before the first), and the clock
// the pie reads, ticked while the cache is warm.
const cacheAt = atom({ plugin: 'session-monitor', key: 'cacheAt' } as const, -1)
const cacheNow = atom({ plugin: 'session-monitor', key: 'cacheNow' } as const, 0)
// The main thread's own task list (TaskCreate/TaskUpdate or TodoWrite), and whether its steps are listed.
const tasks = atom({ plugin: 'session-monitor', key: 'tasks' } as const, [])
const isTasksOpen = atom({ plugin: 'session-monitor', key: 'isTasksOpen' } as const, false)
// The turn under way (-1 between turns), the clock its timer reads, its tool calls and the one running now.
const turnAt = atom({ plugin: 'session-monitor', key: 'turnAt' } as const, -1)
const turnNow = atom({ plugin: 'session-monitor', key: 'turnNow' } as const, 0)
const turnSteps = atom({ plugin: 'session-monitor', key: 'turnSteps' } as const, 0)
const activity = atom({ plugin: 'session-monitor', key: 'activity' } as const, '')

const shortModel = (id: string) =>
  id
    .replace(/^claude-/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/\[.*\]$/, '')

// A worker's quota shows once this much of it is used.
const QUOTA_WARN = 70
const QUOTA_MS = 5 * 60_000
// The buddy dozes off after this long with nothing happening.
const SLEEP_MS = 4 * 60_000
// The prompt cache lives this long after the last request; the pie counts it down.
const CACHE_MS = 60 * 60_000
const CACHE_TICK_MS = 30_000
const HANDOVER_PROMPT = 'Use the handover skill: write a handover of this session I can paste into a new one.'

const ACCENT = '#D97757'
const MUTED = '#9AA5B8'
const WORKER_COLORS: Record<string, string> = {
  haiku: '#69B9C5',
  sonnet: '#6E8FD6',
  opus: ACCENT,
  fable: '#8B7CF6',
  kimi: '#E8BF5E',
  gemini: '#93C47D',
  openrouter: '#EC9CB8',
}

const dot = (status: string): { glyph: string; color: string } =>
  status === 'running' || status === 'pending'
    ? { glyph: '●', color: '#93C47D' }
    : status === 'waiting' || status === 'idle'
      ? { glyph: '●', color: '#E8BF5E' }
      : status === 'failed' || status === 'killed'
        ? { glyph: '✕', color: '#E5484D' }
        : { glyph: '✓', color: 'inactive' }

// Wrapper calls that refresh the quota once they return.
const LOG_RE = /(kimi|gemini|openrouter)\.sh|usage\/scripts\/log\.py/

const family = (id: string) => {
  const m = id.toLowerCase()
  for (const f of ['haiku', 'sonnet', 'opus', 'fable']) if (m.includes(f)) return f
  return shortModel(id)
}

const label = (key: string) =>
  ({ haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable', kimi: 'Kimi', gemini: 'Gemini', openrouter: 'OpenRouter' })[key] ?? key

// A tiny figure per model family, 14px, in the model's color: Opus a bunny, Sonnet a star,
// Haiku a ghost, Fable a moon. Its eyes show the session: glancing around while working, round
// while waiting on you, ^ ^ when a turn finishes, × after an error, closed with a z when asleep.
// All motion is CSS and stops under reduced motion.
function buddySvg(fam: string, state: string) {
  const color = WORKER_COLORS[fam] ?? MUTED
  const shapes: Record<string, string> = {
    opus: '<rect x="4" y=".6" width="2.6" height="7.4" rx="1.3"/><rect x="9.4" y=".6" width="2.6" height="7.4" rx="1.3"/><circle cx="8" cy="10.4" r="5.4"/>',
    sonnet: '<path d="M8 1.4L10.29 5.64L15.04 6.51L11.71 10.01L12.35 14.79L8 12.7L3.65 14.79L4.29 10.01L.96 6.51L5.71 5.64Z" stroke="' + color + '" stroke-width="1.4" stroke-linejoin="round"/>',
    haiku: '<path d="M2 15V8a6 6 0 0 1 12 0v7l-2-1.6-2 1.6-2-1.6-2 1.6-2-1.6z"/>',
    fable: '<mask id="m"><rect width="16" height="16" fill="#fff"/><circle cx="12.4" cy="5.6" r="5.4" fill="#000"/></mask><circle cx="8" cy="8.6" r="6.8" mask="url(#m)"/>',
  }
  // Where each figure's two eyes sit: x of the left eye, x of the right, y.
  const spots: Record<string, number[]> = { opus: [6, 10, 10.6], sonnet: [6.7, 9.3, 9.2], haiku: [6, 10, 9], fable: [3.7, 6.3, 10] }
  const [lx, rx, ey] = spots[fam] ?? spots.opus
  const delay = ({ opus: 0, sonnet: 1.3, haiku: 2.1, fable: 0.7 } as Record<string, number>)[fam] ?? 0
  const eye = (x: number) => {
    if (state === 'happy') return `<path class="s" d="M${x - 1.1} ${ey + 0.5}l1.1-1.2 1.1 1.2"/>`
    if (state === 'error') return `<path class="s" d="M${x - 0.9} ${ey - 0.9}l1.8 1.8m0-1.8l-1.8 1.8"/>`
    if (state === 'sleep') return `<path class="s" d="M${x - 1} ${ey + 0.2}h2"/>`
    if (state === 'waiting') return `<ellipse class="e" cx="${x}" cy="${ey + 0.4}" rx="1.25" ry="1.75"/>`
    return `<ellipse class="e" cx="${x}" cy="${ey}" rx="1" ry="1.45"/>`
  }
  const look = state === 'working' ? 3.2 : 8
  const blink = state === 'waiting' ? 3 : 4.6
  const zz = state === 'sleep' ? '<path class="z" d="M12 1.2h2.4l-2.4 2.6h2.4"/>' : ''
  const css =
    // Eyes: ink in light mode, a near-black in dark mode so they keep their contrast on the body.
    ':root{--k:#2B1D0E}@media (prefers-color-scheme:dark){:root{--k:#141016}}' +
    '.k{fill:var(--k)}.s{fill:none;stroke:var(--k);stroke-width:.9;stroke-linecap:round;stroke-linejoin:round}' +
    `.z{fill:none;stroke:${MUTED};stroke-width:.7;stroke-linecap:round;stroke-linejoin:round;animation:z 3s infinite}` +
    `.e{transform-box:fill-box;transform-origin:center;animation:b ${blink}s ${delay}s infinite}` +
    (state === 'waiting' || state === 'sleep' ? '' : `.l{animation:l ${look}s ${delay}s infinite}`) +
    (state === 'working' ? '.f{animation:f 1.4s ease-in-out infinite}' : '') +
    '@keyframes b{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.15)}}' +
    '@keyframes l{0%,30%,100%{transform:translateX(0)}36%,52%{transform:translateX(-.7px)}58%,76%{transform:translateX(.7px)}}' +
    '@keyframes f{0%,100%{transform:translateY(0)}50%{transform:translateY(-.6px)}}' +
    '@keyframes z{0%,100%{opacity:.3;transform:translateY(0)}50%{opacity:1;transform:translateY(-.5px)}}' +
    '@media (prefers-reduced-motion:reduce){.e,.l,.f,.z{animation:none}}'
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><style>${css}</style><g class="f">` +
    `<g fill="${color}">${shapes[fam] ?? shapes.opus}</g>` +
    `<g class="l k">${eye(lx)}${eye(rx)}</g>${zz}</g></svg>`
  )
}

// The terminal has no Svg: a kawaii glyph in the model's color instead.
function ModelMark(ui: any, id: string, state: string) {
  const fam = family(id)
  if ('Svg' in ui) return <ui.Svg key="mark" source={buddySvg(fam, state)} alt={`${label(fam)} buddy, ${state}`} width={14} height={14} />
  const glyph = ({ opus: '❀', sonnet: '★', haiku: '◓', fable: '☾' } as Record<string, string>)[fam] ?? '◆'
  return (
    <ui.Text key="mark" size="caption" color={WORKER_COLORS[fam] ?? ACCENT}>
      {glyph}
    </ui.Text>
  )
}

// Share of each worker's quota used, from the usage skill's quota script.
// Gemini has no quota API, so it never appears here.
let quotaAt = 0
async function refreshQuota($: Api, force = false) {
  const now = await $.clock.now()
  if (!force && now - quotaAt < QUOTA_MS) return
  quotaAt = now
  const home = await $.env.get('HOME')
  const { exitCode, stdout } = await $.process.run(['python3', `${home}/.claude/skills/usage/scripts/quota.py`], { stdin: '', timeoutMs: 20_000 })
  if (exitCode !== 0) return
  const parsed = JSON.parse(stdout) as Record<string, unknown>
  const next: Record<string, number> = {}
  for (const [k, v] of Object.entries(parsed)) if (typeof v === 'number') next[k] = v
  await update($, quota, () => next)
}

const quotaTone = (pct: number) => (pct >= 90 ? '#E5484D' : '#E8BF5E')

// Learned from agent.spawn results and each subagent's turn.step.
const agentModels = new Map<string, string>()
let timer: { cancel: () => void } | undefined

async function refreshAgents($: Api) {
  const list = await $.agent.list()
  const prev = await read($, agents)
  const rows = list.map(
    (a): AgentRow => ({
      id: a.id,
      description: a.description,
      type: a.type,
      status: a.status,
      model: agentModels.get(a.id) ?? prev.find(p => p.id === a.id)?.model,
    }),
  )
  // This runs every few seconds while agents work; an unchanged list must not redraw the band.
  if (JSON.stringify(rows) !== JSON.stringify(prev)) await update($, agents, () => rows)
  if (!timer && list.some(a => LIVE.has(a.status))) {
    timer = $.clock.after(POLL_MS, () => {
      timer = undefined
      void refreshAgents($)
    })
  }
}

// --- Prompt cache countdown ------------------------------------------------

let cacheTick: { cancel: () => void } | undefined

async function touchCache($: Api) {
  const now = await $.clock.now()
  await update($, cacheAt, () => now)
  await update($, cacheNow, () => now)
  startCacheTick($)
}

// Moves the pie's clock on until the cache has gone cold.
function startCacheTick($: Api) {
  if (cacheTick) return
  cacheTick = $.clock.every(CACHE_TICK_MS, () => {
    void (async () => {
      const t = await $.clock.now()
      await update($, cacheNow, () => t)
      if (t - (await read($, cacheAt)) >= CACHE_MS) {
        cacheTick?.cancel()
        cacheTick = undefined
      }
    })()
  })
}

const cacheTone = (min: number) => (min <= 0 ? MUTED : min <= 5 ? '#E5484D' : min <= 15 ? '#E8BF5E' : '#93C47D')

// A pie: the filled wedge is what is left of the hour, clockwise from 12. Empty ring once cold.
function pieSvg(frac: number, color: string) {
  const r = 6
  const ring = `<circle cx="8" cy="8" r="${r + 0.9}" fill="none" stroke="${color}" stroke-opacity=".45" stroke-width="1"/>`
  if (frac <= 0) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${ring}</svg>`
  if (frac >= 0.999) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${ring}<circle cx="8" cy="8" r="${r}" fill="${color}"/></svg>`
  const a = frac * 2 * Math.PI
  const x = (8 + r * Math.sin(a)).toFixed(2)
  const y = (8 - r * Math.cos(a)).toFixed(2)
  const wedge = `<path d="M8 8V${8 - r}A${r} ${r} 0 ${frac > 0.5 ? 1 : 0} 1 ${x} ${y}Z" fill="${color}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${ring}${wedge}</svg>`
}

// Minutes left on the cache, or undefined before the first model call.
async function cacheLeft($: Api) {
  const at = await read($, cacheAt)
  if (at < 0) return undefined
  const now = Math.max(await read($, cacheNow), at)
  return Math.max(0, Math.ceil((CACHE_MS - (now - at)) / 60_000))
}

// The pie at the band's edge, then the minutes left; pressing the minutes asks for a handover.
// Svg can't sit inside a Button, so on desktop the pie is the picture and the minutes the control.
function CachePie($: Api, ui: any, min: number) {
  const { Box, Text, Button } = ui
  const color = cacheTone(min)
  const glyph = min <= 0 ? '○' : min > 45 ? '●' : min > 30 ? '◕' : min > 15 ? '◑' : '◔'
  const left = min > 0 ? `${min}m` : 'cold'
  const alt = min > 0 ? `Prompt cache warm, ${min} minutes left` : 'Prompt cache expired'
  return (
    <Box key="cache-pie" flexDirection="row" alignItems="center" columnGap={1}>
      {'Svg' in ui ? <ui.Svg source={pieSvg(min / 60, color)} alt={alt} width={12} height={12} /> : <Text color={color}>{glyph}</Text>}
      <Button key="cache" plain dimColor label={left} onPress={() => $.prompt.submit({ text: HANDOVER_PROMPT })} />
    </Box>
  )
}

let moodTimer: { cancel: () => void } | undefined

// A passing mood (happy, error) shows for `ms`, then settles to idle; idle dozes off after a while.
async function setMood($: Api, next: string, ms?: number) {
  moodTimer?.cancel()
  moodTimer = undefined
  await update($, mood, () => next)
  if (ms) moodTimer = $.clock.after(ms, () => void setMood($, 'idle'))
  else if (next === 'idle') moodTimer = $.clock.after(SLEEP_MS, () => void setMood($, 'sleep'))
}

// --- Turn progress ----------------------------------------------------------

// Shown once a turn has run this long, so quick answers don't flash it.
const TURN_SHOW_MS = 15_000
const TURN_TICK_MS = 15_000

let turnTick: { cancel: () => void } | undefined

function startTurnTick($: Api) {
  if (turnTick) return
  turnTick = $.clock.every(TURN_TICK_MS, () => {
    void (async () => {
      const t = await $.clock.now()
      await update($, turnNow, () => t)
    })()
  })
}

async function startTurn($: Api) {
  if ((await read($, turnAt)) >= 0) return
  const now = await $.clock.now()
  await update($, turnAt, () => now)
  await update($, turnNow, () => now)
  await update($, turnSteps, () => 0)
  await update($, activity, () => '')
  startTurnTick($)
}

async function endTurn($: Api) {
  turnTick?.cancel()
  turnTick = undefined
  await update($, turnAt, () => -1)
  await update($, activity, () => '')
}

const elapsed = (ms: number) => {
  const min = Math.floor(ms / 60_000)
  return min < 1 ? '<1m' : min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`
}

const baseName = (path: unknown) => (typeof path === 'string' ? path.split('/').pop() ?? path : '')

function describe(e: any): string {
  const tool = String(e.tool)
  if (tool === 'Bash') return `Bash: ${e.description || String(e.command ?? '').split('\n')[0]}`
  if (['Edit', 'Write', 'Read', 'NotebookEdit'].includes(tool)) return `${tool} ${baseName(e.file_path ?? e.notebook_path)}`
  if (tool === 'Agent') return `Agent: ${e.description ?? ''}`
  if (tool === 'Skill') return `Skill: ${e.skill ?? ''}`
  if (tool === 'WebSearch') return `Search: ${e.query ?? ''}`
  if (tool === 'WebFetch') return `Fetch: ${e.url ?? ''}`
  return tool.startsWith('mcp__') ? tool.split('__').slice(-1)[0] : tool
}

// The progress strip when there is no task list: time, tool calls and the call running now.
function turnLine(at: number, now: number, steps: number, doing: string, level: number) {
  if (at < 0 || now - at < TURN_SHOW_MS) return { text: '', cells: 0 }
  const parts = [`⏱ ${elapsed(now - at)}`, ...(level < 3 ? [`${steps} ${steps === 1 ? 'step' : 'steps'}`] : [])]
  const fixed = `  ${parts.join(' · ')}`
  return { text: level < 2 ? `${fixed} · ${cut(doing || 'thinking…', 32)}` : fixed, cells: fixed.length }
}

// --- Task progress ----------------------------------------------------------

// Short lists stay quiet; a finished list shows "Done" this long, then goes.
const TASKS_MIN = 3
const TASKS_DONE_MS = 4000
const TASK_ROWS = 5
const DONE_COLOR = '#93C47D'

const isDone = (list: TaskRow[]) => list.length > 0 && list.every(t => t.status === 'completed')

let tasksTimer: { cancel: () => void } | undefined

async function setTasks($: Api, fn: (all: TaskRow[]) => TaskRow[]) {
  await update($, tasks, fn)
  tasksTimer?.cancel()
  tasksTimer = undefined
  if (isDone(await read($, tasks))) tasksTimer = $.clock.after(TASKS_DONE_MS, () => void clearTasks($))
}

async function clearTasks($: Api) {
  await update($, tasks, () => [])
  await update($, isTasksOpen, () => false)
}

const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text)

// The progress strip at each fitting level: bar, count and the step under way.
// 0–1 "▰▰▰▰▰▱▱▱ 3/5 · 60% Writing tests…" · 2 "▰▰▰▱ 60% Writing…" · 3 "60%".
function progress(list: TaskRow[], level: number) {
  const n = list.filter(t => t.status === 'completed').length
  const done = n === list.length
  const pct = Math.round((n / list.length) * 100)
  const width = level >= 3 ? 0 : level >= 2 ? 4 : 8
  const filled = done ? width : Math.floor((n / list.length) * width)
  const cur = list.find(t => t.status === 'in_progress')
  const step = done ? '' : level >= 3 || !cur ? '' : cut(cur.active || cur.subject, level >= 2 ? 16 : 28)
  const count = done ? (level >= 2 ? '✓' : `${n}/${list.length} ✓ Done`) : level >= 2 ? `${pct}%` : `${n}/${list.length} · ${pct}%`
  const bar = '▰'.repeat(filled) + '▱'.repeat(width - filled)
  const cells = bar.length + (bar ? 1 : 0) + count.length + (step ? 2 + step.length : 0)
  return { bar, count, step, done, cells }
}

// The steps, at most TASK_ROWS of them, starting just before the one under way.
function taskRows(list: TaskRow[]) {
  const at = list.findIndex(t => t.status !== 'completed')
  const from = Math.max(0, Math.min((at < 0 ? list.length : at) - 1, list.length - TASK_ROWS))
  const rows = list.slice(from, from + TASK_ROWS)
  return { rows, earlier: from, later: list.length - from - rows.length }
}

const taskGlyph = (status: string) =>
  status === 'completed' ? { glyph: '✓', color: 'inactive' } : status === 'in_progress' ? { glyph: '●', color: ACCENT } : { glyph: '○', color: 'inactive' }

async function toggleCollapsed($: Api) {
  const next = !(await read($, isCollapsed))
  await update($, isCollapsed, () => next)
  await $.store.set('collapsed', next)
}

type ChipData = { key: string; provider: string; color: string; name: string; n: number; used?: number }

// compact swaps the name for a coloured initial, "K 2 · G 2 · O 1", so a narrow band still says who.
// Opus gets two letters so it never reads as OpenRouter.
const INITIALS: Record<string, string> = { kimi: 'K', gemini: 'G', openrouter: 'O', haiku: 'H', sonnet: 'S', opus: 'Op', fable: 'F' }
const initial = (c: ChipData) => INITIALS[c.provider] ?? c.name.slice(0, 1)

const Chip = (Text: any, c: ChipData, compact = false, first = true) => (
  <Text key={c.key}>
    {compact ? <Text dimColor>{first ? ' ' : ' · '}</Text> : '  '}
    {compact ? <Text color={c.color}>{initial(c)}</Text> : <Text color={c.color}>●</Text>}
    {compact ? '' : ` ${c.name}`}
    {c.n ? <Text weight="semibold"> {c.n}</Text> : ''}
    {c.used !== undefined ? <Text color={quotaTone(c.used)}> {Math.round(c.used)}%</Text> : ''}
  </Text>
)

const chipCells = (c: ChipData, compact: boolean) =>
  (compact ? 3 + initial(c).length : 3 + c.name.length) + (c.n ? 1 + String(c.n).length : 0) + (c.used !== undefined ? 2 + String(Math.round(c.used)).length : 0)

// One line: the model at work, the worker it is waiting on, and live agents.
async function Card($: Api, e: { surface: string }, ui: any, mode: 'band' | 'pane') {
  const { Box, Text, Button } = ui
  const m = await read($, model)
  const eff = await read($, effort)
  const list = await read($, agents)
  const q = await read($, quota)
  const low = (k: string) => (q[k] !== undefined && q[k] >= QUOTA_WARN ? q[k] : undefined)
  const isOpen = mode === 'pane' || (await read($, isBandOpen))
  const live = list.filter(a => LIVE.has(a.status))
  const done = list.filter(a => !LIVE.has(a.status))
  const shown = [...live, ...done.slice(-3).reverse()]
  const name = m ? shortModel(m) : 'model ?'
  const worker = await read($, activeWorker)
  // What the buddy shows: waiting on you beats working beats the mood between turns.
  const isWorking = (e as any).props?.isWorking === true
  const state = (await read($, isAsking)) ? 'waiting' : isWorking ? 'working' : await read($, mood)
  const cacheMin = mode === 'band' ? await cacheLeft($) : undefined
  const tl = await read($, tasks)
  const hasTasks = tl.length >= TASKS_MIN
  const isTasksShown = hasTasks && (await read($, isTasksOpen))
  const tAt = mode === 'band' && !hasTasks ? await read($, turnAt) : -1
  const tNow = await read($, turnNow)
  const tSteps = await read($, turnSteps)
  const doing = await read($, activity)
  const turnInfo = (level: number) => turnLine(tAt, tNow, tSteps, doing, level)
  const ProgressButton = (level: number) => {
    const pr = progress(tl, level)
    return (
      <Button key="tasks" plain onPress={() => update($, isTasksOpen, open => !open)}>
        <Text size="caption" tabular wrap="truncate-end">
          {pr.bar ? <Text color={pr.done ? DONE_COLOR : ACCENT}>{pr.bar} </Text> : ''}
          <Text weight="semibold" color={pr.done ? DONE_COLOR : undefined}>{pr.count}</Text>
          {pr.step ? <Text dimColor>{'  '}{pr.step}</Text> : ''}
        </Text>
      </Button>
    )
  }

  if (mode === 'band' && (await read($, isCollapsed))) {
    return (
      <Box flexDirection="row" alignItems="center" columnGap={1} paddingX="sm">
        {ModelMark(ui, m, state)}
        <Button key="show" plain onPress={() => toggleCollapsed($)}>
          <Text size="caption" dimColor>
            {name} ▸
          </Text>
        </Button>
        {hasTasks && ProgressButton(3)}
        {turnInfo(3).text ? <Text size="caption" dimColor tabular>{turnInfo(3).text}</Text> : ''}
        {cacheMin !== undefined && CachePie($, ui, cacheMin)}
      </Box>
    )
  }

  const chip = (key: string, k: string, n: number, used?: number): ChipData => ({ key, provider: k, color: WORKER_COLORS[k] ?? MUTED, name: label(k), n, used })
  // A worker running low on quota, whether or not this session has used it.
  const lowData = Object.keys(q)
    .filter(k => low(k) !== undefined)
    .map(k => chip(`q-${k}`, k, 0, low(k)))
  const perModel = new Map<string, number>()
  for (const a of live) if (a.model) perModel.set(label(family(a.model)), (perModel.get(label(family(a.model))) ?? 0) + 1)
  const liveModels = [...perModel].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))

  // Fit the row to the band's width instead of wrapping: each level drops a little more.
  // 0 full · 1 no effort · 2 chips as initials, short agent and worker text · 3 no labels at all.
  const agentText = (level: number) =>
    !live.length
      ? level >= 3 ? `${list.length}` : `${list.length} agents`
      : level >= 2
      ? level >= 3 ? `${live.length}` : `${live.length} running`
      : `${live.length} running${liveModels.length ? ` · ${liveModels.join(', ')}` : ''}`
  const showAgents = mode === 'pane' || list.length > 0
  const cellsAt = (level: number) => {
    const compact = level >= 2
    const left =
      2 + name.length +
      (eff && level < 1 ? 3 + eff.length : 0) +
      (worker ? 6 + label(worker).length + (compact ? 0 : 9) : 0) +
      (lowData.length ? (level < 3 ? 6 : 1) : 0) +
      lowData.reduce((sum, c) => sum + chipCells(c, compact), 0) +
      (hasTasks ? 3 + progress(tl, level).cells : 0) +
      turnInfo(level).cells
    const right =
      (showAgents && mode === 'band' ? 4 + agentText(level).length : 0) +
      (mode === 'band' ? 6 : 0) +
      (cacheMin !== undefined ? 7 : 0)
    return left + right + 2
  }
  const cols = mode === 'band' ? Number((e as any).props?.bodyColumns) || 999 : 999
  const level = [0, 1, 2].find(l => cellsAt(l) <= cols) ?? 3
  const compact = level >= 2
  const lowOnly = lowData.map((c, i) => Chip(Text, c, compact, i === 0))

  return (
    <Box flexDirection="column" paddingX="sm">
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={compact ? 1 : 2}>
        <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={1}>
        {ModelMark(ui, m, state)}
        <Text size="caption" tabular wrap="truncate-end">
          <Text weight="semibold">{name}</Text>
          {eff && level < 1 ? <Text dimColor> · {eff}</Text> : ''}
          {worker ? (
            <Text>
              <Text dimColor>{'  → '}</Text>
              <Text color={WORKER_COLORS[worker] ?? MUTED}>●</Text> <Text weight="semibold">{label(worker)}</Text>
              {compact ? '' : <Text dimColor> working…</Text>}
            </Text>
          ) : (
            ''
          )}
          {lowOnly.length ? <Text dimColor>{level < 3 ? '   low' : ' '}</Text> : ''}
          {lowOnly}
          {turnInfo(level).text ? <Text dimColor>{turnInfo(level).text}</Text> : ''}
        </Text>
        {hasTasks && ProgressButton(level)}
        </Box>
        <Box flexDirection="row" columnGap={compact ? 1 : 2} flexShrink={0}>
          {mode === 'band' && list.length === 0 ? (
            ''
          ) : mode === 'band' ? (
            <Button key="agents" plain onPress={() => update($, isBandOpen, open => !open)}>
              <Text size="caption" dimColor={!live.length}>
                <Text color={live.length ? '#93C47D' : undefined}>{live.length ? '●' : '○'}</Text>{' '}
                {agentText(level)}
                {isOpen ? ' ▾' : ' ▸'}
              </Text>
            </Button>
          ) : (
            <Text size="caption" dimColor>
              {live.length ? `${live.length} running` : 'no agents running'}
            </Text>
          )}
          {cacheMin !== undefined && CachePie($, ui, cacheMin)}
          {mode === 'band' && (
            <Button key="hide" plain onPress={() => toggleCollapsed($)}>
              <Text size="caption" dimColor>
                hide
              </Text>
            </Button>
          )}
        </Box>
      </Box>

      {isTasksShown &&
        (() => {
          const { rows, earlier, later } = taskRows(tl)
          return [
            earlier ? (
              <Box key="t-earlier" paddingLeft={2}>
                <Text size="caption" dimColor>+{earlier} earlier</Text>
              </Box>
            ) : null,
            ...rows.map(t => {
              const g = taskGlyph(t.status)
              const isCur = t.status === 'in_progress'
              return (
                <Box key={`t-${t.id}`} flexDirection="row" columnGap={1} paddingLeft={2}>
                  <Text color={g.color}>{g.glyph}</Text>
                  <Text size="caption" dimColor={!isCur} weight={isCur ? 'semibold' : undefined} wrap="truncate-end">
                    {isCur ? `${t.active || t.subject}…` : t.subject}
                  </Text>
                </Box>
              )
            }),
            later ? (
              <Box key="t-later" paddingLeft={2}>
                <Text size="caption" dimColor>+{later} more</Text>
              </Box>
            ) : null,
          ].filter(Boolean)
        })()}
      {isOpen &&
        shown.map(a => {
          const s = dot(a.status)
          return (
            <Box key={a.id} flexDirection="row" columnGap={1} paddingLeft={2}>
              <Text color={s.color}>{s.glyph}</Text>
              <Text size="caption" dimColor={!LIVE.has(a.status)} wrap="truncate-end">
                {a.description}
              </Text>
              <Text size="caption" dimColor wrap="truncate-end">
                {a.type}
                {a.model ? ` · ${shortModel(a.model)}` : ''}
              </Text>
            </Box>
          )
        })}
      {isOpen && done.length > 3 && (
        <Box paddingLeft={2}>
          <Text size="caption" dimColor>
            +{done.length - 3} earlier
          </Text>
        </Box>
      )}
    </Box>
  )
}

// The main thread's task list. TodoWrite sends it whole; TaskCreate and TaskUpdate change one step.
const trackTasks: Hook<'tool.call'> = async ($, e, next) => {
  const ran = await next(e)
  const x = e as any
  const r = (ran as any)?.result
  if (x.agentId || !r || (ran as any).isError) return ran
  if (e.tool === 'TodoWrite' && Array.isArray(x.todos))
    await setTasks($, () =>
      x.todos.map((t: any, i: number) => ({ id: String(i), subject: String(t.content), active: String(t.activeForm ?? ''), status: t.status })),
    )
  else if (e.tool === 'TaskCreate' && r.task?.id)
    await setTasks($, all => [
      ...(isDone(all) ? [] : all),
      { id: String(r.task.id), subject: String(x.subject), active: String(x.activeForm ?? ''), status: 'pending' },
    ])
  else if (e.tool === 'TaskUpdate' && r.success !== false)
    await setTasks($, all =>
      x.status === 'deleted'
        ? all.filter(t => t.id !== String(x.taskId))
        : all.map(t =>
            t.id === String(x.taskId)
              ? { ...t, subject: x.subject ?? t.subject, active: x.activeForm ?? t.active, status: x.status ?? t.status }
              : t,
          ),
    )

  return ran
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({
      name: 'monitor',
      description: 'Open the session monitor: model, workers and agents',
    })
    $.ui.status(undefined)
    const collapsed = (await $.store.get('collapsed')) === true
    await update($, isCollapsed, () => collapsed)
    await setMood($, 'idle')
    const id = await $.session.model()
    await update($, model, () => id)
    // A call cut off by a reload never ran its finally: start clear.
    await update($, activeWorker, () => '')
    // So did a finished list's timer.
    if (isDone(await read($, tasks))) await clearTasks($)
    void refreshQuota($, true).catch(() => undefined)
    await refreshAgents($)
    // After a reload the last call's time is still in state: keep counting from it.
    const at = await read($, cacheAt)
    const now = await $.clock.now()
    if (at >= 0) await update($, cacheNow, () => now)
    if (at >= 0 && now - at < CACHE_MS) startCacheTick($)
    // A reload mid-turn keeps the turn's start in state; its timer has to restart.
    if ((await read($, turnAt)) >= 0) {
      await update($, turnNow, () => now)
      startTurnTick($)
    }

    return ran
  })

  on('command.run', { command: 'monitor' }, async $ => {
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Session monitor' })

    return { text: isPlaced ? 'Session monitor opened.' : 'Session monitor is ready; no surface placed it.' }
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      agentModels.set(e.agentId, e.model)
    } else {
      await touchCache($)
      await update($, model, () => e.model)
      await update($, effort, () => (e.effort === undefined ? '' : String(e.effort)))
    }

    return yield* next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if ('agentId' in ran && ran.agentId) {
      agentModels.set(ran.agentId, ran.model)
    }
    await refreshAgents($).catch(() => undefined)

    return ran
  })

  // A call put to the person's decider: the buddy looks up at the prompt until it runs or the turn ends.
  on('tool.check', async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId && (ran as any)?.decision === 'ask') await update($, isAsking, () => true)

    return ran
  })

  on('tool.call', async ($, e, next) => {
    if (await read($, isAsking)) await update($, isAsking, () => false)
    if ((e as any).agentId) return next(e)
    await startTurn($)
    await update($, turnSteps, n => n + 1)
    await update($, activity, () => describe(e))
    try {
      return await next(e)
    } finally {
      await update($, activity, () => '')
    }
  })

  on('prompt.submit', async ($, e, next) => {
    await startTurn($)
    await setMood($, 'idle')
    await update($, activeWorker, () => '')

    return next(e)
  })

  on('tool.call', { tool: 'TodoWrite' }, trackTasks)
  on('tool.call', { tool: 'TaskCreate' }, trackTasks)
  on('tool.call', { tool: 'TaskUpdate' }, trackTasks)

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // A wrapper call in the foreground: show the worker while it runs. A background call returns at once.
    const worker = (e as any).run_in_background ? undefined : e.command.match(/scripts\/(kimi|gemini|openrouter)\.sh/)?.[1]
    if (worker) await update($, activeWorker, () => worker)
    let ran
    try {
      ran = await next(e)
    } finally {
      if (worker) await update($, activeWorker, () => '')
    }
    if (LOG_RE.test(e.command)) {
      void refreshQuota($, true).catch(() => undefined)
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    await endTurn($)
    await update($, isAsking, () => false)
    // An interrupted call can skip its finally; nothing is running once the turn is over.
    await update($, activeWorker, () => '')
    if (e.reason === 'error') await setMood($, 'error', 5000)
    else if (e.reason === 'answer') await setMood($, 'happy', 3000)
    else await setMood($, 'idle')
    await refreshAgents($)
    void refreshQuota($).catch(() => undefined)

    return ran
  })

  // Stacks with other plugins' bands (next-steps draws beneath via next).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const ui = $.ui.resolve(e)
    const card = await Card($, e, ui, 'band')
    if (!below) return card

    return (
      <ui.Box flexDirection="column">
        {card}
        {below}
      </ui.Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => Card($, e, $.ui.resolve(e), 'pane'))
}
