import React from 'react'
import { X } from 'lucide-react'
import ModalOverlay from '../ui/ModalOverlay'
import { cn } from '../../lib/utils'
import { agorotToAmount, formatILS, parseMoneyInput, vatBreakdown } from './collectionUtils'

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
  /** When false, clicking outside the dialog does not close it. Defaults to true. */
  closeOnBackdropClick?: boolean
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
  closeOnBackdropClick = true,
}: CollectionModalProps) {
  return (
    <ModalOverlay isOpen={isOpen} onClose={onClose} maxWidth={maxWidth} closeOnBackdropClick={closeOnBackdropClick}>
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

/**
 * "Includes VAT?" choice of one amount. `value` null = no choice yet (an amount
 * saved before VAT support, which must be chosen explicitly before its amount changes).
 */
export function VatChoice({
  value,
  onChange,
  disabled,
  label = 'מע״מ',
}: {
  value: boolean | null
  onChange: (included: boolean) => void
  disabled?: boolean
  label?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-xl border border-gray-300 dark:border-gray-600 p-0.5">
      {([[true, 'כולל מע״מ'], [false, 'ללא מע״מ']] as const).map(([included, text]) => (
        <button
          key={text}
          type="button"
          role="radio"
          aria-checked={value === included}
          disabled={disabled}
          onClick={() => onChange(included)}
          className={cn(
            'px-2.5 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap disabled:opacity-60',
            value === included
              ? 'bg-emerald-600 text-white'
              : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
          )}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

/** The "כולל מע״מ" marker shown beside an amount to pay whose VAT is known. */
export function VatIncludedTag() {
  return <span className="text-xs font-normal text-gray-500 dark:text-gray-400 whitespace-nowrap">כולל מע״מ</span>
}

/**
 * An amount to pay (VAT included), with the "כולל מע״מ" marker when its VAT is
 * known. An amount saved before VAT support (`vatKnown` false) shows no marker.
 * The amount is isolated (<bdi dir="ltr">) so RTL text never reorders it.
 * The marker sits below the amount; `inline` keeps it beside it (inside a sentence).
 */
export function AmountWithVat({ amount, vatKnown, className, inline = false }: { amount: string | null | undefined; vatKnown: boolean; className?: string; inline?: boolean }) {
  return (
    <span className={cn('whitespace-nowrap', inline ? 'inline-flex items-baseline gap-1.5' : 'inline-flex flex-col items-end leading-tight')}>
      <bdi dir="ltr" className={cn('tabular-nums', className)}>{formatILS(amount)}</bdi>
      {vatKnown && <VatIncludedTag />}
    </span>
  )
}

/**
 * Preview of a typed amount's amount to pay (before it is saved; the server
 * computes the saved one). Shows nothing until the amount, the choice and the rate are valid.
 */
export function VatPreviewText({ amount, vatIncluded, rate }: { amount: string; vatIncluded: boolean | null; rate: string | null }) {
  const value = parseMoneyInput(amount)
  const preview = value ? vatBreakdown(value, vatIncluded, rate) : null
  if (!preview || preview.vatAgorot === null) return null
  return (
    <p className="text-xs text-gray-500 dark:text-gray-400">
      לתשלום: <AmountWithVat amount={agorotToAmount(preview.grossAgorot)} vatKnown inline className="font-semibold text-gray-700 dark:text-gray-200" />
    </p>
  )
}
