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
