import { useQuery } from '@tanstack/react-query'
import { api, errorMessage } from '../api/client'
import { formatRupiah } from '../lib/format'

// Figures come from the server (/products/summary, /reports/daily-sales) so they
// cover every product, not just the visible page. Every mutation invalidates
// all queries, which refreshes these cards too.
export function SummaryCards() {
  const summary = useQuery({ queryKey: ['summary'], queryFn: api.summary })
  const sales = useQuery({ queryKey: ['daily-sales'], queryFn: () => api.dailySales() })

  if (summary.isError) {
    return (
      <div className="cards-error muted small">
        Summary unavailable: {errorMessage(summary.error)}{' '}
        <button type="button" className="btn-link" onClick={() => void summary.refetch()}>
          Retry
        </button>
      </div>
    )
  }

  const s = summary.data
  const d = sales.data
  const cards = [
    { label: 'Total products', value: s?.total_products },
    { label: 'Active products', value: s?.active_products },
    { label: 'Total stock value', value: s && formatRupiah(s.total_stock_value) },
    { label: 'Low stock (≤ 10)', value: s?.low_stock_count, warn: (s?.low_stock_count ?? 0) > 0 },
    {
      label: "Today's sales",
      value: d && formatRupiah(d.revenue),
      sub: d && `${d.orders} order${d.orders === 1 ? '' : 's'} · ${d.units} units`,
    },
  ]

  return (
    <div className="cards">
      {cards.map((c) => (
        <div key={c.label} className={`card ${c.warn ? 'card-warn' : ''}`}>
          <span className="card-label">{c.label}</span>
          {c.value === undefined ? <span className="skeleton skeleton-lg" /> : <span className="card-value">{c.value}</span>}
          {c.sub && <span className="card-sub">{c.sub}</span>}
        </div>
      ))}
    </div>
  )
}
