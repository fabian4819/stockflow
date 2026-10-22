import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, errorMessage } from '../api/client'
import { formatDateTime, formatRupiah } from '../lib/format'
import { Alert, Badge } from './ui'

export function OrderDetail({ orderId, justCreated }: { orderId: number; justCreated: boolean }) {
  const queryClient = useQueryClient()
  const order = useQuery({ queryKey: ['order', orderId], queryFn: () => api.getOrder(orderId) })
  const [confirming, setConfirming] = useState(false)

  const cancel = useMutation({
    mutationFn: () => api.cancelOrder(orderId),
    // Refresh everything: products (restored stock), summary cards, order list.
    onSettled: async () => {
      setConfirming(false)
      await queryClient.invalidateQueries()
    },
  })

  if (order.isPending) {
    return (
      <div className="order-detail">
        <span className="skeleton skeleton-lg" />
        <span className="skeleton" />
        <span className="skeleton" />
      </div>
    )
  }
  if (order.isError) {
    return (
      <div className="order-detail state-cell">
        <p className="state-title">Could not load order #{orderId}</p>
        <p className="muted">{errorMessage(order.error)}</p>
        <button type="button" className="btn" onClick={() => void order.refetch()}>
          Retry
        </button>
      </div>
    )
  }

  const o = order.data
  const items = o.items ?? []
  return (
    <div className="order-detail">
      {justCreated && !cancel.isSuccess && (
        <Alert tone="success">
          Order #{o.id} created. Stock has been deducted for {items.length} item{items.length === 1 ? '' : 's'}.
        </Alert>
      )}
      {cancel.isSuccess && (
        <Alert tone="success">Order #{o.id} cancelled. Stock was returned for every item below.</Alert>
      )}
      {cancel.isError && <Alert>{errorMessage(cancel.error)}</Alert>}

      <div className="order-head">
        <div>
          <h2>Order #{o.id}</h2>
          <p className="muted">
            {o.customer} · {formatDateTime(o.created_at)}
            {o.cancelled_at && ` · cancelled ${formatDateTime(o.cancelled_at)}`}
          </p>
        </div>
        {o.status === 'CREATED' ? <Badge tone="green">Created</Badge> : <Badge tone="grey">Cancelled</Badge>}
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Product</th>
              <th className="num">Qty</th>
              <th className="num">Unit price</th>
              <th className="num">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.sku}>
                <td className="mono">{it.sku}</td>
                <td>{it.name}</td>
                <td className="num">{it.qty}</td>
                <td className="num">{formatRupiah(it.unit_price)}</td>
                <td className="num">{formatRupiah(it.subtotal)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} className="num">
                Total
              </td>
              <td className="num total">{formatRupiah(o.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {o.status === 'CREATED' && (
        <div className="form-actions">
          {confirming ? (
            <span className="confirm">
              Cancel this order and return its stock?
              <button
                type="button"
                className="btn btn-danger"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                {cancel.isPending ? 'Cancelling…' : 'Yes, cancel order'}
              </button>
              <button type="button" className="btn" disabled={cancel.isPending} onClick={() => setConfirming(false)}>
                Keep order
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-danger-outline" onClick={() => setConfirming(true)}>
              Cancel order
            </button>
          )}
        </div>
      )}
    </div>
  )
}
