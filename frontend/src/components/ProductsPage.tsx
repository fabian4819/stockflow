import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, api, errorMessage } from '../api/client'
import type { Product, ProductFilter, ProductQuery } from '../api/types'
import { useDebounce } from '../hooks/useDebounce'
import { formatDateTime, formatRupiah, isLowStock, timeAgo } from '../lib/format'
import { AdjustStockModal } from './AdjustStockModal'
import { ProductFormModal } from './ProductFormModal'
import { Alert, Badge } from './ui'

const FILTERS: { value: ProductFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'low', label: 'Low stock (≤ 10)' },
]

const PAGE_SIZE = 10
const COLUMNS = 7

export function ProductsPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ProductFilter>('all')
  const [page, setPage] = useState(1)
  const debouncedSearch = useDebounce(search.trim(), 300)

  const params: ProductQuery = { search: debouncedSearch, filter, page, limit: PAGE_SIZE }
  const products = useQuery({
    queryKey: ['products', params],
    queryFn: () => api.listProducts(params),
    placeholderData: keepPreviousData,
  })

  const [adjusting, setAdjusting] = useState<Product | null>(null)
  const [editing, setEditing] = useState<Product | 'new' | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  const remove = useMutation({
    mutationFn: (p: Product) => api.deleteProduct(p.id),
    onSuccess: async (_, p) => {
      await queryClient.invalidateQueries()
      setNotice({ tone: 'success', text: `${p.sku} deleted` })
    },
    onError: (err, p) => {
      const text =
        err instanceof ApiError && err.code === 'PRODUCT_HAS_HISTORY'
          ? `${p.sku} has stock movement history and cannot be deleted. Deactivate it instead.`
          : errorMessage(err)
      setNotice({ tone: 'error', text })
    },
    onSettled: () => setConfirmDeleteId(null),
  })

  const done = (text: string) => {
    setAdjusting(null)
    setEditing(null)
    setNotice({ tone: 'success', text })
  }

  const hasCriteria = search !== '' || filter !== 'all'
  const data = products.data
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Products</h2>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          + New product
        </button>
      </div>

      <div className="toolbar">
        <input
          type="search"
          className="input search"
          placeholder="Search SKU or name…"
          aria-label="Search products"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
        />
        <div className="chips" role="group" aria-label="Filter products">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`chip ${filter === f.value ? 'active' : ''}`}
              aria-pressed={filter === f.value}
              onClick={() => {
                setFilter(f.value)
                setPage(1)
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        {products.isFetching && !products.isPending && <span className="muted small">Updating…</span>}
      </div>

      {notice && (
        <div className="notice">
          <Alert tone={notice.tone}>
            {notice.text}
            <button type="button" className="btn-link" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </Alert>
        </div>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Name</th>
              <th className="num">Price</th>
              <th className="num">Stock</th>
              <th>Status</th>
              <th>Last movement</th>
              <th className="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {products.isPending ? (
              Array.from({ length: 6 }, (_, i) => (
                <tr key={i} className="skeleton-row" aria-hidden="true">
                  {Array.from({ length: COLUMNS }, (_, j) => (
                    <td key={j}>
                      <span className="skeleton" />
                    </td>
                  ))}
                </tr>
              ))
            ) : products.isError ? (
              <tr>
                <td colSpan={COLUMNS} className="state-cell">
                  <p className="state-title">Could not load products</p>
                  <p className="muted">{errorMessage(products.error)}</p>
                  <button type="button" className="btn" onClick={() => void products.refetch()}>
                    Retry
                  </button>
                </td>
              </tr>
            ) : data && data.data.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS} className="state-cell">
                  <p className="state-title">No products found</p>
                  {hasCriteria ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setSearch('')
                        setFilter('all')
                        setPage(1)
                      }}
                    >
                      Clear search and filters
                    </button>
                  ) : (
                    <p className="muted">Create your first product to get started.</p>
                  )}
                </td>
              </tr>
            ) : (
              data?.data.map((p) => (
                <tr key={p.id} className={p.is_active ? '' : 'row-inactive'}>
                  <td className="mono">{p.sku}</td>
                  <td>{p.name}</td>
                  <td className="num">{formatRupiah(p.price)}</td>
                  <td className={`num ${isLowStock(p.stock) ? 'stock-low' : ''}`}>{p.stock}</td>
                  <td>
                    <span className="badges">
                      {p.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="grey">Inactive</Badge>}
                      {isLowStock(p.stock) && <Badge tone={p.stock === 0 ? 'red' : 'amber'}>{p.stock === 0 ? 'Out' : 'Low'}</Badge>}
                    </span>
                  </td>
                  <td>
                    {p.last_movement_at ? (
                      <time dateTime={p.last_movement_at} title={formatDateTime(p.last_movement_at)}>
                        {timeAgo(p.last_movement_at)}
                      </time>
                    ) : (
                      <span className="muted">Never</span>
                    )}
                  </td>
                  <td className="actions-col">
                    {confirmDeleteId === p.id ? (
                      <span className="confirm">
                        Delete?
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(p)}
                        >
                          {remove.isPending ? 'Deleting…' : 'Yes'}
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => setConfirmDeleteId(null)}>
                          No
                        </button>
                      </span>
                    ) : (
                      <span className="row-actions">
                        <button type="button" className="btn btn-sm" onClick={() => setAdjusting(p)}>
                          Adjust stock
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(p)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost danger-text"
                          onClick={() => setConfirmDeleteId(p.id)}
                        >
                          Delete
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {data && data.total > 0 && (
        <div className="pagination">
          <span className="muted small">
            {(data.page - 1) * data.limit + 1}–{Math.min(data.page * data.limit, data.total)} of {data.total}
          </span>
          <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ← Prev
          </button>
          <span className="small">
            Page {page} / {totalPages}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      )}

      {adjusting && <AdjustStockModal product={adjusting} onClose={() => setAdjusting(null)} onDone={done} />}
      {editing && (
        <ProductFormModal
          product={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onDone={done}
        />
      )}
    </section>
  )
}
