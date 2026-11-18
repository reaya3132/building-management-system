/**
 * Keep a file's URL stable across background refreshes.
 *
 * Files stored in S3 come back with a freshly signed URL on every response — the
 * same file, a different string (new date and signature). A chat that refreshes
 * every few seconds would hand an open document viewer a new `src` each time and
 * reload it (a PDF jumps back to page 1). So, for a file already shown (same id),
 * the URL already in hand is kept — as long as it stays valid long enough. Near
 * its expiry the new URL is taken (once), so a document never stays on a dead link.
 */

/** Keep the current URL only while more than this is left before it expires. */
export const URL_RENEW_MARGIN_MS = 5 * 60 * 1000

/**
 * When a signed URL expires (ms since epoch), read from the URL itself:
 * SigV4 (`X-Amz-Date` + `X-Amz-Expires`) or SigV2 (`Expires`, seconds).
 * `null`: not a signed URL (a local /uploads path never expires).
 */
export function signedUrlExpiresAt(url: string | null | undefined): number | null {
  if (!url) return null
  let params: URLSearchParams
  try {
    params = new URL(url, 'http://local').searchParams
  } catch {
    return null
  }
  const amzDate = params.get('X-Amz-Date')
  const amzExpires = params.get('X-Amz-Expires')
  if (amzDate && amzExpires) {
    const m = amzDate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
    if (!m) return null
    const signedAt = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
    return signedAt + Number(amzExpires) * 1000
  }
  const expires = params.get('Expires')
  if (expires && /^\d+$/.test(expires)) return Number(expires) * 1000
  return null
}

/** Whether a URL in hand is still good enough to keep (not near its expiry). */
export function isUrlFresh(url: string, now: number = Date.now()): boolean {
  const expiresAt = signedUrlExpiresAt(url)
  return expiresAt == null || expiresAt - now > URL_RENEW_MARGIN_MS
}

interface WithAttachments {
  attachments?: { id: number; file_url: string }[] | null
}

/**
 * The refreshed list `next`, with each attachment already in `prev` (same id)
 * keeping its current `file_url` while that is still fresh. New attachments, and
 * those whose URL is near expiry, take the URL the server just sent.
 */
export function keepFileUrls<T extends WithAttachments>(prev: T[], next: T[], now: number = Date.now()): T[] {
  const known = new Map<number, string>()
  for (const item of prev) {
    for (const att of item.attachments ?? []) known.set(att.id, att.file_url)
  }
  if (known.size === 0) return next
  return next.map((item) => {
    if (!item.attachments?.length) return item
    let changed = false
    const attachments = item.attachments.map((att) => {
      const current = known.get(att.id)
      if (current && current !== att.file_url && isUrlFresh(current, now)) {
        changed = true
        return { ...att, file_url: current }
      }
      return att
    })
    return changed ? { ...item, attachments } : item
  })
}
