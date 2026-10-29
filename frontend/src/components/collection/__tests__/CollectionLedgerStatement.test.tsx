import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import authReducer from '../../../store/slices/authSlice'
import permissionsReducer from '../../../store/slices/permissionsSlice'
import type { CollectionTaskDetail } from '../../../lib/collectionApi'

const baseTask: CollectionTaskDetail = {
  id: 7, title: 'הוצאות ינואר', status: 'open', collection_type: 'ledger', billing_month: '2026-10-01',
  project: { id: 2, name: 'כניסה 1', parent_name: 'בניין א' }, assignees: [{ id: 5, full_name: 'בודק' }],
  total_amount: '330.50', is_archived: false, unread_messages_count: 0,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  description: null, initial_amount: null, adjustments: [], attachments: [], created_by_user_id: 5,
  ledger_items: [
    { id: 1, subject: 'ועד', amount: '250.00', sort_order: 0, created_by_user_id: 5, created_at: '', updated_at: '' },
    { id: 2, subject: 'חניה', amount: '80.50', sort_order: 1, created_by_user_id: 5, created_at: '', updated_at: '' },
    { id: 3, subject: 'בארכיון', amount: '99.00', sort_order: 2, created_by_user_id: 5, created_at: '', updated_at: '', archived_at: '2026-10-02T00:00:00Z' },
  ],
}

const api = vi.hoisted(() => ({
  get: vi.fn(),
  statementPdf: vi.fn(),
  update: vi.fn(),
  updateLedgerItem: vi.fn(),
  addLedgerItem: vi.fn(),
  archiveLedgerItem: vi.fn(),
}))

vi.mock('../../../lib/collectionApi', () => ({
  CollectionAPI: {
    get: api.get,
    statementPdf: api.statementPdf,
    update: api.update,
    updateLedgerItem: api.updateLedgerItem,
    addLedgerItem: api.addLedgerItem,
    archiveLedgerItem: api.archiveLedgerItem,
    projectOptions: vi.fn(async () => []),
    history: vi.fn(async () => ({ items: [], total: 0, page: 1, page_size: 30 })),
  },
}))
vi.mock('../../../lib/api', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: [] }) },
  avatarUrl: (p: string | null) => p,
  fileAttachmentUrl: (p: string | null) => p,
}))

import CollectionTaskDetailModal from '../CollectionTaskDetailModal'
import { initialDraft, statementFromDraft } from '../StatementExportModal'
import { displayCollectionTitle } from '../collectionUtils'

function renderModal() {
  const store = configureStore({
    reducer: { auth: authReducer, permissions: permissionsReducer },
    preloadedState: {
      auth: { me: { id: 5, role: 'Member', full_name: 'בודק' } } as any,
      permissions: {
        permissions: [{ resource_type: 'collection_task', action: 'read', source: 'resource_policy' }],
        loading: false, loaded: true, error: null,
      },
    } as any,
  })
  render(
    <Provider store={store}>
      <CollectionTaskDetailModal taskId={7} onClose={() => {}} onChanged={() => {}} />
    </Provider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  api.statementPdf.mockResolvedValue(new Blob(['%PDF'], { type: 'application/pdf' }))
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

describe('ledger title prefix (display only)', () => {
  it('prefixes ledgers once and leaves single tasks as stored', () => {
    expect(displayCollectionTitle(baseTask)).toBe('כרטסת - הוצאות ינואר')
    expect(displayCollectionTitle({ ...baseTask, collection_type: 'single' })).toBe('הוצאות ינואר')
  })

  it('shows the prefix in the header but edits and saves the raw title', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(baseTask)
    api.update.mockResolvedValue({ ...baseTask, title: 'הוצאות פברואר' })
    renderModal()
    expect(await screen.findByRole('heading', { name: 'כרטסת - הוצאות ינואר' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /עריכה/ }))
    const titleInput = screen.getByDisplayValue('הוצאות ינואר')
    await user.clear(titleInput)
    await user.type(titleInput, 'הוצאות פברואר')
    await user.click(screen.getByRole('button', { name: 'שמירה' }))
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(7, { title: 'הוצאות פברואר' }))
  })
})

