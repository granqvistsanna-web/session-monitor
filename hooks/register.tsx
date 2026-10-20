import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { AgentRow, Worker } from '../types'

type Api = Parameters<Hook<'turn.complete'>>[0]

const PANE = 'session-monitor'
const POLL_MS = 3000
const LIVE = new Set(['pending', 'running', 'waiting'])

const model = atom({ plugin: 'session-monitor', key: 'model' } as const, '')
const effort = atom({ plugin: 'session-monitor', key: 'effort' } as const, '')
const agents = atom({ plugin: 'session-monitor', key: 'agents' } as const, [])
const isBandOpen = atom({ plugin: 'session-monitor', key: 'isBandOpen' } as const, false)
const workers = atom({ plugin: 'session-monitor', key: 'workers' } as const, [])
const spawns = atom({ plugin: 'session-monitor', key: 'spawns' } as const, {})
const quota = atom({ plugin: 'session-monitor', key: 'quota' } as const, {})
const isCollapsed = atom({ plugin: 'session-monitor', key: 'isCollapsed' } as const, false)
// The buddy's mood between turns, and whether a tool call is waiting on the person.
const mood = atom({ plugin: 'session-monitor', key: 'mood' } as const, 'idle')
const isAsking = atom({ plugin: 'session-monitor', key: 'isAsking' } as const, false)
// The off-Claude worker a foreground Bash call is waiting on right now (kimi, gemini, openrouter).
const activeWorker = atom({ plugin: 'session-monitor', key: 'activeWorker' } as const, '')

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

// --- Off-Claude workers, read from the usage skill's log -------------------

const PROVIDERS = ['kimi', 'gemini', 'openrouter'] as const
const OPENROUTER_DAILY = 50
const DAY_MS = 86_400_000
const LOG_RE = /(kimi|gemini|openrouter)\.sh|usage\/scripts\/log\.py/

let sessionStartedAt = 0

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

// Start of "today" for each provider's quota: Gemini resets at midnight Pacific,
// OpenRouter at 00:00 UTC, Kimi has rolling windows so local midnight is used.
function dayStart(provider: string, now: number) {
  if (provider === 'openrouter') return Math.floor(now / DAY_MS) * DAY_MS
  const offsetMin = provider === 'gemini' ? -pacificOffset(now) : new Date(now).getTimezoneOffset()
  const shifted = now - offsetMin * 60_000
  return Math.floor(shifted / DAY_MS) * DAY_MS + offsetMin * 60_000
}

function pacificOffset(now: number) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset' })
      .formatToParts(new Date(now))
      .find(p => p.type === 'timeZoneName')?.value
    const hours = Number(parts?.replace('GMT', '') || -8)
    return hours * 60
  } catch {
    return -8 * 60
  }
}

async function refreshWorkers($: Api) {
  const home = await $.env.get('HOME')
  const path = (await $.env.get('DELEGATE_USAGE_LOG'))?.replace(/^~/, home ?? '~') ?? `${home}/.claude/usage/delegate-log.jsonl`
  if (!(await $.fs.exists(path))) return
  const text = await $.fs.read(path)
  const now = await $.clock.now()
  const calls: { id: string; provider: string; t: number }[] = []
  const verdicts = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const t = Date.parse(String(row.ts ?? ''))
    if (row.type === 'verdict') verdicts.set(String(row.id), String(row.verdict))
    else if (row.type !== 'verdict' && typeof row.provider === 'string') calls.push({ id: String(row.id), provider: row.provider, t })
  }
  const list: Worker[] = PROVIDERS.map(provider => {
    const mine = calls.filter(c => c.provider === provider)
    const since = dayStart(provider, now)
    const today = mine.filter(c => c.t >= since).length
    const recent = mine.filter(c => c.t >= now - 30 * DAY_MS && verdicts.has(c.id))
    const kept = recent.filter(c => verdicts.get(c.id) !== 'discarded').length
    return {
      provider,
      today,
      session: sessionStartedAt ? mine.filter(c => c.t >= sessionStartedAt).length : 0,
      useful: recent.length >= 3 ? Math.round((kept / recent.length) * 100) : undefined,
      left: provider === 'openrouter' ? Math.max(0, OPENROUTER_DAILY - today) : undefined,
    }
  })
  await update($, workers, () => list)
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

let moodTimer: { cancel: () => void } | undefined

// A passing mood (happy, error) shows for `ms`, then settles to idle; idle dozes off after a while.
async function setMood($: Api, next: string, ms?: number) {
  moodTimer?.cancel()
  moodTimer = undefined
  await update($, mood, () => next)
  if (ms) moodTimer = $.clock.after(ms, () => void setMood($, 'idle'))
  else if (next === 'idle') moodTimer = $.clock.after(SLEEP_MS, () => void setMood($, 'sleep'))
}

async function toggleCollapsed($: Api) {
  const next = !(await read($, isCollapsed))
  await update($, isCollapsed, () => next)
  await $.store.set('collapsed', next)
}

const Chip = (Text: any, key: string, color: string, name: string, n: number, used?: number) => (
  <Text key={key}>
    {'  '}
    <Text color={color}>●</Text> {name}
    {n ? <Text weight="semibold"> {n}</Text> : ''}
    {used !== undefined ? <Text color={quotaTone(used)}> {Math.round(used)}%</Text> : ''}
  </Text>
)

