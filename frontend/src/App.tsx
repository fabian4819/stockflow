import { useState } from 'react'
import { OrdersPage, type OrderView } from './components/OrdersPage'
import { ProductsPage } from './components/ProductsPage'
import { SummaryCards } from './components/SummaryCards'

type Tab = 'products' | 'orders'

export default function App() {
  const [tab, setTab] = useState<Tab>('products')
  const [orderView, setOrderView] = useState<OrderView>({ kind: 'new', draft: 0 })

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
          {(['products', 'orders'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`tab ${tab === t ? 'active' : ''}`}
              aria-current={tab === t ? 'page' : undefined}
              onClick={() => setTab(t)}
            >
              {t === 'products' ? 'Products' : 'Sales orders'}
            </button>
          ))}
        </nav>
      </header>

      <main className="content">
        <SummaryCards />
        {tab === 'products' ? <ProductsPage /> : <OrdersPage view={orderView} onView={setOrderView} />}
      </main>
    </div>
  )
}
