// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../api/client'
import type { Product } from '../api/types'
import { CreateOrderForm } from './CreateOrderForm'

// Keep the real ApiError class (the form checks `instanceof`), stub only the network calls.
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, api: { ...actual.api, listProducts: vi.fn(), createOrder: vi.fn() } }
})

const products: Product[] = [
  { id: 1, sku: 'BRG-001', name: 'Beras Premium 5kg', price: 78500, stock: 110, is_active: true, created_at: '2026-10-13T00:00:00Z', last_movement_at: null },
  { id: 5, sku: 'BRG-005', name: 'Kopi Bubuk 200g', price: 32000, stock: 3, is_active: true, created_at: '2026-10-13T00:00:00Z', last_movement_at: null },
]

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <CreateOrderForm onCreated={vi.fn()} />
    </QueryClientProvider>,
  )
}

/** Fills customer and two lines: BRG-001 × 1, BRG-005 × qty2. */
function fillTwoLineOrder(qty2: string) {
  fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'Toko Makmur' } })
  fireEvent.change(screen.getByLabelText('Item 1 SKU'), { target: { value: 'BRG-001' } })
  fireEvent.click(screen.getByRole('button', { name: '+ Add item' }))
  fireEvent.change(screen.getByLabelText('Item 2 SKU'), { target: { value: 'BRG-005' } })
  fireEvent.change(screen.getByLabelText('Item 2 quantity'), { target: { value: qty2 } })
  fireEvent.click(screen.getByRole('button', { name: 'Place order' }))
}

/** The order line (row) that contains a given element. */
const lineOf = (el: HTMLElement) => el.closest('.line') as HTMLElement
const lineRows = () => Array.from(document.querySelectorAll<HTMLElement>('.lines > .line'))

describe('CreateOrderForm', () => {
  beforeEach(() => {
    vi.mocked(api.listProducts).mockResolvedValue({ data: products, page: 1, limit: 10, total: products.length })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('highlights exactly the line the server rejected with 409 INSUFFICIENT_STOCK', async () => {
    vi.mocked(api.createOrder).mockRejectedValue(
      new ApiError(409, { code: 'INSUFFICIENT_STOCK', message: 'insufficient stock', sku: 'BRG-005', available: 3 }),
    )
    renderForm()
    fillTwoLineOrder('5')

    const lineError = await screen.findByText('Only 3 available')
    const [first, second] = lineRows()
    expect(lineOf(lineError)).toBe(second)
    expect(second.className).toContain('line-error')
    expect(second.textContent).toContain('Insufficient stock')
    expect(first.className).not.toContain('line-error')

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('BRG-005')
    expect(alert.textContent).toContain('only 3 available')

    expect(api.createOrder).toHaveBeenCalledWith(
      { customer: 'Toko Makmur', items: [{ sku: 'BRG-001', qty: 1 }, { sku: 'BRG-005', qty: 5 }] },
      expect.any(String),
    )
  })

  it('puts a 400 field error for items[1].qty on line 2', async () => {
    vi.mocked(api.createOrder).mockRejectedValue(
      new ApiError(400, {
        code: 'VALIDATION_ERROR',
        message: 'order is invalid',
        fields: { 'items[1].qty': 'qty must be at most 1000000' },
      }),
    )
    renderForm()
    fillTwoLineOrder('2')

    const fieldError = await screen.findByText('qty must be at most 1000000')
    const [first, second] = lineRows()
    expect(lineOf(fieldError)).toBe(second)
    expect(screen.getByLabelText('Item 2 quantity').className).toContain('invalid')
    expect(first.className).not.toContain('line-error')
    expect(screen.getByRole('alert').textContent).toContain('Fix the highlighted fields')
  })
})
