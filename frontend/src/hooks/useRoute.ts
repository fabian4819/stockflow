import { useCallback, useEffect, useState } from 'react'

// Three screens don't justify a router dependency: the History API plus a
// popstate listener covers linking, refresh and back/forward. nginx and the
// Vite dev server both fall back to index.html for unknown paths.

export type Route = { page: 'products' } | { page: 'new-order' } | { page: 'order'; id: number }

export function parseRoute(path: string): Route {
  const order = /^\/orders\/(\d+)\/?$/.exec(path)
  if (order && Number(order[1]) > 0) return { page: 'order', id: Number(order[1]) }
  if (/^\/orders(\/new)?\/?$/.test(path)) return { page: 'new-order' }
  return { page: 'products' }
}

export function routePath(route: Route): string {
  switch (route.page) {
    case 'products':
      return '/'
    case 'new-order':
      return '/orders/new'
    case 'order':
      return `/orders/${route.id}`
  }
}

export function useRoute() {
  const [path, setPath] = useState(() => window.location.pathname)

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = useCallback((route: Route) => {
    const next = routePath(route)
    if (next !== window.location.pathname) window.history.pushState(null, '', next)
    setPath(next)
  }, [])

  return { route: parseRoute(path), navigate }
}
