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
const isCollapsed = atom({ plugin: 'session-monitor', key: 'isCollapsed' } as const, false)

const shortModel = (id: string) =>
  id
    .replace(/^claude-/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/\[.*\]$/, '')

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

// Learned from agent.spawn results and each subagent's turn.step.
const agentModels = new Map<string, string>()
let timer: { cancel: () => void } | undefined

async function refreshAgents($: Api) {
  const list = await $.agent.list()
  await update($, agents, prev =>
    list.map(
      (a): AgentRow => ({
        id: a.id,
        description: a.description,
        type: a.type,
        status: a.status,
        model: agentModels.get(a.id) ?? prev.find(p => p.id === a.id)?.model,
      }),
    ),
  )
  if (!timer && list.some(a => LIVE.has(a.status))) {
    timer = $.clock.after(POLL_MS, () => {
      timer = undefined
      void refreshAgents($)
    })
  }
}

async function toggleCollapsed($: Api) {
  const next = !(await read($, isCollapsed))
  await update($, isCollapsed, () => next)
  await $.store.set('collapsed', next)
}

const Chip = (Text: any, key: string, color: string, name: string, n: number) => (
  <Text key={key}>
    {'  '}
    <Text color={color}>●</Text> {name} <Text weight="semibold">{n}</Text>
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
  const isOpen = mode === 'pane' || (await read($, isBandOpen))
  const live = list.filter(a => LIVE.has(a.status))
  const done = list.filter(a => !LIVE.has(a.status))
  const shown = [...live, ...done.slice(-3).reverse()]
  const name = m ? shortModel(m) : 'model ?'

  if (mode === 'band' && (await read($, isCollapsed))) {
    return (
      <Button key="show" plain onPress={() => toggleCollapsed($)}>
        <Text size="caption" dimColor>
          <Text color={ACCENT}>◆</Text> {name} ▸
        </Text>
      </Button>
    )
  }

  const delegated = [
    ...Object.entries(sp).map(([k, n]) => Chip(Text, `s-${k}`, WORKER_COLORS[k] ?? MUTED, label(k), n)),
    ...ws.filter(w => w.session > 0).map(w => Chip(Text, `s-${w.provider}`, WORKER_COLORS[w.provider] ?? MUTED, label(w.provider), w.session)),
  ]
  const liveModels = [...new Set(live.map(a => (a.model ? shortModel(a.model) : '')).filter(Boolean))]

  return (
    <Box flexDirection="column" paddingX="sm">
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Text size="caption" tabular wrap="truncate-end">
          <Text color={ACCENT}>◆</Text> <Text weight="semibold">{name}</Text>
          {eff ? <Text dimColor> · {eff}</Text> : ''}
          {delegated.length ? <Text dimColor>{'   delegated'}</Text> : ''}
          {delegated}
        </Text>
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
    const id = await $.session.model()
    await update($, model, () => id)
    sessionStartedAt = (await $.session.usage()).startedAt
    await refreshWorkers($).catch(() => undefined)
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

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (LOG_RE.test(e.command)) await refreshWorkers($).catch(() => undefined)

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    await refreshAgents($)
    await refreshWorkers($).catch(() => undefined)

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
