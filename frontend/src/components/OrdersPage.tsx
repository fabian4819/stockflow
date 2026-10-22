import { useQuery } from '@tanstack/react-query'
import { api, errorMessage } from '../api/client'
import { formatRupiah, timeAgo } from '../lib/format'
import { CreateOrderForm } from './CreateOrderForm'
import { OrderDetail } from './OrderDetail'
import { Badge } from './ui'

export type OrderView = { kind: 'new'; draft: number } | { kind: 'order'; id: number; justCreated: boolean }

export function OrdersPage({ view, onView }: { view: OrderView; onView: (v: OrderView) => void }) {
  const orders = useQuery({ queryKey: ['orders'], queryFn: api.listOrders })

  return (
    <div className="orders-layout">
      <aside className="panel orders-list">
        <div className="panel-head">
          <h2>Orders</h2>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => onView({ kind: 'new', draft: Date.now() })}
          >
            + New order
          </button>
        </div>
        {orders.isPending ? (
          <p className="muted pad">Loading…</p>
        ) : orders.isError ? (
          <div className="pad">
            <p className="muted">{errorMessage(orders.error)}</p>
            <button type="button" className="btn btn-sm" onClick={() => void orders.refetch()}>
              Retry
            </button>
          </div>
        ) : orders.data.data.length === 0 ? (
          <p className="muted pad">No orders yet.</p>
        ) : (
          <ul>
            {orders.data.data.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  className={`order-row ${view.kind === 'order' && view.id === o.id ? 'active' : ''}`}
                  onClick={() => onView({ kind: 'order', id: o.id, justCreated: false })}
                >
                  <span className="order-row-top">
                    <strong>#{o.id}</strong> {o.customer}
                  </span>
                  <span className="order-row-bottom">
                    <span>{formatRupiah(o.total)}</span>
                    <span className="muted small">{timeAgo(o.created_at)}</span>
                    {o.status === 'CANCELLED' && <Badge tone="grey">Cancelled</Badge>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="panel">
        {view.kind === 'new' ? (
          <CreateOrderForm
            key={view.draft}
            onCreated={(o) => onView({ kind: 'order', id: o.id, justCreated: true })}
          />
        ) : (
          <OrderDetail key={view.id} orderId={view.id} justCreated={view.justCreated} />
        )}
      </section>
    </div>
  )
}
