// Typed wrapper over the preload contextBridge (window.decoy).

export interface RecordingSummary {
  runId: string
  label: string
  startedAt: string
  requestCount: number
  webSocketCount?: number
  host?: string
}

export interface ActiveRecording {
  runId: string
  label: string
}

export interface RecordingProgress {
  requests: number
  websockets: number
}

export interface FilterConfig {
  skipResourceTypes: string[]
  blockHosts: string[]
}

export interface Profile {
  id: string
  label: string
  /** When true, this profile signs in via real external Chrome (Google escape hatch); see main. */
  chromeLogin?: boolean
}

export interface DecoyConfig {
  sessionsRoot: string
  urlHistory: string[]
  filters: FilterConfig
  profiles: Profile[]
  lastProfileId: string
  defaultChromeLogin: boolean
}

// CDP resourceType values worth offering as checkboxes in the filter modal.
export const KNOWN_RESOURCE_TYPES = [
  'Document',
  'Stylesheet',
  'Image',
  'Media',
  'Font',
  'Script',
  'XHR',
  'Fetch',
  'EventSource',
  'WebSocket',
  'Manifest',
  'Ping',
  'CSPViolationReport',
  'Preflight',
  'Other',
]

export interface StartPayload {
  label: string
  startUrl: string
  /** Profile selection: "fresh" | "default" | a custom profile id. */
  profileId: string
  captureAll: boolean
  autoRecord: boolean
  exportHar: boolean
}

export interface OpenLoginPayload {
  startUrl: string
  profileId: string
}

export interface DecoyBridge {
  startRecording(p: StartPayload): Promise<{ runId: string }>
  openLogin(p: OpenLoginPayload): Promise<{ success: boolean }>
  stopRecording(): Promise<{ success: boolean }>
  getActiveRecording(): Promise<ActiveRecording | null>
  listRecordings(): Promise<RecordingSummary[]>
  openRecording(runId: string): Promise<{ success: boolean }>
  deleteRecording(runId: string): Promise<{ success: boolean }>
  renameRecording(runId: string, name: string): Promise<{ runId: string; label: string }>
  copyRecordingPath(runId: string): Promise<{ path: string }>
  createProfile(label: string, chromeLogin: boolean): Promise<DecoyConfig>
  setProfileChromeLogin(id: string, value: boolean): Promise<DecoyConfig>
  deleteProfile(id: string): Promise<DecoyConfig>
  confirmDeleteProfile(label: string): Promise<{ confirmed: boolean }>
  getConfig(): Promise<DecoyConfig>
  setSessionsRoot(root: string): Promise<DecoyConfig>
  pickSessionsRoot(): Promise<{ canceled: boolean; path?: string }>
  clearUrlHistory(): Promise<DecoyConfig>
  setFilters(filters: FilterConfig): Promise<DecoyConfig>
  resetFilters(): Promise<DecoyConfig>
  onRecordingStarted(cb: (info: ActiveRecording) => void): () => void
  onRecordingProgress(cb: (counts: RecordingProgress) => void): () => void
  onRecordingFinished(cb: () => void): () => void
}

export const decoy: DecoyBridge = (window as unknown as { decoy: DecoyBridge }).decoy
