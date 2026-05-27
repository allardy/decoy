import { useState } from 'react'

import { decoy, KNOWN_RESOURCE_TYPES, type FilterConfig } from './bridge'

interface Props {
  initial: FilterConfig
  onClose: () => void
  onSaved: (filters: FilterConfig) => void
}

export function FiltersModal({ initial, onClose, onSaved }: Props) {
  const [skip, setSkip] = useState<string[]>(initial.skipResourceTypes)
  const [hosts, setHosts] = useState<string[]>(initial.blockHosts)
  const [newHost, setNewHost] = useState('')

  const toggleType = (t: string) => {
    setSkip((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]))
  }

  const addHost = () => {
    const h = newHost.trim()

    if (!h || hosts.includes(h)) {
      setNewHost('')

      return
    }

    setHosts((hs) => [...hs, h])
    setNewHost('')
  }

  const reset = async () => {
    const cfg = await decoy.resetFilters()

    setSkip(cfg.filters.skipResourceTypes)
    setHosts(cfg.filters.blockHosts)
  }

  const done = async () => {
    const filters: FilterConfig = { skipResourceTypes: skip, blockHosts: hosts }

    await decoy.setFilters(filters)
    onSaved(filters)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Capture filters</h2>
        <p className="hint">Skipped while recording — unless “Capture all” is ticked for that run.</p>

        <h3>Skip resource types</h3>
        <div className="type-grid">
          {KNOWN_RESOURCE_TYPES.map((t) => (
            <label key={t} className="toggle">
              <input type="checkbox" checked={skip.includes(t)} onChange={() => toggleType(t)} />
              {t}
            </label>
          ))}
        </div>

        <h3>Block URL substrings</h3>
        <ul className="host-list">
          {hosts.length === 0 && <li className="empty">None — nothing blocked by host.</li>}
          {hosts.map((h) => (
            <li key={h}>
              <code>{h}</code>
              <button className="danger sm" onClick={() => setHosts((hs) => hs.filter((x) => x !== h))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="row">
          <input
            className="grow"
            value={newHost}
            placeholder="e.g. analytics.example.com"
            onChange={(e) => setNewHost(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addHost()}
          />
          <button className="ghost" onClick={addHost}>
            Add
          </button>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={() => void reset()}>
            Reset to defaults
          </button>
          <button className="primary" onClick={() => void done()}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
