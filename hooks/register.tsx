import { atom, read, update } from 'claude-code'
import type { Hook, Register, SessionRateLimit, SessionUsage } from 'claude-code'

import type { AgentRow, Usage, Worker } from '../types'

type Api = Parameters<Hook<'turn.complete'>>[0]

const PANE = 'session-monitor'
const POLL_MS = 3000
const LIVE = new Set(['pending', 'running', 'waiting'])

const model = atom({ plugin: 'session-monitor', key: 'model' } as const, '')
const effort = atom({ plugin: 'session-monitor', key: 'effort' } as const, '')
const agents = atom({ plugin: 'session-monitor', key: 'agents' } as const, [])
const usage = atom({ plugin: 'session-monitor', key: 'usage' } as const, null)
const isBandOpen = atom({ plugin: 'session-monitor', key: 'isBandOpen' } as const, false)
const workers = atom({ plugin: 'session-monitor', key: 'workers' } as const, [])
const spawns = atom({ plugin: 'session-monitor', key: 'spawns' } as const, {})

const toUsage = (u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>): Usage => ({
  contextPercent: u.context.percent,
  contextWindow: u.context.window,
  limits: u.rateLimits.map((l: SessionRateLimit) => ({
    kind: l.kind,
    percentUsed: l.percentUsed,
    resetsAt: l.resetsAt,
  })),
  costUsd: u.cost?.usd,
})

const shortModel = (id: string) =>
  id
    .replace(/^claude-/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/\[.*\]$/, '')

const limitLabel = (kind: string) =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind.replace(/_/g, ' ')

const resetIn = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const mins = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h ${mins % 60}m`
  return `${Math.round(hours / 24)}d`
}

const BAR_W = 96
const BAR_H = 6

const tone = (pct: number) => (pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'success')
const HEX: Record<string, string> = { error: '#E5484D', warning: '#E2A336', success: '#30A46C' }

const bar = (pct: number) => {
  const w = Math.max(0, Math.min(100, pct)) / 100 * BAR_W
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_W}" height="${BAR_H}" viewBox="0 0 ${BAR_W} ${BAR_H}"><rect width="${BAR_W}" height="${BAR_H}" rx="3" fill="#8888" fill-opacity="0.25"/><rect width="${w.toFixed(1)}" height="${BAR_H}" rx="3" fill="${HEX[tone(pct)]}"/></svg>`
}

const textBar = (pct: number) => {
  const n = Math.round(Math.max(0, Math.min(100, pct)) / 10)
  return '▰'.repeat(n) + '▱'.repeat(10 - n)
}

const dot = (status: string): { glyph: string; color: string } =>
  status === 'running' || status === 'pending'
    ? { glyph: '●', color: 'success' }
    : status === 'waiting' || status === 'idle'
      ? { glyph: '●', color: 'warning' }
      : status === 'failed' || status === 'killed'
        ? { glyph: '✕', color: 'error' }
        : { glyph: '✓', color: 'subtle' }

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

async function pushStatus($: Api) {
  const m = await read($, model)
  const list = await read($, agents)
  const u = await read($, usage)
  const live = list.filter(a => LIVE.has(a.status)).length
  const parts = [m ? shortModel(m) : 'model ?']
  const eff = await read($, effort)
  if (eff) parts[0] += ` (${eff})`
  parts.push(live ? `${live}/${list.length} agents running` : `${list.length} agents`)
  for (const l of u?.limits ?? []) parts.push(`${limitLabel(l.kind)} ${Math.round(l.percentUsed)}%`)
  if (u?.contextPercent !== undefined) parts.push(`ctx ${u.contextPercent}%`)
  $.ui.status(parts.join(' · '))
}

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
  await pushStatus($)
  if (!timer && list.some(a => LIVE.has(a.status))) {
    timer = $.clock.after(POLL_MS, () => {
      timer = undefined
      void refreshAgents($)
    })
  }
}