// One line: the model at work, what has been delegated, and live agents.
async function Card($: Api, e: { surface: string }, ui: any, mode: 'band' | 'pane') {
  const { Box, Text, Button } = ui
  const m = await read($, model)
  const eff = await read($, effort)
  const list = await read($, agents)
  const ws = await read($, workers)
  const sp = await read($, spawns)
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

  if (mode === 'band' && (await read($, isCollapsed))) {
    return (
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        {ModelMark(ui, m, state)}
        <Button key="show" plain onPress={() => toggleCollapsed($)}>
          <Text size="caption" dimColor>
            {name} ▸
          </Text>
        </Button>
      </Box>
    )
  }

  const delegated = [
    ...Object.entries(sp).map(([k, n]) => Chip(Text, `s-${k}`, WORKER_COLORS[k] ?? MUTED, label(k), n)),
    ...ws.filter(w => w.session > 0).map(w => Chip(Text, `s-${w.provider}`, WORKER_COLORS[w.provider] ?? MUTED, label(w.provider), w.session, low(w.provider))),
  ]
  // A worker running low shows even before this session has used it.
  const lowOnly = Object.keys(q)
    .filter(k => low(k) !== undefined && !ws.some(w => w.provider === k && w.session > 0))
    .map(k => Chip(Text, `q-${k}`, WORKER_COLORS[k] ?? MUTED, label(k), 0, low(k)))
  const perModel = new Map<string, number>()
  for (const a of live) if (a.model) perModel.set(label(family(a.model)), (perModel.get(label(family(a.model))) ?? 0) + 1)
  const liveModels = [...perModel].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))

  return (
    <Box flexDirection="column" paddingX="sm">
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={1}>
        {ModelMark(ui, m, state)}
        <Text size="caption" tabular wrap="truncate-end">
          <Text weight="semibold">{name}</Text>
          {eff ? <Text dimColor> · {eff}</Text> : ''}
          {worker ? (
            <Text>
              <Text dimColor>{'  → '}</Text>
              <Text color={WORKER_COLORS[worker] ?? MUTED}>●</Text> <Text weight="semibold">{label(worker)}</Text>
              <Text dimColor> working…</Text>
            </Text>
          ) : (
            ''
          )}
          {delegated.length ? <Text dimColor>{'   delegated'}</Text> : ''}
          {delegated}
          {lowOnly.length ? <Text dimColor>{'   low'}</Text> : ''}
          {lowOnly}
        </Text>
        </Box>
        <Box flexDirection="row" columnGap={2} flexShrink={0}>
          {mode === 'band' && list.length === 0 ? (
            ''
          ) : mode === 'band' ? (
            <Button key="agents" plain onPress={() => update($, isBandOpen, open => !open)}>
              <Text size="caption" dimColor={!live.length}>
                <Text color={live.length ? '#93C47D' : undefined}>{live.length ? '●' : '○'}</Text>{' '}
                {live.length ? `${live.length} running${liveModels.length ? ` · ${liveModels.join(', ')}` : ''}` : `${list.length} agents`}
                {isOpen ? ' ▾' : ' ▸'}
              </Text>
            </Button>
          ) : (
            <Text size="caption" dimColor>
              {live.length ? `${live.length} running` : 'no agents running'}
            </Text>
          )}
          {mode === 'band' && (
            <Button key="hide" plain onPress={() => toggleCollapsed($)}>
              <Text size="caption" dimColor>
                hide
              </Text>
            </Button>
          )}
        </Box>
      </Box>

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({
      name: 'monitor',
      description: 'Open the session monitor: model, agents and delegation',
    })
    $.ui.status(undefined)
    const collapsed = (await $.store.get('collapsed')) === true
    await update($, isCollapsed, () => collapsed)
    await setMood($, 'idle')
    const id = await $.session.model()
    await update($, model, () => id)
    sessionStartedAt = (await $.session.usage()).startedAt
    await refreshWorkers($).catch(() => undefined)
    void refreshQuota($, true).catch(() => undefined)
    await refreshAgents($)

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
      await update($, model, () => e.model)
      await update($, effort, () => (e.effort === undefined ? '' : String(e.effort)))
    }

    return yield* next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if ('agentId' in ran && ran.agentId) {
      agentModels.set(ran.agentId, ran.model)
      const f = family(ran.model)
      await update($, spawns, all => ({ ...all, [f]: (all[f] ?? 0) + 1 }))
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

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await setMood($, 'idle')

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // A wrapper call in the foreground: show the worker while it runs. A background call returns
    // at once, so it shows only in the delegated tally once its log row lands.
    const worker = (e as any).run_in_background ? undefined : e.command.match(/(kimi|gemini|openrouter)\.sh/)?.[1]
    if (worker) await update($, activeWorker, () => worker)
    let ran
    try {
      ran = await next(e)
    } finally {
      if (worker) await update($, activeWorker, () => '')
    }
    if (LOG_RE.test(e.command)) {
      await refreshWorkers($).catch(() => undefined)
      void refreshQuota($, true).catch(() => undefined)
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    await update($, isAsking, () => false)
    if (e.reason === 'error') await setMood($, 'error', 5000)
    else if (e.reason === 'answer') await setMood($, 'happy', 3000)
    else await setMood($, 'idle')
    await refreshAgents($)
    await refreshWorkers($).catch(() => undefined)
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
