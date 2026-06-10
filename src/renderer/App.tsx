import { useCallback, useEffect, useState } from 'react'

import {
  type ActiveRecording,
  decoy,
  type DecoyConfig,
  type FilterConfig,
  type Profile,
  type RecordingProgress,
  type RecordingSummary,
} from './bridge'
import { FiltersModal } from './FiltersModal'
import { ProfilesModal } from './ProfilesModal'

function formatWhen(iso: string): string {
  const d = new Date(iso)

  if (Number.isNaN(d.getTime())) {
    return iso
  }

  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// The one-line summary under a recording: host (when it adds info), time,
// request count, and websocket count when any were captured.
function recMeta(r: RecordingSummary): string {
  const parts = [
    r.host && r.host !== r.label ? r.host : null,
    formatWhen(r.startedAt),
    `${r.requestCount} reqs`,
    r.webSocketCount ? `${r.webSocketCount} ws` : null,
  ]

  return parts.filter(Boolean).join(' · ')
}

export function App() {
  const [sessionsRoot, setSessionsRoot] = useState('')
  const [urlHistory, setUrlHistory] = useState<string[]>([])
  const [recordings, setRecordings] = useState<RecordingSummary[]>([])
  const [label, setLabel] = useState('')
  const [startUrl, setStartUrl] = useState('https://')
  const [profileId, setProfileId] = useState('default')
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [defaultChromeLogin, setDefaultChromeLogin] = useState(false)
  const [profilesOpen, setProfilesOpen] = useState(false)
  const [copiedRunId, setCopiedRunId] = useState<string | null>(null)
  const [captureAll, setCaptureAll] = useState(false)
  const [autoRecord, setAutoRecord] = useState(true)
  const [exportHar, setExportHar] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [active, setActive] = useState<ActiveRecording | null>(null)
  const [progress, setProgress] = useState<RecordingProgress>({ requests: 0, websockets: 0 })

  const [editingRunId, setEditingRunId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  const [filters, setFilters] = useState<FilterConfig | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)

  const loadConfig = useCallback(async () => {
    const c = await decoy.getConfig()

    setSessionsRoot(c.sessionsRoot)
    setUrlHistory(c.urlHistory ?? [])
    setFilters(c.filters)
    setProfiles(c.profiles ?? [])
    setProfileId(c.lastProfileId ?? 'default')
    setDefaultChromeLogin(c.defaultChromeLogin ?? false)
  }, [])

  const refresh = useCallback(async () => {
    try {
      setRecordings(await decoy.listRecordings())
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    void loadConfig()
    void refresh()
    void decoy.getActiveRecording().then(setActive)

    const offStarted = decoy.onRecordingStarted((info) => {
      setActive(info)
      setProgress({ requests: 0, websockets: 0 })
    })
    const offProgress = decoy.onRecordingProgress(setProgress)
    const offFinished = decoy.onRecordingFinished(() => {
      setActive(null)
      void refresh()
    })

    return () => {
      offStarted()
      offProgress()
      offFinished()
    }
  }, [loadConfig, refresh])

  const start = useCallback(async () => {
    setError(null)
    const url = startUrl.trim()

    if (!url || url === 'https://' || !/^https?:\/\/.+/i.test(url)) {
      setError('Enter a start URL (https://…).')

      return
    }

    setBusy(true)

    try {
      await decoy.startRecording({
        label: label.trim(),
        startUrl: url,
        profileId,
        captureAll,
        autoRecord,
        exportHar,
      })
      setLabel('')
      await loadConfig() // pick up the new URL-history entry
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }, [label, startUrl, profileId, captureAll, autoRecord, exportHar, loadConfig])

  // Launch the user's REAL Chrome to sign in (Google blocks sign-in on any Chrome with a debugging
  // port open, so login runs debugging-OFF). When the user closes that window, a headless pass
  // copies its cookies into the selected profile's partition, so a later recording is authenticated.
  const openLogin = useCallback(async () => {
    setError(null)
    const url = startUrl.trim()

    if (!url || url === 'https://' || !/^https?:\/\/.+/i.test(url)) {
      setError('Enter a URL (https://…) to open.')

      return
    }

    try {
      await decoy.openLogin({ startUrl: url, profileId })
    } catch (e) {
      setError(String(e))
    }
  }, [startUrl, profileId])

  const stop = useCallback(() => {
    void decoy.stopRecording()
  }, [])

  const remove = useCallback(
    async (r: RecordingSummary) => {
      const { confirmed } = await decoy.confirmDelete(r.label)

      if (!confirmed) {
        return
      }

      try {
        await decoy.deleteRecording(r.runId)
        await refresh()
      } catch (e) {
        setError(String(e))
      }
    },
    [refresh],
  )

  const copyPath = useCallback(async (runId: string) => {
    try {
      await decoy.copyRecordingPath(runId)
      setCopiedRunId(runId)
      setTimeout(() => setCopiedRunId((cur) => (cur === runId ? null : cur)), 1200)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  // The profiles modal hands back the updated config after each create/delete.
  const onProfilesChanged = useCallback((cfg: DecoyConfig) => {
    setProfiles(cfg.profiles)
    setProfileId(cfg.lastProfileId)
    setDefaultChromeLogin(cfg.defaultChromeLogin ?? false)
  }, [])

  // Whether the currently-selected profile signs in via real Chrome (controls the Log in button).
  const selectedChromeLogin =
    profileId === 'default' ? defaultChromeLogin : (profiles.find((p) => p.id === profileId)?.chromeLogin ?? false)

  const pickFolder = useCallback(async () => {
    const res = await decoy.pickSessionsRoot()

    if (!res.canceled && res.path) {
      const cfg = await decoy.setSessionsRoot(res.path)

      setSessionsRoot(cfg.sessionsRoot)
      void refresh()
    }
  }, [refresh])

  const beginEdit = useCallback((r: RecordingSummary) => {
    setEditingRunId(r.runId)
    setEditValue(r.label)
  }, [])

  const commitEdit = useCallback(async () => {
    const id = editingRunId

    if (!id) {
      return
    }

    setEditingRunId(null)

    try {
      await decoy.renameRecording(id, editValue)
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }, [editingRunId, editValue, refresh])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          Decoy
        </div>
        <div className="tagline">Records browser sessions so agents can rebuild the API</div>
      </header>

      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {active && (
        <div className="recording-banner">
          <span className="rec-dot" />
          <span className="rec-banner-label">Recording — {active.label}</span>
          <span className="rec-banner-meta">
            {progress.requests} reqs · {progress.websockets} ws
          </span>
          <button className="sm" onClick={stop}>
            Stop &amp; save
          </button>
        </div>
      )}

      <section className="card">
        <h2>New recording</h2>
        <div className="row">
          <input
            className="grow"
            list="url-history"
            value={startUrl}
            placeholder="https://app.example.com"
            autoFocus
            onChange={(e) => setStartUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void start()}
            disabled={busy}
          />
          <input
            className="label-input"
            value={label}
            placeholder="label (optional)"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void start()}
            disabled={busy}
          />
          {selectedChromeLogin && (
            <button
              className="ghost"
              onClick={() => void openLogin()}
              disabled={busy}
              title="Launch real Chrome to log in (gets past Google sign-in). Log in, then CLOSE the Chrome window — its cookies are copied into the selected profile. Then Record in that profile."
            >
              Log in (Chrome)
            </button>
          )}
          <button
            className="primary"
            onClick={() => void start()}
            disabled={busy || active !== null}
            title={active ? 'A recording is already in progress — stop it first.' : undefined}
          >
            {busy ? 'Opening…' : 'Record'}
          </button>
        </div>
        <datalist id="url-history">
          {urlHistory.map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>
        <div className="toggles">
          <label
            className="toggle"
            title="Start capturing immediately. Off = open paused; press Record in the toolbar when ready."
          >
            <input type="checkbox" checked={autoRecord} onChange={(e) => setAutoRecord(e.target.checked)} />
            Auto-record
          </label>
          <label className="profile-pick" title="Which logged-in browser session to record in.">
            Profile
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)} disabled={busy}>
              <option value="fresh">Fresh session (no profile)</option>
              <option value="default">Default</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <button className="ghost sm" onClick={() => setProfilesOpen(true)} disabled={busy}>
            Manage…
          </button>
          <label
            className="toggle"
            title="Ignore the capture filters for this run and record every request — images, fonts, scripts, and all."
          >
            <input type="checkbox" checked={captureAll} onChange={(e) => setCaptureAll(e.target.checked)} />
            Capture all
          </label>
          <label className="toggle" title="Also write a standard HAR 1.2 file (session.har) next to the raw JSON.">
            <input type="checkbox" checked={exportHar} onChange={(e) => setExportHar(e.target.checked)} />
            Export HAR
          </label>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Recordings {recordings.length > 0 && <span className="badge-count">{recordings.length}</span>}</h2>
          <button className="ghost sm" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        {recordings.length === 0 ? (
          <p className="empty">No recordings yet.</p>
        ) : (
          <ul className="recordings">
            {recordings.map((r) => (
              <li key={r.runId} title={r.runId}>
                {editingRunId === r.runId ? (
                  <input
                    className="rec-edit"
                    autoFocus
                    value={editValue}
                    placeholder="name (blank = domain)"
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => void commitEdit()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        void commitEdit()
                      }

                      if (e.key === 'Escape') {
                        setEditingRunId(null)
                      }
                    }}
                  />
                ) : (
                  <button className="rec-label" onClick={() => beginEdit(r)} title="Click to rename">
                    {r.label}
                  </button>
                )}
                <span className="rec-meta">{recMeta(r)}</span>
                <span className="rec-actions">
                  <button className="ghost sm" onClick={() => void decoy.openRecording(r.runId)}>
                    Open folder
                  </button>
                  <button className="ghost sm" onClick={() => void copyPath(r.runId)}>
                    {copiedRunId === r.runId ? 'Copied' : 'Copy path'}
                  </button>
                  <button className="danger sm" onClick={() => void remove(r)}>
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Settings</h2>
        <div className="setting">
          <span className="setting-label">Sessions folder</span>
          <code className="path" title={sessionsRoot}>
            {sessionsRoot || '…'}
          </code>
          <button className="ghost sm" onClick={() => void pickFolder()}>
            Change…
          </button>
        </div>
        <div className="setting">
          <span className="setting-label">URL history</span>
          <span className="path muted-text">{urlHistory.length} saved</span>
          <button
            className="ghost sm"
            disabled={urlHistory.length === 0}
            onClick={() => void decoy.clearUrlHistory().then((c) => setUrlHistory(c.urlHistory))}
          >
            Clear
          </button>
        </div>
        <div className="setting">
          <span className="setting-label">Capture filters</span>
          <span className="path muted-text">
            {filters
              ? `skip ${filters.skipResourceTypes.length} types · block ${filters.blockHosts.length} hosts`
              : '…'}
          </span>
          <button className="ghost sm" disabled={!filters} onClick={() => setFiltersOpen(true)}>
            Edit…
          </button>
        </div>
      </section>

      {filtersOpen && filters && (
        <FiltersModal initial={filters} onClose={() => setFiltersOpen(false)} onSaved={setFilters} />
      )}

      {profilesOpen && (
        <ProfilesModal
          profiles={profiles}
          defaultChromeLogin={defaultChromeLogin}
          onClose={() => setProfilesOpen(false)}
          onChange={onProfilesChanged}
        />
      )}
    </div>
  )
}
