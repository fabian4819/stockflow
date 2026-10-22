const idr = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 })

/** 1234567 -> "Rp 1.234.567" */
export function formatRupiah(amount: number): string {
  return `Rp ${idr.format(amount)}`
}

/** Relative time like "2h ago". Older than 30 days falls back to a date. */
export function timeAgo(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'Never'
  const then = new Date(iso)
  const seconds = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return then.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
}

export const LOW_STOCK_THRESHOLD = 10

export function isLowStock(stock: number): boolean {
  return stock <= LOW_STOCK_THRESHOLD
}
