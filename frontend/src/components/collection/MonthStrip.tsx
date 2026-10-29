import { useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'
import { shortMonthName } from './collectionUtils'

interface MonthStripProps {
  /** Selected month, YYYY-MM. */
  month: string
  /** Not-closed task count per YYYY-MM of the shown year; undefined while loading. */
  counts: Record<string, number> | undefined
  onSelect: (month: string) => void
}

/**
 * Compact navigator over the 12 months of the selected month's year, each with
 * its not-closed task count. Purely presentational: the page owns the month
 * (kept in the URL) and the counts. Scrolls horizontally on small screens,
 * keeping the selected month in view.
 */
export default function MonthStrip({ month, counts, onSelect }: MonthStripProps) {
  const year = Number(month.slice(0, 4))
  const selectedRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'center' })
  }, [month])

  const key = (m: number) => `${year}-${String(m).padStart(2, '0')}`

  return (
    <nav aria-label="חודשי השנה" className="flex items-center gap-1 rounded-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-1 shadow-sm">
      <button
        type="button"
        onClick={() => onSelect(`${year - 1}-${month.slice(5, 7)}`)}
        className="p-2 rounded-xl text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 flex-shrink-0"
        aria-label="השנה הקודמת"
      >
        <ChevronRight className="w-4 h-4" />
      </button>
      <span className="px-1 text-sm font-bold text-gray-900 dark:text-white tabular-nums flex-shrink-0">{year}</span>
      <div className="flex-1 min-w-0 flex gap-1 overflow-x-auto scrollbar-thin">
        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
          const value = key(m)
          const selected = value === month
          const count = counts?.[value] ?? 0
          return (
            <button
              key={value}
              ref={selected ? selectedRef : undefined}
              type="button"
              onClick={() => onSelect(value)}
              aria-current={selected ? 'date' : undefined}
              aria-label={`${shortMonthName(m)} ${year}: ${count} פתוחות`}
              className={cn(
                'flex-1 min-w-[3.75rem] inline-flex items-center justify-center gap-1 rounded-xl px-2 py-1.5 text-sm whitespace-nowrap transition-colors',
                selected
                  ? 'bg-blue-600 text-white font-semibold shadow-sm'
                  : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
              )}
            >
              {shortMonthName(m)}
              {count > 0 && (
                <span
                  className={cn(
                    'min-w-[1.25rem] h-5 px-1 inline-flex items-center justify-center rounded-full text-[11px] font-bold tabular-nums',
                    selected ? 'bg-white/25 text-white' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>
      <button
        type="button"
        onClick={() => onSelect(`${year + 1}-${month.slice(5, 7)}`)}
        className="p-2 rounded-xl text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 flex-shrink-0"
        aria-label="השנה הבאה"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
    </nav>
  )
}
