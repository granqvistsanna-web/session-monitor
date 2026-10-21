export type AgentRow = {
  id: string
  description: string
  type: string
  status: string
  model?: string
}

export type TaskRow = {
  id: string
  subject: string
  /** The "…ing" form shown while the step is under way. */
  active: string
  status: 'pending' | 'in_progress' | 'completed'
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
      tasks: TaskRow[]
      isTasksOpen: boolean
    }
  }
}
