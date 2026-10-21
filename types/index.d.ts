export type AgentRow = {
  id: string
  description: string
  type: string
  status: string
  model?: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-monitor': {
      model: string
      effort: string
      agents: AgentRow[]
      isBandOpen: boolean
      isCollapsed: boolean
      quota: Record<string, number>
      mood: string
      isAsking: boolean
      activeWorker: string
      cacheAt: number
      cacheNow: number
    }
  }
}
