import { type ReactNode } from 'react'

interface Props {
  title: string
  confirmLabel: string
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
  children: ReactNode
}

// A lightweight in-app confirm dialog (replaces the native confirm/showMessageBox), reusing the
// shared modal chrome. The confirm action is styled as a solid danger button for destructive ops.
export function ConfirmModal({ title, confirmLabel, busy, onConfirm, onClose, children }: Props) {
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <div className="confirm-body">{children}</div>
        <div className="modal-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="danger-solid" onClick={onConfirm} disabled={busy}>
            {busy ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
