export type AgentRow = {
  id: string
  description: string
  type: string
  status: string
  model?: string
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  contextPercent?: number
  contextWindow: number
  limits: Limit[]
  costUsd?: number
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
      usage: Usage | null
      isBandOpen: boolean
      workers: Worker[]
      spawns: Record<string, number>
    }
  }
}
