import { useState } from 'react'

import { decoy, type DecoyConfig, type Profile } from './bridge'

interface Props {
  profiles: Profile[]
  defaultChromeLogin: boolean
  onClose: () => void
  // Fired after a create/delete/toggle with the updated config so the panel re-syncs its selector.
  onChange: (config: DecoyConfig) => void
}

export function ProfilesModal({ profiles, defaultChromeLogin, onClose, onChange }: Props) {
  const [list, setList] = useState<Profile[]>(profiles)
  const [defaultChrome, setDefaultChrome] = useState(defaultChromeLogin)
  const [name, setName] = useState('')
  const [newChromeLogin, setNewChromeLogin] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sync = (config: DecoyConfig) => {
    setList(config.profiles)
    setDefaultChrome(config.defaultChromeLogin)
    setError(null)
    onChange(config)
  }

  const add = async () => {
    const label = name.trim()

    if (!label) {
      return
    }

    try {
      sync(await decoy.createProfile(label, newChromeLogin))
      setName('')
      setNewChromeLogin(false)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }

  const toggleChrome = async (id: string, value: boolean) => {
    try {
      sync(await decoy.setProfileChromeLogin(id, value))
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }

  const remove = async (p: Profile) => {
    const { confirmed } = await decoy.confirmDeleteProfile(p.label)

    if (!confirmed) {
      return
    }

    try {
      sync(await decoy.deleteProfile(p.id))
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Profiles</h2>
        <p className="hint">
          Each profile is its own logged-in browser session. Turn on <strong>Chrome login</strong> for any site that
          blocks Chromium-embedded sign-in (e.g. “Sign in with Google”): you sign in once in real Chrome and its cookies
          are mirrored into the profile. “Fresh session” is built in and isn’t listed here.
        </p>

        {error && (
          <div className="error" onClick={() => setError(null)}>
            {error}
          </div>
        )}

        <ul className="host-list">
          <li>
            <code>Default</code>
            <label className="toggle sm" title="Sign in to this profile via real Chrome (Google escape hatch).">
              <input
                type="checkbox"
                checked={defaultChrome}
                onChange={(e) => void toggleChrome('default', e.target.checked)}
              />
              Chrome login
            </label>
          </li>
          {list.map((p) => (
            <li key={p.id}>
              <code>{p.label}</code>
              <label className="toggle sm" title="Sign in to this profile via real Chrome (Google escape hatch).">
                <input
                  type="checkbox"
                  checked={p.chromeLogin ?? false}
                  onChange={(e) => void toggleChrome(p.id, e.target.checked)}
                />
                Chrome login
              </label>
              <button className="danger sm" onClick={() => void remove(p)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
        <div className="row">
          <input
            className="grow"
            value={name}
            placeholder="New profile name, e.g. Work"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          <label className="toggle sm" title="Use real Chrome to sign this profile in.">
            <input type="checkbox" checked={newChromeLogin} onChange={(e) => setNewChromeLogin(e.target.checked)} />
            Chrome login
          </label>
          <button className="ghost" onClick={() => void add()}>
            Add
          </button>
        </div>

        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
