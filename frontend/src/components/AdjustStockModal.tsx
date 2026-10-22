import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { ApiError, api, errorMessage } from '../api/client'
import type { MovementType, Product, StockAdjustment } from '../api/types'
import { formatDateTime, timeAgo } from '../lib/format'
import { parsePositiveInt, qtyError } from '../lib/validate'
import { Alert, FieldError, Modal } from './ui'

interface Props {
  product: Product
  onClose: () => void
  onDone: (message: string) => void
}

export function AdjustStockModal({ product, onClose, onDone }: Props) {
  const queryClient = useQueryClient()
  const [type, setType] = useState<MovementType>('in')
  const [qty, setQty] = useState('')
  const [note, setNote] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const movements = useQuery({
    queryKey: ['movements', product.id],
    queryFn: () => api.listMovements(product.id),
  })

  const mutation = useMutation({
    mutationFn: (input: StockAdjustment) => api.adjustStock(product.id, input),
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries()
      onDone(`${updated.sku}: stock is now ${updated.stock}`)
    },
    onError: (err) => {
      // The list may be showing stale stock; refresh it so the table matches what the server just told us.
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK') void queryClient.invalidateQueries()
    },
  })

  const err = mutation.error
  const serverFields = err instanceof ApiError ? err.fields : {}
  const clientQtyError = submitted ? qtyError(qty) : undefined

  function submit(e: FormEvent) {
    e.preventDefault()
    setSubmitted(true)
    const n = parsePositiveInt(qty)
    if (n === null) return
    mutation.mutate({ type, qty: n, note: note.trim() })
  }

  return (
    <Modal title={`Adjust stock · ${product.sku}`} onClose={onClose}>
      <form onSubmit={submit} noValidate className="form">
        <p className="muted">
          {product.name} — current stock <strong>{product.stock}</strong>
        </p>

        <fieldset className="segmented" disabled={mutation.isPending}>
          <legend className="label">Direction</legend>
          <label className={type === 'in' ? 'active' : ''}>
            <input type="radio" name="type" value="in" checked={type === 'in'} onChange={() => setType('in')} />
            Stock in (+)
          </label>
          <label className={type === 'out' ? 'active' : ''}>
            <input type="radio" name="type" value="out" checked={type === 'out'} onChange={() => setType('out')} />
            Stock out (−)
          </label>
        </fieldset>

        <label className="label" htmlFor="adjust-qty">
          Quantity
        </label>
        <input
          id="adjust-qty"
          className={`input ${clientQtyError || serverFields.qty ? 'invalid' : ''}`}
          inputMode="numeric"
          autoFocus
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          aria-invalid={Boolean(clientQtyError || serverFields.qty)}
        />
        <FieldError message={clientQtyError ?? serverFields.qty} />

        <label className="label" htmlFor="adjust-note">
          Note <span className="muted">(optional)</span>
        </label>
        <input
          id="adjust-note"
          className="input"
          value={note}
          maxLength={500}
          placeholder="e.g. Goods receipt PO-123, damaged in storage"
          onChange={(e) => setNote(e.target.value)}
        />

        {err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK' ? (
          <Alert>
            Not enough stock: only <strong>{err.available}</strong> unit(s) of {err.sku ?? product.sku} available.
          </Alert>
        ) : err ? (
          <Alert>{errorMessage(err)}</Alert>
        ) : null}

        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : type === 'in' ? 'Add stock' : 'Remove stock'}
          </button>
        </div>
      </form>

      <section className="history">
        <h3>Recent movements</h3>
        {movements.isPending ? (
          <p className="muted">Loading…</p>
        ) : movements.isError ? (
          <p className="muted">Could not load history: {errorMessage(movements.error)}</p>
        ) : movements.data.data.length === 0 ? (
          <p className="muted">No movements yet.</p>
        ) : (
          <ul>
            {movements.data.data.slice(0, 8).map((m) => (
              <li key={m.id}>
                <span className={m.type === 'in' ? 'qty-in' : 'qty-out'}>
                  {m.type === 'in' ? '+' : '−'}
                  {m.qty}
                </span>
                <span className="history-note">{m.note ?? '—'}</span>
                <time dateTime={m.created_at} title={formatDateTime(m.created_at)} className="muted">
                  {timeAgo(m.created_at)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Modal>
  )
}
