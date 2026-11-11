import React from 'react'
import { X } from 'lucide-react'
import ModalOverlay from '../ui/ModalOverlay'

interface LegalModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  subtitle?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  maxWidth?: string
}

/** Header / scrollable body / footer chrome of the module's dialogs, on the shared overlay. */
export default function LegalModal({ isOpen, onClose, title, subtitle, children, footer, maxWidth = 'max-w-lg' }: LegalModalProps) {
  return (
    <ModalOverlay isOpen={isOpen} onClose={onClose} maxWidth={maxWidth}>
      <div dir="rtl" className="flex flex-col max-h-[90vh]">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white truncate">{title}</h2>
            {subtitle && <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="סגירת החלון"
            className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 dark:hover:text-gray-200">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">{footer}</div>}
      </div>
    </ModalOverlay>
  )
}

export const BUTTON_PRIMARY =
  'inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed'
export const BUTTON_SECONDARY =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3.5 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50'
