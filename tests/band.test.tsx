import { test, expect, mock } from 'claude-code/testing'

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 }

test('band draws, hides and shows on terminal and desktop', async ($, on) => {
  mock.clock(on)
  mock.store(on, {})
  // The engine draws nothing of its own in the band when no survey is up.
  on('ui.render', { component: 'AbovePrompt' }, (($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  }) as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'session-monitor', surface, component: 'AbovePrompt', props: PROPS } as any)
    expect(await band.find({ key: 'hide' })).toBeDefined()
    await band.press({ key: 'hide' })
    expect(await band.find({ key: 'show' })).toBeDefined()
    await band.press({ key: 'show' })
    expect(await band.find({ key: 'hide' })).toBeDefined()
    expect(JSON.stringify(await band.drawn())).not.toMatch(/\$\d|context|5h|7d|delegated|nothing yet|0 agents/)
    await band.unmount()
  }
})

test('pane draws', async ($, on) => {
  mock.clock(on)
  mock.store(on, {})
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'session-monitor', surface, component: 'Pane', requestId: 'session-monitor', props: {} } as any)
    expect(await pane.drawn()).toBeDefined()
    await pane.unmount()
  }
})

test('band stacks above another plugin\'s band', async ($, on) => {
  mock.clock(on)
  mock.store(on, {})
  on('ui.render', { component: 'AbovePrompt' }, (async ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box key="other">
        <Text>next: something</Text>
      </Box>
    )
  }) as any)
  const band = await $.ui.mount({ plugin: 'session-monitor', surface: 'desktop', component: 'AbovePrompt', props: PROPS } as any)
  expect(await band.find({ key: 'hide' })).toBeDefined()
  expect(await band.find({ key: 'other' })).toBeDefined()
  await band.unmount()
})

test('a worker low on quota shows its percentage, others stay hidden', async ($, on) => {
  mock.clock(on)
  mock.store(on, {})
  on('process.run', (async () => ({ value: { exitCode: 0, stdout: '{"kimi": 85, "openrouter": 10}', stderr: '' } })) as any)
  on('command.register', (async () => ({ value: undefined })) as any)
  on('session.model', (async () => ({ value: 'claude-opus-5-5' })) as any)
  on('session.usage', (async () => ({ value: { startedAt: 0 } })) as any)
  on('agent.list', (async () => ({ value: [] })) as any)
  on('env.get', (async () => ({ value: '/home' })) as any)
  on('fs.exists', (async () => ({ value: false })) as any)
  on('ui.render', { component: 'AbovePrompt' }, (($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  }) as any)
  on('session.start', (async (_$: any, e: any) => ({ cwd: e.cwd })) as any)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as never)
  await new Promise(r => setTimeout(r, 0))
  const band = await $.ui.mount({ plugin: 'session-monitor', surface: 'desktop', component: 'AbovePrompt', props: PROPS } as any)
  const drawn = JSON.stringify(await band.drawn())
  expect(drawn).toContain('Kimi')
  expect(drawn).toContain('85')
  expect(drawn).not.toContain('OpenRouter')
  await band.unmount()
})

test('several running agents show a count per model', async ($, on) => {
  mock.clock(on)
  mock.store(on, {})
  const models: Record<string, string> = { a: 'claude-haiku-5-5', b: 'claude-haiku-5-5', c: 'claude-sonnet-5-5' }
  const running = (id: string) => ({ id, description: id, type: 'Explore', status: 'running' })
  let n = 0
  on('agent.spawn', (async () => {
    const id = 'abc'[n++]!
    return { agentId: id, model: models[id] }
  }) as any)
  on('process.run', (async () => ({ value: { exitCode: 0, stdout: '{}', stderr: '' } })) as any)
  on('command.register', (async () => ({ value: undefined })) as any)
  on('session.model', (async () => ({ value: 'claude-opus-5-5' })) as any)
  on('session.usage', (async () => ({ value: { startedAt: 0 } })) as any)
  on('agent.list', (async () => ({ value: [running('a'), running('b'), running('c')] })) as any)
  on('env.get', (async () => ({ value: '/home' })) as any)
  on('fs.exists', (async () => ({ value: false })) as any)
  on('ui.render', { component: 'AbovePrompt' }, (($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  }) as any)
  on('session.start', (async (_$: any, e: any) => ({ cwd: e.cwd })) as any)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as never)
  for (let i = 0; i < 3; i++) await $.agent.spawn({ prompt: 'x', description: 'x' } as never)
  const band = await $.ui.mount({ plugin: 'session-monitor', surface: 'desktop', component: 'AbovePrompt', props: PROPS } as any)
  const drawn = JSON.stringify(await band.drawn())
  expect(drawn).toContain('3 running')
  expect(drawn).toContain('Haiku ×2')
  await band.unmount()
})

test('model mark is an animated buddy on desktop and a glyph on terminal', async ($, on) => {
  mock.clock(on)
  mock.store(on, {})
  on('ui.render', { component: 'AbovePrompt' }, (($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  }) as any)
  const desk = await $.ui.mount({ plugin: 'session-monitor', surface: 'desktop', component: 'AbovePrompt', props: PROPS } as any)
  expect(JSON.stringify(await desk.drawn())).toMatch(/buddy/)
  await desk.unmount()
  const term = await $.ui.mount({ plugin: 'session-monitor', surface: 'terminal', component: 'AbovePrompt', props: PROPS } as any)
  expect(JSON.stringify(await term.drawn())).not.toMatch(/<svg/)
  await term.unmount()
})

const moodOf = async ($: any, isWorking = false) => {
  const band = await $.ui.mount({ plugin: 'session-monitor', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, isWorking } } as any)
  const alt = JSON.stringify(await band.drawn()).match(/buddy, (\w+)/)?.[1]
  await band.unmount()
  return alt
}

test('buddy follows the session: working, waiting, finished, error', async ($, on) => {
  mock.clock(on)
  mock.store(on, {})
  on('ui.render', { component: 'AbovePrompt' }, (($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  }) as any)
  on('tool.check', (() => ({ decision: 'ask' })) as any)
  on('turn.complete', (() => ({ text: 'ok' })) as any)
  expect(await moodOf($, true)).toBe('working')
  await $.tool.check({ tool: 'Bash', input: {} } as any)
  expect(await moodOf($, true)).toBe('waiting')
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't' } as any)
  expect(await moodOf($)).toBe('happy')
  await $.turn.complete({ reason: 'error', answer: '', durationMs: 1, isAborted: false, turnId: 't2' } as any)
  expect(await moodOf($)).toBe('error')
})

test('a foreground Kimi call shows Kimi working until it returns', async (t$, on) => {
  mock.clock(on)
  mock.store(on, {})
  on('ui.render', { component: 'AbovePrompt' }, (($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  }) as any)
  let seen = ''
  on('tool.call', (async () => {
    const band = await (t$ as any).ui.mount({ plugin: 'session-monitor', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
    seen = JSON.stringify(await band.drawn())
    await band.unmount()
    return { result: 'ok' }
  }) as any)
  await t$.tool.call({ tool: 'Bash', command: 'cat x | ~/.claude/skills/kimi/scripts/kimi.sh "Review"' } as any)
  expect(seen).toContain('Kimi')
  expect(seen).toContain('working')
  const band = await t$.ui.mount({ plugin: 'session-monitor', surface: 'desktop', component: 'AbovePrompt', props: PROPS } as any)
  expect(JSON.stringify(await band.drawn())).not.toContain('working…')
  await band.unmount()
})
