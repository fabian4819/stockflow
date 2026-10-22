import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, parseErrorBody } from './client'

describe('parseErrorBody', () => {
  it('reads the insufficient stock envelope', () => {
    const body = { error: { code: 'INSUFFICIENT_STOCK', message: 'no', sku: 'BRG-005', available: 8 } }
    expect(parseErrorBody(409, body)).toEqual({
      code: 'INSUFFICIENT_STOCK',
      message: 'no',
      sku: 'BRG-005',
      available: 8,
      fields: undefined,
    })
  })

  it('keeps available = 0', () => {
    const body = { error: { code: 'INSUFFICIENT_STOCK', message: 'no', sku: 'X', available: 0 } }
    expect(parseErrorBody(409, body).available).toBe(0)
  })

  it('falls back for non-envelope bodies', () => {
    expect(parseErrorBody(502, undefined)).toEqual({ code: 'INTERNAL', message: 'Server responded with HTTP 502' })
    expect(parseErrorBody(500, { message: 'x' }).code).toBe('INTERNAL')
  })
})

describe('request', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('throws ApiError with the parsed envelope on 409', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: { code: 'INSUFFICIENT_STOCK', message: 'm', sku: 'A', available: 2 } }), {
        status: 409,
      }),
    )
    const err = await api.adjustStock(1, { type: 'out', qty: 5, note: '' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK', sku: 'A', available: 2 })
  })

  it('turns a network failure into a NETWORK ApiError', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(api.summary()).rejects.toMatchObject({ code: 'NETWORK', status: 0 })
  })

  it('builds list URLs and omits defaults', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ data: [], page: 1, limit: 20, total: 0 }), { status: 200 })
    })
    await api.listProducts({ search: 'kopi', filter: 'all', page: 2, limit: 20 })
    expect(calls[0]).toBe('/api/products?search=kopi&page=2&limit=20')
  })
})
