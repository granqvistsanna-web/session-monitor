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

const twoWorkerCalls = async ($: any, on: any) => {
  mock.clock(on)
  mock.store(on, {})
  on('ui.render', { component: 'AbovePrompt' }, (($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  }) as any)
  on('tool.call', (async () => ({ result: 'ok' })) as any)
  await $.tool.call({
    tool: 'Bash',
    command: '( ~/.claude/skills/kimi/scripts/kimi.sh "a" ) & ( ~/.claude/skills/gemini/scripts/gemini.sh "a" ) & wait',
    run_in_background: true,
  } as any)
  await $.tool.call({ tool: 'Bash', command: '~/.claude/skills/openrouter/scripts/openrouter.sh "b"', run_in_background: true } as any)
}

const drawnAt = async ($: any, bodyColumns: number) => {
  const band = await $.ui.mount({ plugin: 'session-monitor', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns } } as any)
  const drawn = JSON.stringify(await band.drawn())
  expect(await band.find({ key: 'hide' })).toBeDefined()
  await band.unmount()
  return drawn
}

test('a finished worker call leaves no trace in the band', async ($, on) => {
  await twoWorkerCalls($, on)
  const drawn = await drawnAt($, 120)
  expect(drawn).not.toContain('delegated')
  for (const name of ['Kimi', 'Gemini', 'OpenRouter']) expect(drawn).not.toContain(name)
})

test('a worker call cut off mid-turn stops showing once the turn ends', async (t$, on) => {
  mock.clock(on)
  mock.store(on, {})
  on('ui.render', { component: 'AbovePrompt' }, (($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  }) as any)
  on('turn.complete', (() => ({ text: 'ok' })) as any)
  // The turn ends while the call is still out, as when it is interrupted before the hook unwinds.
  let before = ''
  let after = ''
  on('tool.call', (async () => {
    before = await drawnAt(t$, 120)
    await (t$ as any).turn.complete({ reason: 'interrupted', answer: '', durationMs: 1, isAborted: true, turnId: 't' })
    after = await drawnAt(t$, 120)
    return { result: 'ok' }
  }) as any)
  await t$.tool.call({ tool: 'Bash', command: '~/.claude/skills/kimi/scripts/kimi.sh "a"' } as any)
  expect(before).toContain('working…')
  expect(after).not.toContain('Kimi')
})

test('the cache pie counts down from the last model call, and asks for a handover', async ($, on) => {
  mock.clock(on)
  mock.store(on, {})
  on('ui.render', { component: 'AbovePrompt' }, (($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  }) as any)
  on('turn.step', (async function* () {
    return { answer: '', toolUses: [] }
  }) as any)
  let submitted = ''
  on('prompt.submit', ((_$: any, e: any) => {
    submitted = e.text
    return { text: e.text }
  }) as any)
  const before = await $.ui.mount({ plugin: 'session-monitor', surface: 'desktop', component: 'AbovePrompt', props: PROPS } as any)
  expect(await before.find({ key: 'cache' })).toBeUndefined()
  await before.unmount()
  const steps = ($ as any).turn.step({ model: 'claude-opus-5-5', effort: 'high' })
  for await (const _ of steps) void _
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'session-monitor', surface, component: 'AbovePrompt', props: PROPS } as any)
    expect(await band.find({ key: 'cache' })).toBeDefined()
    expect(JSON.stringify(await band.drawn())).toMatch(/60m/)
    await band.press({ key: 'cache' })
    expect(submitted).toContain('handover')
    await band.unmount()
  }
})

const STEPS = ['Read the code', 'Drop the tally', 'Clear the worker', 'Write tests', 'Ship it']

// Answers TaskCreate and TaskUpdate the way the engine does.
const taskTools = (on: any) => {
  let n = 0
  on('tool.call', { tool: 'TaskCreate' }, (() => ({ result: { task: { id: String(++n), subject: 's' } } })) as any)
  on('tool.call', { tool: 'TaskUpdate' }, ((_$: any, e: any) => ({ result: { success: true, taskId: e.taskId, updatedFields: ['status'] } })) as any)
}

const bandAt = async ($: any, surface: 'terminal' | 'desktop', bodyColumns = 120) =>
  $.ui.mount({ plugin: 'session-monitor', surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns } } as any)

test('a task list shows a progress bar, the step under way, and the steps on click', async ($, on) => {
  mock.clock(on)
  mock.store(on, {})
  on('ui.render', { component: 'AbovePrompt' }, (($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  }) as any)
  taskTools(on)
  for (const [i, subject] of STEPS.entries())
    await $.tool.call({ tool: 'TaskCreate', subject, description: subject, activeForm: i === 3 ? 'Writing tests' : undefined } as any)
  for (const id of ['1', '2', '3']) await $.tool.call({ tool: 'TaskUpdate', taskId: id, status: 'completed' } as any)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '4', status: 'in_progress' } as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await bandAt($, surface)
    const drawn = JSON.stringify(await band.drawn())
    expect(drawn).toContain('▰▰▰▰▱▱▱▱')
    expect(drawn).toContain('3/5 · 60%')
    expect(drawn).toContain('Writing tests')
    expect(drawn).not.toContain('Drop the tally')
    await band.press({ key: 'tasks' })
    const open = JSON.stringify(await band.drawn())
    for (const step of ['Clear the worker', 'Writing tests…', 'Ship it']) expect(open).toContain(step)
    await band.press({ key: 'tasks' })
    await band.unmount()
  }
  const narrow = JSON.stringify(await (await bandAt($, 'desktop', 30)).drawn())
  expect(narrow).toContain('60%')
  expect(narrow).not.toContain('3/5')
})

test('a short list stays quiet, and a finished one says Done and then goes', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, {})
  on('ui.render', { component: 'AbovePrompt' }, (($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  }) as any)
  on('tool.call', { tool: 'TodoWrite' }, (() => ({ result: { oldTodos: [], newTodos: [] } })) as any)
  const todos = (done: number, total: number) =>
    Array.from({ length: total }, (_, i) => ({ content: `Step ${i + 1}`, activeForm: `Doing ${i + 1}`, status: i < done ? 'completed' : 'pending' }))
  await $.tool.call({ tool: 'TodoWrite', todos: todos(0, 2) } as any)
  let band = await bandAt($, 'desktop')
  expect(await band.find({ key: 'tasks' })).toBeUndefined()
  await band.unmount()
  await $.tool.call({ tool: 'TodoWrite', todos: todos(4, 4) } as any)
  band = await bandAt($, 'desktop')
  expect(JSON.stringify(await band.drawn())).toContain('4/4 ✓ Done')
  await band.unmount()
  await clock.advance(5000)
  band = await bandAt($, 'desktop')
  expect(await band.find({ key: 'tasks' })).toBeUndefined()
  await band.unmount()
})

test('a subagent task list leaves the band alone', async ($, on) => {
  mock.clock(on)
  mock.store(on, {})
  on('ui.render', { component: 'AbovePrompt' }, (($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  }) as any)
  on('tool.call', { tool: 'TodoWrite' }, (() => ({ result: { oldTodos: [], newTodos: [] } })) as any)
  const todos = STEPS.map(content => ({ content, activeForm: content, status: 'pending' }))
  await $.tool.call({ tool: 'TodoWrite', todos, agentId: 'a1' } as any)
  const band = await bandAt($, 'desktop')
  expect(await band.find({ key: 'tasks' })).toBeUndefined()
  await band.unmount()
})
