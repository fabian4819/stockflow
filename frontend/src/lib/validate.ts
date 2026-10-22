// Client-side validation mirrors the server rules so most mistakes are caught
// before a request. The server stays the source of truth: its 400 field
// errors are mapped back onto the same shapes with fieldsToOrderErrors.

export const MAX_QTY = 1_000_000

/** Parses a strictly positive integer from user input ("3" ok; "3.5", "-1", "1e3", "" not). */
export function parsePositiveInt(raw: string): number | null {
  const s = raw.trim()
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return n > 0 && n <= MAX_QTY ? n : null
}

export function qtyError(raw: string): string | undefined {
  if (raw.trim() === '') return 'Quantity is required'
  return parsePositiveInt(raw) === null ? `Quantity must be a whole number from 1 to ${MAX_QTY}` : undefined
}

export interface ProductFormValues {
  sku: string
  name: string
  price: string
}

export type ProductFormErrors = Partial<Record<keyof ProductFormValues, string>>

export function validateProductForm(v: ProductFormValues, withSku: boolean): ProductFormErrors {
  const errors: ProductFormErrors = {}
  if (withSku && v.sku.trim() === '') errors.sku = 'SKU is required'
  if (v.name.trim() === '') errors.name = 'Name is required'
  if (!/^\d+$/.test(v.price.trim())) errors.price = 'Price must be a whole number of rupiah, 0 or more'
  return errors
}

export interface OrderLine {
  sku: string
  qty: string
}

export interface LineErrors {
  sku?: string
  qty?: string
}

export interface OrderFormErrors {
  customer?: string
  items?: string
  lines: Record<number, LineErrors>
}

export function hasOrderErrors(e: OrderFormErrors): boolean {
  return Boolean(e.customer || e.items || Object.keys(e.lines).length > 0)
}

export function validateOrderForm(customer: string, lines: OrderLine[]): OrderFormErrors {
  const errors: OrderFormErrors = { lines: {} }
  if (customer.trim() === '') errors.customer = 'Customer name is required'
  if (lines.length === 0) errors.items = 'Add at least one item'

  const seen = new Map<string, number>()
  lines.forEach((line, i) => {
    const lineErrors: LineErrors = {}
    const sku = line.sku.trim()
    const first = seen.get(sku)
    if (sku === '') {
      lineErrors.sku = 'Pick a SKU'
    } else if (first !== undefined) {
      lineErrors.sku = `Duplicate of item ${first + 1}`
    } else {
      seen.set(sku, i)
    }
    const q = qtyError(line.qty)
    if (q) lineErrors.qty = q
    if (lineErrors.sku || lineErrors.qty) errors.lines[i] = lineErrors
  })
  return errors
}

/** Maps server field keys like "items[2].qty" onto the form's error shape. */
export function fieldsToOrderErrors(fields: Record<string, string>): OrderFormErrors {
  const errors: OrderFormErrors = { lines: {} }
  for (const [key, message] of Object.entries(fields)) {
    const m = /^items\[(\d+)\]\.(sku|qty)$/.exec(key)
    if (m) {
      const i = Number(m[1])
      errors.lines[i] = { ...errors.lines[i], [m[2]]: message }
    } else if (key === 'customer') {
      errors.customer = message
    } else {
      errors.items = errors.items ? `${errors.items}; ${message}` : message
    }
  }
  return errors
}
