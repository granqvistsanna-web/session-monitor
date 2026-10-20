export type AgentRow = {
  id: string
  description: string
  type: string
  status: string
  model?: string
}

export type Worker = {
  provider: string
  today: number
  session: number
  useful?: number
  left?: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-monitor': {
      model: string
      effort: string
      agents: AgentRow[]
      isBandOpen: boolean
      workers: Worker[]
      spawns: Record<string, number>
      isCollapsed: boolean
      quota: Record<string, number>
    }
  }
}
