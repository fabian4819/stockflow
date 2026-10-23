// The only module that calls fetch. Components call these functions and get
// either typed data or an ApiError; they never build URLs or parse errors.
import type {
  DailySales,
  ErrorBody,
  ErrorCode,
  Movement,
  Order,
  OrderInput,
  Page,
  Product,
  ProductInput,
  ProductQuery,
  ProductUpdate,
  StockAdjustment,
  Summary,
} from './types'

export class ApiError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly fields: Record<string, string>
  readonly sku?: string
  readonly available?: number

  constructor(status: number, body: ErrorBody) {
    super(body.message)
    this.name = 'ApiError'
    this.status = status
    this.code = body.code
    this.fields = body.fields ?? {}
    this.sku = body.sku
    this.available = body.available
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Turns any error response body (JSON envelope, HTML from a proxy, nothing) into an ErrorBody. */
export function parseErrorBody(status: number, body: unknown): ErrorBody {
  const err = isRecord(body) ? body.error : undefined
  if (isRecord(err) && typeof err.code === 'string' && typeof err.message === 'string') {
    return {
      code: err.code as ErrorCode,
      message: err.message,
      fields: isRecord(err.fields) ? (err.fields as Record<string, string>) : undefined,
      sku: typeof err.sku === 'string' ? err.sku : undefined,
      available: typeof err.available === 'number' ? err.available : undefined,
    }
  }
  if (status >= 502 && status <= 504) {
    // The dev proxy / nginx answers for a backend that is down or restarting.
    return { code: 'NETWORK', message: 'Cannot reach the server. Check that the backend is running.' }
  }
  return { code: 'INTERNAL', message: `Server responded with HTTP ${status}` }
}

async function request<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, { code: 'NETWORK', message: 'Cannot reach the server. Check that the backend is running.' })
  }
  if (res.status === 204) return undefined as T

  const text = await res.text()
  let json: unknown = undefined
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    // non-JSON body, e.g. a proxy error page
  }
  if (!res.ok) throw new ApiError(res.status, parseErrorBody(res.status, json))
  return json as T
}

function query(params: Record<string, string | number>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== '' && v !== 'all') q.set(k, String(v))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

export const api = {
  listProducts: (p: ProductQuery) => request<Page<Product>>('GET', `/products${query({ ...p })}`),
  createProduct: (input: ProductInput) => request<Product>('POST', '/products', input),
  updateProduct: (id: number, input: ProductUpdate) => request<Product>('PUT', `/products/${id}`, input),
  deleteProduct: (id: number) => request<void>('DELETE', `/products/${id}`),
  adjustStock: (id: number, input: StockAdjustment) => request<Product>('POST', `/products/${id}/stock`, input),
  listMovements: (id: number) => request<{ data: Movement[] }>('GET', `/products/${id}/movements`),
  summary: () => request<Summary>('GET', '/products/summary'),

  listOrders: () => request<{ data: Order[] }>('GET', '/orders'),
  getOrder: (id: number) => request<Order>('GET', `/orders/${id}`),
  createOrder: (input: OrderInput, idempotencyKey: string) =>
    request<Order>('POST', '/orders', input, { 'Idempotency-Key': idempotencyKey }),
  cancelOrder: (id: number) => request<Order>('POST', `/orders/${id}/cancel`),

  dailySales: (date?: string) => request<DailySales>('GET', `/reports/daily-sales${query({ date: date ?? '' })}`),
}

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return 'Something went wrong'
}
