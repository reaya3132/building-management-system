import React from 'react'
import { X } from 'lucide-react'
import ModalOverlay from '../ui/ModalOverlay'

interface CollectionModalProps {
  isOpen: boolean
  onClose: () => void
  icon: React.ComponentType<{ className?: string }>
  title: string
  subtitle?: React.ReactNode
  children: React.ReactNode
  /** Sticky footer (usually cancel + submit). */
  footer?: React.ReactNode
  maxWidth?: string
}

/**
 * Header / scrollable body / footer chrome for the collection module's
 * dialogs, built on the shared {@link ModalOverlay}. The body scrolls inside
 * the viewport so long forms stay usable on small screens.
 */
export default function CollectionModal({
  isOpen,
  onClose,
  icon: Icon,
  title,
  subtitle,
  children,
  footer,
  maxWidth = 'max-w-lg',
}: CollectionModalProps) {
  return (
    <ModalOverlay isOpen={isOpen} onClose={onClose} maxWidth={maxWidth}>
      <div dir="rtl" className="flex flex-col max-h-[90vh]">
        <div className="flex items-start gap-3 px-4 sm:px-6 pt-5 pb-4 border-b border-gray-100 dark:border-gray-700">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-md shadow-emerald-500/20">
            <Icon className="w-6 h-6" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white truncate">{title}</h2>
            {subtitle && <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-gray-500 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors flex-shrink-0"
            aria-label="סגירה"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-4 sm:px-6 py-5 flex flex-col gap-4 overflow-y-auto">{children}</div>

        {footer && (
          <div className="px-4 sm:px-6 py-4 flex flex-wrap gap-2.5 border-t border-gray-100 dark:border-gray-700">{footer}</div>
        )}
      </div>
    </ModalOverlay>
  )
}

/** A bold label above its control. */
export function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1.5">
        {label}
        {required && <span className="text-red-500 mr-0.5">*</span>}
      </span>
      {children}
    </label>
  )
}

export function PrimaryButton({
  onClick,
  disabled,
  children,
  type = 'button',
}: {
  onClick?: () => void
  disabled?: boolean
  children: React.ReactNode
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 rounded-xl px-5 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  )
}

export function SecondaryButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center gap-1.5 rounded-xl px-5 py-2.5 text-sm font-semibold text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-60 transition-colors"
    >
      {children}
    </button>
  )
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div role="alert" className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
      {message}
    </div>
  )
}
