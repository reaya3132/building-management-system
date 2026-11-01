import { useRef, useState, useEffect, type ReactNode } from 'react'
import { FileText } from 'lucide-react'
import { UnforeseenTransaction } from '../../../types/api'

interface FundAndUnforeseenPanelProps {
  fundData: any
  fundLoading: boolean
  unforeseenTransactions: UnforeseenTransaction[]
  unforeseenTransactionsLoading: boolean
  onShowFundTransactionsModal: () => void
  onShowEditFundModal: () => void
  onShowUnforeseenTransactionsModal: () => void
  onShowCreateUnforeseenTransactionModal: () => void
  onResetUnforeseenForm: () => void
  onViewUnforeseenTransaction?: (tx: UnforeseenTransaction) => void
  onShowDeleteFundModal?: () => void
  /** Rendered directly below the fund card (e.g. the fund documentation board). */
  fundNotes?: ReactNode
}

export default function FundAndUnforeseenPanel({
  fundData,
  fundLoading,
  unforeseenTransactions,
  unforeseenTransactionsLoading,
  onShowFundTransactionsModal,
  onShowEditFundModal,
  onShowUnforeseenTransactionsModal,
  onShowCreateUnforeseenTransactionModal,
  onResetUnforeseenForm,
  onViewUnforeseenTransaction,
  onShowDeleteFundModal,
  fundNotes
}: FundAndUnforeseenPanelProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [needsScrolling, setNeedsScrolling] = useState(false)
  const [isAtTop, setIsAtTop] = useState(true)
  const [isAtBottom, setIsAtBottom] = useState(false)

  useEffect(() => {
    const checkScrolling = () => {
      if (scrollContainerRef.current) {
        const container = scrollContainerRef.current
        setNeedsScrolling(container.scrollHeight > container.clientHeight)
        const { scrollTop, scrollHeight, clientHeight } = container
        setIsAtTop(scrollTop <= 1)
        setIsAtBottom(scrollTop + clientHeight >= scrollHeight - 1)
      }
    }
    checkScrolling()
    const t = setTimeout(checkScrolling, 100)
    window.addEventListener('resize', checkScrolling)
    return () => {
      clearTimeout(t)
      window.removeEventListener('resize', checkScrolling)
    }
  }, [unforeseenTransactions, unforeseenTransactionsLoading])

  return (
    <div className="fund-unforeseen-panel flex flex-col gap-3 h-full min-w-0">
      {/* Fund Card */}
      <div className="fund-panel-card project-detail-card bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-3 flex-shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h3 className="fund-panel-title text-fluid-sm font-bold text-gray-900 dark:text-white whitespace-nowrap">פרטי הקופה</h3>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {fundData?.transactions?.length > 0 && (
              <button
                onClick={onShowFundTransactionsModal}
                className="fund-panel-button px-2.5 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-fluid-sm flex items-center gap-1 whitespace-nowrap"
              >
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                ({fundData.transactions.length})
              </button>
            )}
            {fundData && (
              <button
                onClick={onShowEditFundModal}
                className="fund-panel-button px-2.5 py-1.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-fluid-sm whitespace-nowrap"
              >
                ערוך
              </button>
            )}
            {fundData && onShowDeleteFundModal && (
              <button
                onClick={onShowDeleteFundModal}
                className="fund-panel-button px-2.5 py-1.5 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-fluid-sm whitespace-nowrap"
              >
                מחק
              </button>
            )}
          </div>
        </div>
        {fundLoading ? (
          <div className="fund-panel-loading text-center py-2 text-gray-500 dark:text-gray-400 text-fluid-sm">טוען...</div>
        ) : fundData ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="fund-panel-grid-item bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-2.5 min-w-0">
              <p className="text-fluid-sm font-medium text-blue-700 dark:text-blue-300 mb-0.5 whitespace-nowrap">יתרה נוכחית</p>
              <p className="text-fluid-lg font-bold text-blue-900 dark:text-blue-100 overflow-hidden text-ellipsis">{fundData.current_balance.toLocaleString('he-IL')} ₪</p>
            </div>
            <div className="fund-panel-grid-item bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-2.5 min-w-0">
              <p className="text-fluid-sm font-medium text-green-700 dark:text-green-300 mb-0.5 whitespace-nowrap">כמה נכנס</p>
              <p className="text-fluid-lg font-bold text-green-900 dark:text-green-100 overflow-hidden text-ellipsis">{fundData.initial_total.toLocaleString('he-IL')} ₪</p>
            </div>
            <div className="fund-panel-grid-item bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-2.5 min-w-0">
              <p className="text-fluid-sm font-medium text-red-700 dark:text-red-300 mb-0.5 whitespace-nowrap">כמה יצא</p>
              <p className="text-fluid-lg font-bold text-red-900 dark:text-red-100 overflow-hidden text-ellipsis">{fundData.total_deductions.toLocaleString('he-IL')} ₪</p>
            </div>
            <div className="fund-panel-grid-item bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg p-2.5 min-w-0">
              <p className="text-fluid-sm font-medium text-purple-700 dark:text-purple-300 mb-0.5 whitespace-nowrap">סכום חודשי</p>
              <p className="text-fluid-lg font-bold text-purple-900 dark:text-purple-100 overflow-hidden text-ellipsis">{(fundData.monthly_amount || 0).toLocaleString('he-IL')} ₪</p>
            </div>
          </div>
        ) : (
          <div className="fund-panel-empty text-center py-2 text-gray-500 dark:text-gray-400 text-fluid-sm">אין קופה</div>
        )}
      </div>

      {/* Optional content right below the fund card (the fund documentation board) */}
      {fundNotes && (
        <div className="fund-notes-slot flex-shrink-0">{fundNotes}</div>
      )}

      {/* Unforeseen */}
      <div className="unforeseen-panel-card project-detail-card bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-3 flex flex-col flex-1 min-h-0 min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-2 flex-shrink-0">
          <h3 className="unforeseen-panel-title text-fluid-base font-bold text-gray-900 dark:text-white whitespace-nowrap">עסקאות לא צפויות</h3>
          <div className="flex items-center gap-1.5 flex-wrap flex-shrink-0">
            {unforeseenTransactions.length > 0 && (
              <button
                onClick={onShowUnforeseenTransactionsModal}
                className="unforeseen-panel-button px-2.5 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-fluid-sm flex items-center gap-1 whitespace-nowrap"
              >
                <FileText className="w-3.5 h-3.5 shrink-0" />
                ({unforeseenTransactions.length})
              </button>
            )}
            <button
              onClick={() => {
                try { onResetUnforeseenForm() } catch (_) {}
                onShowCreateUnforeseenTransactionModal()
              }}
              className="unforeseen-panel-button px-2.5 py-1.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-fluid-sm whitespace-nowrap"
            >
              +
            </button>
          </div>
        </div>
        {unforeseenTransactionsLoading ? (
          <div className="text-center py-2 text-gray-500 text-sm">טוען...</div>
        ) : unforeseenTransactions.length > 0 ? (
          <div
            ref={scrollContainerRef}
            className="flex-1 min-h-0 max-h-[220px] pr-1 space-y-1.5 overflow-y-auto"
            style={{ overscrollBehavior: (isAtTop || isAtBottom) ? 'auto' : 'contain' }}
            onScroll={() => {
              if (!scrollContainerRef.current) return
              const c = scrollContainerRef.current
              setIsAtTop(c.scrollTop <= 1)
              setIsAtBottom(c.scrollTop + c.clientHeight >= c.scrollHeight - 1)
            }}
            onWheel={(e) => {
              if (!scrollContainerRef.current || !needsScrolling) return
              const c = scrollContainerRef.current
              const atTop = c.scrollTop <= 1
              const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 1
              if ((e.deltaY > 0 && atBottom) || (e.deltaY < 0 && atTop)) return
              e.preventDefault()
              e.stopPropagation()
              c.scrollTop += e.deltaY
            }}
          >
            {unforeseenTransactions.map((tx) => (
              <div
                key={tx.id}
                className="unforeseen-panel-item border border-gray-200 dark:border-gray-700 rounded-lg p-2 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer min-w-0"
                onClick={() => (onViewUnforeseenTransaction ? onViewUnforeseenTransaction(tx) : onShowUnforeseenTransactionsModal())}
              >
                <div className="grid grid-cols-3 items-center gap-2 min-w-0">
                  <span className="unforeseen-panel-item-desc text-fluid-sm text-gray-900 dark:text-white overflow-hidden text-ellipsis text-start min-w-0">
                    {tx.description || `#${tx.id}`}
                  </span>
                  <span className="flex justify-center shrink-0">
                    <span
                      className={`unforeseen-panel-item-status px-1.5 py-0.5 rounded text-fluid-sm shrink-0 whitespace-nowrap ${
                        tx.status === 'executed'
                          ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300'
                          : tx.status === 'waiting_for_approval'
                            ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300'
                            : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                      }`}
                    >
                      {tx.status === 'draft' && 'טיוטה'}
                      {tx.status === 'waiting_for_approval' && 'מחכה לאישור'}
                      {tx.status === 'executed' && 'בוצע'}
                    </span>
                  </span>
                  <span className={`unforeseen-panel-item-amount text-fluid-sm font-bold shrink-0 text-end whitespace-nowrap ${tx.profit_loss >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {tx.profit_loss >= 0 ? '+' : ''}{tx.profit_loss.toLocaleString('he-IL')} ₪
                  </span>
                </div>
                <div className="unforeseen-panel-item-meta text-fluid-sm text-gray-500 mt-0.5 whitespace-nowrap">
                  הכנסה: {(tx.total_incomes ?? tx.income_amount).toLocaleString('he-IL')} ₪ | הוצאות: {tx.total_expenses.toLocaleString('he-IL')} ₪
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="unforeseen-panel-empty text-center py-3 text-gray-500">
            <p className="mb-1.5 text-fluid-sm whitespace-nowrap">אין עסקאות</p>
            <button
              onClick={() => { try { onResetUnforeseenForm() } catch (_) {}; onShowCreateUnforeseenTransactionModal() }}
              className="unforeseen-panel-button px-3 py-1.5 bg-purple-600 text-white rounded-lg text-fluid-sm hover:bg-purple-700 whitespace-nowrap"
            >
              עסקה חדשה
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
