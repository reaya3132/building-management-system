import { useEffect, useRef } from 'react'
import { Check, SkipForward } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { LegalStage } from '../../lib/legalApi'
import { STAGE_STATUS_LABELS } from './legalUtils'

interface Props {
  stages: LegalStage[]
  selected: string | null
  onSelect: (key: string) => void
}

const DOT: Record<LegalStage['status'], string> = {
  completed: 'bg-emerald-600 border-emerald-600 text-white',
  skipped: 'bg-amber-100 border-amber-300 text-amber-700 dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-300',
  pending: 'bg-white border-gray-300 text-gray-500 dark:bg-gray-800 dark:border-gray-600 dark:text-gray-400',
}

/**
 * Compact horizontal navigator over the fixed stages (same idea as the
 * collection MonthStrip). On narrow screens only the numbers are shown, with the
 * selected stage's full name and status under them.
 */
export default function LegalStageStepper({ stages, selected, onSelect }: Props) {
  const selectedRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { selectedRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'center' }) }, [selected])
  const current = stages.find((s) => s.key === selected)

  return (
    <nav aria-label="שלבי ההליך" className="rounded-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-sm px-3 py-2.5">
      <ol className="flex items-center gap-1 overflow-x-auto">
        {stages.map((stage, index) => {
          const isSelected = stage.key === selected
          return (
            <li key={stage.key} className="flex items-center flex-1 min-w-0 last:flex-none sm:last:flex-1">
              <button
                ref={isSelected ? selectedRef : undefined}
                type="button"
                onClick={() => onSelect(stage.key)}
                aria-current={isSelected ? 'step' : undefined}
                aria-label={`שלב ${stage.position}: ${stage.label}, ${STAGE_STATUS_LABELS[stage.status]}`}
                className={cn('group flex items-center gap-2 rounded-xl px-2 py-1.5 text-right transition-colors min-w-0',
                  isSelected ? 'bg-primary/10' : 'hover:bg-gray-100 dark:hover:bg-gray-700')}
              >
                <span className={cn('flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums',
                  DOT[stage.status], isSelected && 'ring-2 ring-primary ring-offset-1 dark:ring-offset-gray-800')}>
                  {stage.status === 'completed' ? <Check className="w-3.5 h-3.5" /> : stage.status === 'skipped' ? <SkipForward className="w-3.5 h-3.5" /> : stage.position}
                </span>
                <span className="hidden sm:block min-w-0">
                  <span className={cn('block truncate text-sm', isSelected ? 'font-semibold text-gray-900 dark:text-white' : 'text-gray-700 dark:text-gray-300')}>{stage.label}</span>
                  <span className="block text-[11px] text-gray-500 dark:text-gray-400">{STAGE_STATUS_LABELS[stage.status]}</span>
                </span>
              </button>
              {index < stages.length - 1 && <span aria-hidden className="mx-1 h-px flex-1 min-w-3 bg-gray-200 dark:bg-gray-700" />}
            </li>
          )
        })}
      </ol>
      {current && (
        <p className="sm:hidden mt-1.5 text-sm text-gray-900 dark:text-white">
          <span className="font-semibold">שלב {current.position}: {current.label}</span>
          <span className="mr-2 text-xs text-gray-500 dark:text-gray-400">{STAGE_STATUS_LABELS[current.status]}</span>
        </p>
      )}
    </nav>
  )
}
