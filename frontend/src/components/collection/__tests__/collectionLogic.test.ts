import { describe, expect, it } from 'vitest'
import {
  collectionErrorMessage,
  currentMonth,
  formatILS,
  parseMoneyInput,
  shiftMonth,
  toMonthKey,
} from '../collectionUtils'
import { validateCollectionForm } from '../CreateCollectionTaskModal'
import { collectionTaskAbilities } from '../CollectionTaskDetailModal'
import { toProjectComboOptions } from '../useCollectionLookups'
import { describeCollectionEvent } from '../CollectionHistory'

describe('money', () => {
  it('formats server decimal strings as ILS with two decimals', () => {
    const text = formatILS('1234.5')
    expect(text).toContain('1,234.50')
    expect(text).toContain('₪')
    expect(formatILS(null)).toContain('0.00')
  })

  it('accepts only positive amounts with up to two decimals (backend Money rule)', () => {
    expect(parseMoneyInput('100')).toBe('100')
    expect(parseMoneyInput(' 1,250.75 ')).toBe('1250.75')
    expect(parseMoneyInput('0.01')).toBe('0.01')
    expect(parseMoneyInput('0')).toBeNull()
    expect(parseMoneyInput('-5')).toBeNull()
    expect(parseMoneyInput('1.234')).toBeNull()
    expect(parseMoneyInput('abc')).toBeNull()
    expect(parseMoneyInput('12345678901')).toBeNull()
  })
})

describe('billing months', () => {
  it('builds and shifts YYYY-MM keys across years', () => {
    expect(currentMonth(new Date(2026, 9, 28))).toBe('2026-10')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(toMonthKey('2026-10-01')).toBe('2026-10')
  })
})

describe('error messages', () => {
  const err = (status: number, detail: unknown) => ({ response: { status, data: { detail } } })

  it('maps business error codes to Hebrew', () => {
    expect(collectionErrorMessage(err(409, { code: 'task_closed', message: 'closed' }), 'x')).toMatch(/סגורה/)
  })

  it('keeps Hebrew server text and replaces English 403 text', () => {
    expect(collectionErrorMessage(err(403, 'רק מנהל יכול'), 'x')).toBe('רק מנהל יכול')
    expect(collectionErrorMessage(err(403, 'Permission denied: read on collection_task'), 'x')).toBe('אין לך הרשאה לבצע פעולה זו.')
  })
})

describe('create form validation', () => {
  const base = {
    title: 'דמי ניהול', projectId: 1, month: '2026-10', assigneeIds: [1],
    type: 'single' as const, initialAmount: '100', items: [],
  }

  it('passes a valid single task and a ledger task', () => {
    expect(validateCollectionForm(base)).toBeNull()
    expect(validateCollectionForm({ ...base, type: 'ledger', initialAmount: '', items: [{ subject: 'מים', amount: '20.50' }] })).toBeNull()
  })

  it('rejects missing fields and invalid amounts', () => {
    expect(validateCollectionForm({ ...base, title: ' ' })).toMatch(/כותרת/)
    expect(validateCollectionForm({ ...base, projectId: null })).toMatch(/פרויקט/)
    expect(validateCollectionForm({ ...base, assigneeIds: [] })).toMatch(/מוקצה/)
    expect(validateCollectionForm({ ...base, initialAmount: '0' })).toMatch(/סכום/)
    expect(validateCollectionForm({ ...base, type: 'ledger', items: [{ subject: '', amount: '5' }] })).toMatch(/נושא/)
  })
})

describe('task abilities (mirror of the server rules)', () => {
  const task = { assignees: [{ id: 2, full_name: 'א' }], created_by_user_id: 3, is_archived: false, status: 'open' as const }
  const member = (id: number) => ({ id, role: 'Member' })

  it('lets an assignee edit and change amounts, but not assignees or unarchive', () => {
    const can = collectionTaskAbilities(task, member(2))
    expect(can).toMatchObject({ canEdit: true, canChangeAmounts: true, canChangeAssignees: false, canArchive: true, canUnarchive: false })
  })

  it('lets the creator only archive, and an outsider nothing', () => {
    expect(collectionTaskAbilities(task, member(3))).toMatchObject({ canEdit: false, canArchive: true })
    expect(collectionTaskAbilities(task, member(9))).toMatchObject({ canEdit: false, canArchive: false })
  })

  it('locks amounts on a closed task and everything on an archived one', () => {
    expect(collectionTaskAbilities({ ...task, status: 'closed' }, member(2))).toMatchObject({ canEdit: true, canChangeAmounts: false })
    const archived = collectionTaskAbilities({ ...task, is_archived: true }, { id: 1, role: 'Admin' })
    expect(archived).toMatchObject({ canEdit: false, canChangeAmounts: false, canArchive: false, canUnarchive: true })
  })
})

describe('project options', () => {
  it('lists active projects only, labelling sub-projects under an inactive parent', () => {
    const options = toProjectComboOptions([
      { id: 1, name: 'בניין א', relation_project: null, is_parent_project: true, is_active: false },
      { id: 2, name: 'כניסה 1', relation_project: 1, is_parent_project: false, is_active: true },
      { id: 3, name: 'בניין ב', relation_project: null, is_parent_project: false, is_active: true },
    ])
    expect(options.map((o) => o.id).sort()).toEqual([2, 3])
    expect(options.find((o) => o.id === 2)?.label).toBe('בניין א › כניסה 1')
  })
})

describe('history descriptions', () => {
  it('describes status and amount events', () => {
    const entry = (action: string, details: Record<string, unknown>) =>
      ({ id: 1, action, details, created_at: '2026-10-01T00:00:00Z' })
    expect(describeCollectionEvent(entry('reopened', { before: { status: 'completed' }, after: { status: 'pending' } })))
      .toBe('נסגרה ← פתוחה')
    expect(describeCollectionEvent(entry('adjustment_added', { after: { amount: '50.00', note: 'קנס' } }))).toContain('קנס')
    expect(describeCollectionEvent(entry('message_edited', { after: { preview: 'שלום' } }))).toBe('שלום')
  })
})
