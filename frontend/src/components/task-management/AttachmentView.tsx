import { useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence } from 'framer-motion'
import { Paperclip } from 'lucide-react'
import { cn } from '../../lib/utils'
import { attachmentKindOf } from './attachmentKind'
import DocumentViewerModal from '../DocumentViewerModal'

// ---------------------------------------------------------------------------
// AttachmentView
// ---------------------------------------------------------------------------
// Single responsibility: render ONE attachment in the right form for its kind —
// an inline image thumbnail, a video player, an audio player, or a download
// link. Callers pass
// the already-resolved absolute URL so this component stays decoupled from any
// particular URL-resolution helper (DRY: URL logic lives once per call site).
//
// Images and generic files open in the app's shared DocumentViewerModal rather
// than in a new browser tab, so the user never loses their place. Video and
// audio already play in place and are left alone. The viewer is portalled to
// <body> so it is never clipped or mis-positioned by the modal / scroll
// container the attachment happens to sit in.

export interface AttachmentViewProps {
  fileName: string
  /** Absolute URL to the file, already resolved by the caller. */
  fileUrl: string | null
  className?: string
}

export default function AttachmentView({ fileName, fileUrl, className }: AttachmentViewProps) {
  const kind = attachmentKindOf(fileName)
  const href = fileUrl ?? '#'
  const [isViewerOpen, setIsViewerOpen] = useState(false)
  // The URL the open document was opened with. The fileUrl prop may change while
  // it is open (a refresh renews a signed URL); the document shown keeps this one,
  // so it is never reloaded (page, zoom and scroll stay). The links (new window /
  // download) and the next opening use the current fileUrl.
  const [openedUrl, setOpenedUrl] = useState<string | null>(null)

  // Attachments live inside clickable rows (chat bubbles, task cards), so the
  // click must not bubble up and trigger the surrounding element as well.
  const openViewer = (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setOpenedUrl(fileUrl)
    setIsViewerOpen(true)
  }
  const closeViewer = () => setIsViewerOpen(false)
  const shownUrl = openedUrl ?? fileUrl

  const viewerPortal = fileUrl
    ? createPortal(
        <AnimatePresence>
          {isViewerOpen && shownUrl && (
            <DocumentViewerModal
              isOpen={isViewerOpen}
              document={{ file_path: shownUrl, description: fileName }}
              linkUrl={fileUrl}
              onClose={closeViewer}
            />
          )}
        </AnimatePresence>,
        document.body,
      )
    : null

  if (kind === 'image' && fileUrl) {
    return (
      <>
        <button
          type="button"
          onClick={openViewer}
          title={fileName}
          aria-label={`הצג את ${fileName}`}
          className={cn('inline-block cursor-zoom-in', className)}
        >
          <img
            src={fileUrl}
            alt={fileName}
            className="max-h-32 max-w-[160px] rounded border border-gray-200 dark:border-gray-600 object-cover"
          />
        </button>
        {viewerPortal}
      </>
    )
  }

  if (kind === 'video' && fileUrl) {
    return (
      <video
        controls
        src={fileUrl}
        className={cn('max-h-48 max-w-[280px] rounded border border-gray-200 dark:border-gray-600', className)}
        title={fileName}
      >
        <a href={href} target="_blank" rel="noopener noreferrer">{fileName}</a>
      </video>
    )
  }

  if (kind === 'audio' && fileUrl) {
    return (
      <audio
        controls
        src={fileUrl}
        className={cn('h-9 max-w-[220px]', className)}
        title={fileName}
      >
        <a href={href} target="_blank" rel="noopener noreferrer">{fileName}</a>
      </audio>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={openViewer}
        disabled={!fileUrl}
        title={fileName}
        aria-label={`הצג את ${fileName}`}
        className={cn(
          // Explicit text/background colours (never inherited): this chip is also
          // rendered inside coloured chat bubbles, where an inherited white text
          // colour would make the file name unreadable.
          'inline-flex items-center gap-1 px-2 py-1 rounded-md max-w-[200px] text-xs font-medium',
          'bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100',
          'border border-gray-300 dark:border-gray-600 shadow-sm',
          'hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-60 disabled:cursor-default',
          className,
        )}
      >
        <Paperclip className="w-3 h-3 flex-shrink-0 text-gray-500 dark:text-gray-400" />
        <span className="truncate" dir="auto">{fileName}</span>
      </button>
      {viewerPortal}
    </>
  )
}
