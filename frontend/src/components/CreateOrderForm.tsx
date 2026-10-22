import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type FormEvent } from 'react'
import { ApiError, api, errorMessage } from '../api/client'
import type { Order, OrderInput, Product } from '../api/types'
import { formatRupiah } from '../lib/format'
import {
  fieldsToOrderErrors,
  hasOrderErrors,
  parsePositiveInt,
  validateOrderForm,
  type OrderFormErrors,
} from '../lib/validate'
import { Alert, FieldError } from './ui'

interface Line {
  id: number // stable React key
  sku: string
  qty: string
}

const noErrors: OrderFormErrors = { lines: {} }

export function CreateOrderForm({ onCreated }: { onCreated: (order: Order) => void }) {
  const queryClient = useQueryClient()
  const [customer, setCustomer] = useState('')
  const [lines, setLines] = useState<Line[]>([{ id: 1, sku: '', qty: '1' }])
  const nextId = useRef(2)
  const [errors, setErrors] = useState<OrderFormErrors>(noErrors)
  // One key per draft: a retried submit (double click, flaky network) can never create two orders.
  const [idempotencyKey] = useState(() => crypto.randomUUID())

  const catalog = useQuery({
    queryKey: ['products', 'catalog'],
    queryFn: () => api.listProducts({ search: '', filter: 'active', page: 1, limit: 100 }),
  })
  const bySku = new Map<string, Product>((catalog.data?.data ?? []).map((p) => [p.sku, p]))

  const mutation = useMutation({
    mutationFn: (input: OrderInput) => api.createOrder(input, idempotencyKey),
    onSuccess: async (order) => {
      await queryClient.invalidateQueries()
      onCreated(order)
    },
    onError: (err, input) => {
      if (!(err instanceof ApiError)) return
      if (err.code === 'VALIDATION_ERROR') {
        setErrors(fieldsToOrderErrors(err.fields))
      } else if (err.code === 'INSUFFICIENT_STOCK') {
        const i = input.items.findIndex((it) => it.sku === err.sku)
        if (i >= 0) setErrors({ lines: { [i]: { qty: `Only ${err.available} available` } } })
        void queryClient.invalidateQueries({ queryKey: ['products'] }) // refresh the stock hints
      }
    },
  })

  function updateLine(index: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l, i) => (i === index ? { ...l, ...patch } : l)))
    setErrors((e) => {
      if (!e.lines[index]) return e
      const rest = { ...e.lines }
      delete rest[index]
      return { ...e, lines: rest }
    })
  }

  function removeLine(index: number) {
    setLines((ls) => ls.filter((_, i) => i !== index))
    setErrors(noErrors) // indices shift, so old per-line errors no longer apply
  }

  function addLine() {
    setLines((ls) => [...ls, { id: nextId.current++, sku: '', qty: '1' }])
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    const found = validateOrderForm(customer, lines)
    setErrors(found)
    if (hasOrderErrors(found)) return
    mutation.mutate({
      customer: customer.trim(),
      items: lines.map((l) => ({ sku: l.sku.trim(), qty: parsePositiveInt(l.qty)! })),
    })
  }

  const estimate = lines.reduce((sum, l) => {
    const p = bySku.get(l.sku.trim())
    const q = parsePositiveInt(l.qty)
    return p && q ? sum + p.price * q : sum
  }, 0)

  const err = mutation.error

  return (
    <form onSubmit={submit} noValidate className="form order-form">
      <h2>New sales order</h2>

      <label className="label" htmlFor="order-customer">
        Customer
      </label>
      <input
        id="order-customer"
        className={`input ${errors.customer ? 'invalid' : ''}`}
        value={customer}
        placeholder="e.g. Toko Sinar Jaya"
        autoFocus
        onChange={(e) => setCustomer(e.target.value)}
      />
      <FieldError message={errors.customer} />

      <div className="label">Items</div>
      <datalist id="catalog-skus">
        {catalog.data?.data.map((p) => (
          <option key={p.id} value={p.sku}>
            {p.name}
          </option>
        ))}
      </datalist>

      <div className="lines">
        {lines.map((line, i) => {
          const product = bySku.get(line.sku.trim())
          const lineErr = errors.lines[i]
          const failedSku = err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK' && lineErr?.qty !== undefined
          return (
            <div key={line.id} className={`line ${lineErr ? 'line-error' : ''}`}>
              <span className="line-no">{i + 1}</span>
              <div className="line-sku">
                <input
                  className={`input mono ${lineErr?.sku ? 'invalid' : ''}`}
                  list="catalog-skus"
                  placeholder="SKU"
                  aria-label={`Item ${i + 1} SKU`}
                  value={line.sku}
                  onChange={(e) => updateLine(i, { sku: e.target.value })}
                />
                {product ? (
                  <span className="hint">
                    {product.name} · {formatRupiah(product.price)} · {product.stock} in stock
                  </span>
                ) : null}
                <FieldError message={lineErr?.sku} />
              </div>
              <div className="line-qty">
                <input
                  className={`input ${lineErr?.qty ? 'invalid' : ''}`}
                  inputMode="numeric"
                  aria-label={`Item ${i + 1} quantity`}
                  value={line.qty}
                  onChange={(e) => updateLine(i, { qty: e.target.value })}
                />
                <FieldError message={lineErr?.qty} />
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={`Remove item ${i + 1}`}
                disabled={lines.length === 1}
                onClick={() => removeLine(i)}
              >
                ×
              </button>
              {failedSku && <span className="line-flag">Insufficient stock</span>}
            </div>
          )
        })}
      </div>
      <FieldError message={errors.items} />
      <button type="button" className="btn btn-sm" onClick={addLine}>
        + Add item
      </button>

      <p className="estimate">
        Estimated total <strong>{formatRupiah(estimate)}</strong>
        <span className="muted small"> — the final total is computed by the server from current prices.</span>
      </p>

      {err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK' ? (
        <Alert>
          Not enough stock for <strong className="mono">{err.sku}</strong>: only <strong>{err.available}</strong>{' '}
          available. Nothing was saved; adjust the quantity and try again.
        </Alert>
      ) : err instanceof ApiError && err.code === 'VALIDATION_ERROR' ? (
        <Alert>The server rejected the order. Fix the highlighted fields.</Alert>
      ) : err ? (
        <Alert>{errorMessage(err)}</Alert>
      ) : null}

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
          {mutation.isPending ? 'Placing order…' : 'Place order'}
        </button>
      </div>
    </form>
  )
}
