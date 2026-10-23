import { useEffect, useRef, type ReactNode } from 'react'

/** Native <dialog> as a modal: focus trap, Escape and backdrop come from the browser. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  // No close() in cleanup: it fires the "close" event, which would call onClose
  // during StrictMode's mount/unmount/mount cycle. Unmounting removes the dialog anyway.
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal()
  }, [])
  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-labelledby="modal-title">
      <div className="modal-head">
        <h2 id="modal-title">{title}</h2>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      {children}
    </dialog>
  )
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'success' | 'info'; children: ReactNode }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`alert alert-${tone}`}>
      {children}
    </div>
  )
}

export function Badge({ tone, children }: { tone: 'green' | 'grey' | 'amber' | 'red'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function FieldError({ message }: { message?: string }) {
  return message ? <p className="field-error">{message}</p> : null
}
