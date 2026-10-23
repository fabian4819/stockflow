import { describe, expect, it } from 'vitest'
import { parseRoute, routePath, type Route } from './useRoute'

describe('parseRoute', () => {
  it.each<[string, Route]>([
    ['/', { page: 'products' }],
    ['/orders', { page: 'new-order' }],
    ['/orders/', { page: 'new-order' }],
    ['/orders/new', { page: 'new-order' }],
    ['/orders/12', { page: 'order', id: 12 }],
    ['/orders/12/', { page: 'order', id: 12 }],
  ])('%s', (path, want) => expect(parseRoute(path)).toEqual(want))

  it.each(['/orders/0', '/orders/abc', '/orders/12/items', '/unknown'])('falls back to products for %s', (path) => {
    expect(parseRoute(path)).toEqual({ page: 'products' })
  })
})

describe('routePath', () => {
  it('round-trips every route', () => {
    const routes: Route[] = [{ page: 'products' }, { page: 'new-order' }, { page: 'order', id: 7 }]
    for (const r of routes) expect(parseRoute(routePath(r))).toEqual(r)
  })
})
