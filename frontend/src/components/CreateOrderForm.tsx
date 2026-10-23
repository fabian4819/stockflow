import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, api, errorMessage } from '../api/client'
import type { Order, OrderInput, Product } from '../api/types'
import { useDebounce } from '../hooks/useDebounce'
import { formatRupiah } from '../lib/format'
import {
  fieldsToOrderErrors,
  hasOrderErrors,
  parsePositiveInt,
  validateOrderForm,
  type LineErrors,
  type OrderFormErrors,
} from '../lib/validate'
import { Alert, FieldError } from './ui'

interface Line {
  id: number // stable React key
  sku: string
  qty: string
}

const noErrors: OrderFormErrors = { lines: {} }
const SUGGESTION_LIMIT = 10

export function CreateOrderForm({ onCreated }: { onCreated: (order: Order) => void }) {
  const queryClient = useQueryClient()
  const [customer, setCustomer] = useState('')
  const [lines, setLines] = useState<Line[]>([{ id: 1, sku: '', qty: '1' }])
  const nextId = useRef(2)
  const [errors, setErrors] = useState<OrderFormErrors>(noErrors)
  // One key per draft: a retried submit (double click, flaky network) can never create two orders.
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  // Product matching each line's SKU exactly, as found by that line's search. Keyed by line id.
  const [resolved, setResolved] = useState<Record<number, Product | undefined>>({})

  const resolveLine = useCallback((lineId: number, product: Product | undefined) => {
    setResolved((r) => (r[lineId] === product ? r : { ...r, [lineId]: product }))
  }, [])

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
    const p = resolved[l.id]
    const q = parsePositiveInt(l.qty)
    return p && q ? sum + p.price * q : sum
  }, 0)

  const err = mutation.error
  const insufficient = err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK'

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
      <div className="lines">
        {lines.map((line, i) => (
          <OrderLineRow
            key={line.id}
            index={i}
            line={line}
            error={errors.lines[i]}
            insufficient={insufficient && errors.lines[i]?.qty !== undefined}
            canRemove={lines.length > 1}
            onChange={(patch) => updateLine(i, patch)}
            onRemove={() => removeLine(i)}
            onResolve={resolveLine}
          />
        ))}
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

interface LineRowProps {
  index: number
  line: Line
  error?: LineErrors
  insufficient: boolean
  canRemove: boolean
  onChange: (patch: Partial<Line>) => void
  onRemove: () => void
  onResolve: (lineId: number, product: Product | undefined) => void
}

/** One order line. Searches active products on the server as the SKU is typed. */
function OrderLineRow({ index, line, error, insufficient, canRemove, onChange, onRemove, onResolve }: LineRowProps) {
  const sku = line.sku.trim()
  const search = useDebounce(sku, 250)
  const suggestions = useQuery({
    queryKey: ['products', 'suggest', search],
    queryFn: () => api.listProducts({ search, filter: 'active', page: 1, limit: SUGGESTION_LIMIT }),
    placeholderData: keepPreviousData,
  })

  // Search matches substrings case-insensitively; only an exact SKU is a real pick.
  const product = sku ? suggestions.data?.data.find((p) => p.sku === sku) : undefined
  useEffect(() => onResolve(line.id, product), [line.id, product, onResolve])

  const listId = `sku-options-${line.id}`
  return (
    <div className={`line ${error ? 'line-error' : ''}`}>
      <span className="line-no">{index + 1}</span>
      <div className="line-sku">
        <input
          className={`input mono ${error?.sku ? 'invalid' : ''}`}
          list={listId}
          placeholder="Type SKU or product name"
          aria-label={`Item ${index + 1} SKU`}
          autoComplete="off"
          value={line.sku}
          onChange={(e) => onChange({ sku: e.target.value })}
        />
        <datalist id={listId}>
          {suggestions.data?.data.map((p) => (
            <option key={p.id} value={p.sku}>
              {p.name} · {p.stock} in stock
            </option>
          ))}
        </datalist>
        {product ? (
          <span className="hint">
            {product.name} · {formatRupiah(product.price)} · {product.stock} in stock
          </span>
        ) : suggestions.isError ? (
          <span className="hint">Suggestions unavailable: {errorMessage(suggestions.error)}</span>
        ) : null}
        <FieldError message={error?.sku} />
      </div>
      <div className="line-qty">
        <input
          className={`input ${error?.qty ? 'invalid' : ''}`}
          inputMode="numeric"
          aria-label={`Item ${index + 1} quantity`}
          value={line.qty}
          onChange={(e) => onChange({ qty: e.target.value })}
        />
        <FieldError message={error?.qty} />
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label={`Remove item ${index + 1}`}
        disabled={!canRemove}
        onClick={onRemove}
      >
        ×
      </button>
      {insufficient && <span className="line-flag">Insufficient stock</span>}
    </div>
  )
}
