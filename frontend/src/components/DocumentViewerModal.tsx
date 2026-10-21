import { motion } from 'framer-motion'
import { useState, useEffect, useRef } from 'react'
import api from '../lib/api'

export interface DocumentToView {
  id?: number
  file_path: string
  description?: string | null
  uploaded_at?: string | null
}

interface DocumentViewerModalProps {
  isOpen: boolean
  document: DocumentToView | null
  onClose: () => void
}

function getFileExtension(filePath: string): string {
  const pathWithoutQuery = filePath.split('?')[0]
  return pathWithoutQuery.split('.').pop()?.toLowerCase() || ''
}
function getFileName(filePath: string): string {
  const parts = filePath.split('/')
  return parts[parts.length - 1] || 'קובץ'
}
function getFileUrl(filePath: string): string {
  if (filePath.startsWith('http')) return filePath
  const apiUrl = import.meta.env.VITE_API_URL || ''
  const baseUrl = apiUrl ? apiUrl.replace('/api/v1', '') : ''
  const normalizedPath = filePath.startsWith('/') ? filePath : `/${filePath}`.replace(/([^:]\/)\/+/g, '$1')
  return `${baseUrl}${normalizedPath}`
}
function isImage(filePath: string): boolean {
  const ext = getFileExtension(filePath)
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)
}
function isPdf(filePath: string): boolean {
  return getFileExtension(filePath) === 'pdf'
}

export default function DocumentViewerModal({ isOpen, document: doc, onClose }: DocumentViewerModalProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const blobUrlRef = useRef<string | null>(null)

  // When document has id (e.g. unforeseen transaction doc), fetch via API so auth is sent; then display via blob URL
  useEffect(() => {
    if (!isOpen || !doc) {
      setBlobUrl(null)
      setError(null)
      return
    }
    if (!doc.id) {
      setBlobUrl(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .get(`/unforeseen-transactions/documents/${doc.id}/view`, { responseType: 'blob' })
      .then((res) => {
        if (cancelled) return
        const url = URL.createObjectURL(res.data as Blob)
        blobUrlRef.current = url
        setBlobUrl(url)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err.response?.data?.detail || 'שגיאה בטעינת המסמך')
        setLoading(false)
      })
    return () => {
      cancelled = true
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
      setBlobUrl(null)
    }
  }, [isOpen, doc?.id, doc?.file_path])

  // Escape closes the viewer, so a document opened from a chat or a task card
  // can be dismissed without reaching for the mouse.
  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose])

  if (!isOpen || !doc) return null

  const useViewEndpoint = Boolean(doc.id)
  const fileUrl = useViewEndpoint && blobUrl ? blobUrl : getFileUrl(doc.file_path)
  const isLoading = useViewEndpoint && loading
  const hasError = useViewEndpoint && error

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[60] p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className="bg-white dark:bg-gray-800 rounded-2xl max-w-7xl max-h-[95vh] w-full overflow-hidden shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 shrink-0">
          <h3 className="text-lg font-bold text-gray-900 dark:text-white truncate flex-1 min-w-0">
            {doc.description || getFileName(doc.file_path)}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="ml-4 p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-colors shrink-0"
            aria-label="סגור"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 min-h-0 p-4 overflow-auto">
          {isLoading ? (
            <div className="flex items-center justify-center min-h-[400px]">
              <p className="text-gray-600 dark:text-gray-400">טוען מסמך...</p>
            </div>
          ) : hasError ? (
            <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
              <p className="text-red-600 dark:text-red-400">{error}</p>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600"
              >
                סגור
              </button>
            </div>
          ) : isImage(doc.file_path) ? (
            <div className="flex items-center justify-center bg-gray-50 dark:bg-gray-900 rounded-lg p-4 min-h-[400px]">
              <img
                src={fileUrl}
                alt={doc.description || getFileName(doc.file_path)}
                className="max-w-full max-h-[75vh] h-auto mx-auto rounded-lg shadow-xl object-contain"
              />
            </div>
          ) : isPdf(doc.file_path) ? (
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg overflow-hidden flex flex-col h-[80vh]">
              <div className="flex-1 relative min-h-0">
                <iframe
                  src={`${fileUrl}#toolbar=1&navpanes=1&scrollbar=1`}
                  className="w-full h-full border-0 min-h-[400px]"
                  title={doc.description || getFileName(doc.file_path)}
                />
                <div className="absolute top-4 right-4 flex gap-2">
                  <a
                    href={fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium flex items-center gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span>🔗</span>
                    פתח בחלון חדש
                  </a>
                  <a
                    href={fileUrl}
                    download
                    className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium flex items-center gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span>📥</span>
                    הורד
                  </a>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-16">
              <p className="text-gray-600 dark:text-gray-400 text-lg mb-4">
                לא ניתן להציג את הקובץ ישירות (סוג: {getFileExtension(doc.file_path).toUpperCase() || 'לא ידוע'})
              </p>
              <a
                href={fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
              >
                <span>📥</span>
                פתח / הורד קובץ
              </a>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
