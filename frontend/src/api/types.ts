// Wire types for the StockFlow API. Every component imports domain types from
// here; nothing else describes the server's JSON.

export interface Product {
  id: number
  sku: string
  name: string
  price: number // IDR, integer
  stock: number
  is_active: boolean
  created_at: string
  last_movement_at: string | null
}

export type ProductFilter = 'all' | 'active' | 'inactive' | 'low'

export interface ProductQuery {
  search: string
  filter: ProductFilter
  page: number
  limit: number
}

export interface Page<T> {
  data: T[]
  page: number
  limit: number
  total: number
}

export interface ProductInput {
  sku: string
  name: string
  price: number
  is_active: boolean
}

export type ProductUpdate = Omit<ProductInput, 'sku'>

export type MovementType = 'in' | 'out'

export interface StockAdjustment {
  type: MovementType
  qty: number
  note: string
}

export interface Movement {
  id: number
  product_id: number
  type: MovementType
  qty: number
  note: string | null
  created_at: string
}

export interface Summary {
  total_products: number
  active_products: number
  total_stock_value: number
  low_stock_count: number
}

export type OrderStatus = 'CREATED' | 'CANCELLED'

export interface OrderItem {
  sku: string
  name: string
  qty: number
  unit_price: number
  subtotal: number
}

export interface Order {
  id: number
  customer: string
  status: OrderStatus
  total: number
  created_at: string
  cancelled_at: string | null
  items?: OrderItem[] // omitted in list responses
}

export interface OrderInput {
  customer: string
  items: { sku: string; qty: number }[]
}

export interface DailySales {
  date: string
  orders: number
  units: number
  revenue: number
}

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'SKU_EXISTS'
  | 'PRODUCT_HAS_HISTORY'
  | 'INSUFFICIENT_STOCK'
  | 'ORDER_ALREADY_CANCELLED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INTERNAL'
  | 'NETWORK'

/** The body of every non-2xx response: {"error": ErrorBody}. */
export interface ErrorBody {
  code: ErrorCode
  message: string
  fields?: Record<string, string>
  sku?: string
  available?: number
}
