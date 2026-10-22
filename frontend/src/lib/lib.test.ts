import { describe, expect, it } from 'vitest'
import { formatRupiah, isLowStock, timeAgo } from './format'
import {
  fieldsToOrderErrors,
  hasOrderErrors,
  parsePositiveInt,
  qtyError,
  validateOrderForm,
  validateProductForm,
} from './validate'

describe('formatRupiah', () => {
  it('uses dot thousand separators', () => {
    expect(formatRupiah(1234567)).toBe('Rp 1.234.567')
    expect(formatRupiah(0)).toBe('Rp 0')
    expect(formatRupiah(500)).toBe('Rp 500')
  })
})

describe('timeAgo', () => {
  const now = new Date('2026-10-23T12:00:00Z')
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()

  it('handles null', () => expect(timeAgo(null, now)).toBe('Never'))
  it('formats each unit', () => {
    expect(timeAgo(ago(10_000), now)).toBe('just now')
    expect(timeAgo(ago(5 * 60_000), now)).toBe('5m ago')
    expect(timeAgo(ago(2 * 3_600_000 + 59 * 60_000), now)).toBe('2h ago')
    expect(timeAgo(ago(3 * 86_400_000), now)).toBe('3d ago')
  })
  it('never shows negative time for clock skew', () => {
    expect(timeAgo(new Date(now.getTime() + 5_000).toISOString(), now)).toBe('just now')
  })
})

describe('isLowStock', () => {
  it('treats 10 or less as low', () => {
    expect(isLowStock(10)).toBe(true)
    expect(isLowStock(0)).toBe(true)
    expect(isLowStock(11)).toBe(false)
  })
})

describe('parsePositiveInt / qtyError', () => {
  it.each([
    ['1', 1],
    [' 42 ', 42],
    ['1000000', 1000000],
  ])('accepts %j', (raw, want) => expect(parsePositiveInt(raw)).toBe(want))

  it.each(['', '0', '-1', '1.5', '1e3', 'abc', '1000001'])('rejects %j', (raw) => {
    expect(parsePositiveInt(raw)).toBeNull()
    expect(qtyError(raw)).toBeDefined()
  })
})

describe('validateProductForm', () => {
  it('requires sku only on create', () => {
    expect(validateProductForm({ sku: '', name: 'A', price: '1' }, true).sku).toBeDefined()
    expect(validateProductForm({ sku: '', name: 'A', price: '1' }, false).sku).toBeUndefined()
  })
  it('rejects non-integer and negative price, accepts 0', () => {
    expect(validateProductForm({ sku: 'A', name: 'A', price: '1.5' }, true).price).toBeDefined()
    expect(validateProductForm({ sku: 'A', name: 'A', price: '-1' }, true).price).toBeDefined()
    expect(validateProductForm({ sku: 'A', name: 'A', price: '0' }, true)).toEqual({})
  })
})

describe('validateOrderForm', () => {
  it('passes a valid order', () => {
    const e = validateOrderForm('Toko A', [
      { sku: 'BRG-001', qty: '2' },
      { sku: 'BRG-002', qty: '1' },
    ])
    expect(hasOrderErrors(e)).toBe(false)
  })

  it('flags customer, empty items, bad qty and duplicates on the right line', () => {
    expect(validateOrderForm(' ', []).customer).toBeDefined()
    expect(validateOrderForm('A', []).items).toBeDefined()

    const e = validateOrderForm('A', [
      { sku: 'BRG-001', qty: '0' },
      { sku: '', qty: '1' },
      { sku: ' BRG-001 ', qty: '3' },
    ])
    expect(e.lines[0]).toEqual({ qty: expect.any(String) })
    expect(e.lines[1]).toEqual({ sku: 'Pick a SKU' })
    expect(e.lines[2]).toEqual({ sku: 'Duplicate of item 1' })
  })
})

describe('fieldsToOrderErrors', () => {
  it('maps server field keys to lines', () => {
    const e = fieldsToOrderErrors({
      customer: 'customer is required',
      'items[0].qty': 'qty must be greater than 0',
      'items[2].sku': 'unknown sku X',
      items: 'order total too large',
    })
    expect(e.customer).toBe('customer is required')
    expect(e.lines[0].qty).toBe('qty must be greater than 0')
    expect(e.lines[2].sku).toBe('unknown sku X')
    expect(e.items).toBe('order total too large')
  })
})
