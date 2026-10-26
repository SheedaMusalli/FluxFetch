export interface NetMergeAdapter {
  Name: string
  IP: string
  State: string
  Present: boolean
  Active: number
  BytesIn: number
  BytesOut: number
  RateIn: number
  RateOut: number
  RTTMs: number
  LimitMbps: number
  PublicIP: string
  QuotaBytes: number
  QuotaUsed: number
  QuotaDaily: boolean
  QuotaBlocked: boolean
  QuotaError: string
}

export interface NetMergeQuotaRequest {
  adapter: string
  gb: number
  daily: boolean
  reset: boolean
}

export interface NetMergeStatus {
  phase: 'stopped' | 'starting' | 'running' | 'unresponsive'
  installed: boolean
  running: boolean
  adapters: NetMergeAdapter[]
}