async function delegationRow($: Api, Box: any, Text: any) {
  const ws = await read($, workers)
  const sp = await read($, spawns)
  const tally: [string, number][] = [
    ...Object.entries(sp).map(([k, n]): [string, number] => [label(k), n]),
    ...ws.filter(w => w.session > 0).map((w): [string, number] => [label(w.provider), w.session]),
  ]

  return (
    <Box key="delegation" flexDirection="row" flexWrap="wrap" columnGap={2}>
      <Text size="caption">
        <Text dimColor>Delegated </Text>
        {tally.length ? tally.map(([name, n], i) => `${i ? ' · ' : ''}${name} ${n}`).join('') : <Text dimColor>nothing yet</Text>}
      </Text>
      {ws.map(w => (
        <Text key={w.provider} size="caption" tabular dimColor={!w.today && w.left === undefined}>
          <Text dimColor>{label(w.provider)} </Text>
          {w.left !== undefined ? (
            <Text color={w.left <= 10 ? 'warning' : undefined}>{w.left} left</Text>
          ) : (
            `${w.today} today`
          )}
          {w.useful !== undefined && (
            <Text color={w.useful < 60 ? 'warning' : undefined} dimColor={w.useful >= 60}>
              {' '}
              · {w.useful}%
            </Text>
          )}
        </Text>
      ))}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({
      name: 'monitor',
      description: 'Open the session monitor: model, agents and usage',
    })
    const id = await $.session.model()
    await update($, model, () => id)
    const u = await $.session.usage()
    sessionStartedAt = u.startedAt
    await update($, usage, () => toUsage(u))
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
      await pushStatus($)
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

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => toUsage(e))
    await pushStatus($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await read($, model)
    const eff = await read($, effort)
    const list = await read($, agents)
    const u = await read($, usage)
    const isOpen = await read($, isBandOpen)
    const live = list.filter(a => LIVE.has(a.status))
    const narrow = e.props.bodyColumns < 70

    const stat = (label: string, pct: number | undefined) =>
      pct === undefined ? null : (
        <Text key={label} size="caption" tabular>
          <Text dimColor>{label} </Text>
          <Text color={tone(pct)}>{Math.round(pct)}%</Text>
        </Text>
      )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" alignItems="center" gap={2}>
          <Text size="caption" weight="semibold">
            {m ? shortModel(m) : 'model ?'}
            {eff && !narrow ? <Text dimColor weight="regular"> · {eff}</Text> : ''}
          </Text>
          {u?.limits.map(l => stat(limitLabel(l.kind), l.percentUsed))}
          {u && stat('ctx', u.contextPercent)}
          {u?.costUsd !== undefined && !narrow && (
            <Text size="caption" tabular dimColor>
              ${u.costUsd.toFixed(2)}
            </Text>
          )}
          <Button
            key="agents"
            plain
            onPress={() => update($, isBandOpen, open => !open)}
          >
            <Text size="caption" color={live.length ? 'success' : undefined} dimColor={!live.length}>
              {live.length ? '●' : '○'} {live.length ? `${live.length} running` : `${list.length} agents`}{' '}
              {list.length ? (isOpen ? '▾' : '▸') : ''}
            </Text>
          </Button>
        </Box>
        {await delegationRow($, Box, Text)}
        {isOpen &&
          [...live, ...list.filter(a => !LIVE.has(a.status)).slice(-3).reverse()].map(a => {
            const s = dot(a.status)
            return (
              <Box key={a.id} flexDirection="row" gap={1}>
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
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Svg } = $.ui.resolve(e) as ReturnType<typeof $.ui.resolve> & { Svg?: any }
    const m = await read($, model)
    const eff = await read($, effort)
    const list = await read($, agents)
    const u = await read($, usage)
    const now = await $.clock.now()
    const live = list.filter(a => LIVE.has(a.status))
    const done = list.filter(a => !LIVE.has(a.status))
    const recent = done.slice(-3).reverse()

    const meter = (label: string, pct: number | undefined, note: string) => {
      const value = pct ?? 0
      return (
        <Box key={label} flexDirection="row" alignItems="center" gap={1}>
          <Text size="caption" dimColor mono>
            {label.padEnd(3)}
          </Text>
          {Svg ? (
            <Svg source={bar(value)} alt={`${label} ${Math.round(value)}%`} width={BAR_W} height={BAR_H} />
          ) : (
            <Text color={tone(value)}>{textBar(value)}</Text>
          )}
          <Text size="caption" tabular color={tone(value)}>
            {pct === undefined ? '–' : `${Math.round(value)}%`}
          </Text>
          <Text size="caption" dimColor>
            {note}
          </Text>
        </Box>
      )
    }

    const limits = u?.limits ?? []

    return (
      <Box flexDirection="column" gap="sm">
        <Box flexDirection="row" justifyContent="space-between">
          <Text weight="semibold">
            {m ? shortModel(m) : 'Waiting for first reply'}
            {eff ? <Text dimColor weight="regular"> · {eff}</Text> : ''}
          </Text>
          {u?.costUsd !== undefined && (
            <Text size="caption" tabular dimColor>
              ${u.costUsd.toFixed(2)}
            </Text>
          )}
        </Box>

        <Box flexDirection="column">
          {limits.map(l => meter(limitLabel(l.kind), l.percentUsed, resetIn(l.resetsAt, now)))}
          {u && meter('ctx', u.contextPercent, `of ${Math.round(u.contextWindow / 1000)}k`)}
          {!u && (
            <Text size="caption" dimColor>
              Usage shows after the first reply
            </Text>
          )}
        </Box>

        {await delegationRow($, Box, Text)}

        <Box flexDirection="column">
          <Text size="caption" dimColor>
            {live.length ? `${live.length} running` : 'No agents running'}
            {list.length ? ` · ${list.length} this session` : ''}
          </Text>
          {[...live, ...recent].map(a => {
            const s = dot(a.status)
            return (
              <Box key={a.id} flexDirection="row" gap={1}>
                <Text color={s.color}>{s.glyph}</Text>
                <Text size="footnote" dimColor={!LIVE.has(a.status)} wrap="truncate-end">
                  {a.description}
                </Text>
                <Text size="caption" dimColor wrap="truncate-end">
                  {a.type}
                  {a.model ? ` · ${shortModel(a.model)}` : ''}
                </Text>
              </Box>
            )
          })}
          {done.length > recent.length && (
            <Text size="caption" dimColor>
              +{done.length - recent.length} earlier
            </Text>
          )}
        </Box>
      </Box>
    )
  })
}
