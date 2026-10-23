import { useState, type MouseEvent } from 'react'
import { OrdersPage, type OrderView } from './components/OrdersPage'
import { ProductsPage } from './components/ProductsPage'
import { SummaryCards } from './components/SummaryCards'
import { routePath, useRoute, type Route } from './hooks/useRoute'

export default function App() {
  const { route, navigate } = useRoute()
  const [draft, setDraft] = useState(0)
  // In memory only, so the "Order created" banner doesn't come back on refresh.
  const [createdOrderId, setCreatedOrderId] = useState<number | null>(null)

  // The Orders tab returns to whatever order screen was open last. Updated
  // during render (React's "adjust state on prop change" pattern), so it also
  // follows back/forward navigation.
  const [lastOrdersRoute, setLastOrdersRoute] = useState<Route>({ page: 'new-order' })
  if (route.page !== 'products' && routePath(route) !== routePath(lastOrdersRoute)) setLastOrdersRoute(route)

  const orderView: OrderView =
    route.page === 'order'
      ? { kind: 'order', id: route.id, justCreated: route.id === createdOrderId }
      : { kind: 'new', draft }

  function showOrderView(v: OrderView) {
    if (v.kind === 'new') {
      setDraft(v.draft)
      navigate({ page: 'new-order' })
    } else {
      if (v.justCreated) setCreatedOrderId(v.id)
      navigate({ page: 'order', id: v.id })
    }
  }

  const tabs = [
    { label: 'Products', target: { page: 'products' } as Route, active: route.page === 'products' },
    { label: 'Sales orders', target: lastOrdersRoute, active: route.page !== 'products' },
  ]

  function followLink(e: MouseEvent<HTMLAnchorElement>, target: Route) {
    // Let the browser handle new-tab / new-window clicks.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    navigate(target)
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ▦
          </span>
          StockFlow
        </div>
        <nav className="tabs" aria-label="Sections">
          {tabs.map((t) => (
            <a
              key={t.label}
              href={routePath(t.target)}
              className={`tab ${t.active ? 'active' : ''}`}
              aria-current={t.active ? 'page' : undefined}
              onClick={(e) => followLink(e, t.target)}
            >
              {t.label}
            </a>
          ))}
        </nav>
      </header>

      <main className="content">
        <SummaryCards />
        {route.page === 'products' ? <ProductsPage /> : <OrdersPage view={orderView} onView={showOrderView} />}
      </main>
    </div>
  )
}