describe('PDF export availability', () => {
  it('is offered for a ledger', async () => {
    api.get.mockResolvedValue(baseTask)
    renderModal()
    expect(await screen.findByRole('button', { name: /ייצוא ל־PDF/ })).toBeInTheDocument()
  })

  it('is not offered for a single task', async () => {
    api.get.mockResolvedValue({ ...baseTask, collection_type: 'single', initial_amount: '100.00', ledger_items: [] })
    renderModal()
    await screen.findByRole('heading', { name: 'הוצאות ינואר' })
    expect(screen.queryByRole('button', { name: /ייצוא ל־PDF/ })).not.toBeInTheDocument()
  })
})

describe('statement draft', () => {
  it('starts from the active items only', () => {
    expect(initialDraft(baseTask).map((r) => r.subject)).toEqual(['ועד', 'חניה'])
  })

  it('totals only included rows, in agorot, and rejects invalid included rows', () => {
    const draft = [
      { key: 'a', include: true, subject: 'ועד', amount: '250.10' },
      { key: 'b', include: false, subject: 'חניה', amount: '80.50' },
      { key: 'c', include: true, subject: 'חדש', amount: '0.20' },
    ]
    expect(statementFromDraft(draft)).toEqual({
      lines: [{ subject: 'ועד', amount: '250.10' }, { subject: 'חדש', amount: '0.20' }], totalAgorot: 25030, error: null,
    })
    expect(statementFromDraft([{ key: 'x', include: true, subject: 'x', amount: '1.234' }]).error).toMatch(/סכום/)
    expect(statementFromDraft([{ key: 'x', include: false, subject: '', amount: '' }]).lines).toEqual([])
  })
})

describe('export window', () => {
  it('edits the document only: preview and export use the edited lines, the ledger is untouched', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(baseTask)
    renderModal()
    await user.click(await screen.findByRole('button', { name: /ייצוא ל־PDF/ }))

    const editor = screen.getByRole('region', { name: 'עריכת המסמך' })
    expect(within(editor).getByText('אוקטובר 2026')).toBeInTheDocument()
    expect(within(editor).getByText('בניין א › כניסה 1')).toBeInTheDocument()
    expect(screen.getByTestId('statement-total')).toHaveTextContent('330.50')

    // Exclude "חניה", change the first amount, add a document-only line.
    await user.click(within(editor).getByRole('checkbox', { name: /חניה/ }))
    const firstAmount = within(editor).getByRole('textbox', { name: 'סכום שורה 1' })
    await user.clear(firstAmount)
    await user.type(firstAmount, '300')
    await user.click(within(editor).getByRole('button', { name: /הוסף שורה למסמך/ }))
    await user.type(within(editor).getByRole('textbox', { name: 'נושא שורה 3' }), 'קנס')
    await user.type(within(editor).getByRole('textbox', { name: 'סכום שורה 3' }), '19.99')

    expect(screen.getByTestId('statement-total')).toHaveTextContent('319.99')
    const expected = [{ subject: 'ועד', amount: '300' }, { subject: 'קנס', amount: '19.99' }]
    await waitFor(() => expect(api.statementPdf).toHaveBeenLastCalledWith(7, expected), { timeout: 3000 })
    expect(await screen.findByTitle('תצוגה מקדימה של ה־PDF')).toHaveAttribute('src', 'blob:preview')

    await user.click(screen.getByRole('button', { name: /^ייצוא PDF/ }))
    await waitFor(() => expect(api.statementPdf).toHaveBeenLastCalledWith(7, expected))
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled()

    for (const mutation of [api.update, api.updateLedgerItem, api.addLedgerItem, api.archiveLedgerItem]) {
      expect(mutation).not.toHaveBeenCalled()
    }
  })
})
