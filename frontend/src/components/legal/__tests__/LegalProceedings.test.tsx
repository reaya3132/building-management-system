import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import authReducer from '../../../store/slices/authSlice'
import permissionsReducer from '../../../store/slices/permissionsSlice'

const item = {
  id: 7, title: 'חוב ועד בית', status: 'open', party_role: 'tenant', apartment_number: '12', claim_amount: '1500.00',
  contact: { id: 1, name: 'דנה כהן' }, linked_landlord: { id: 2, name: 'יוסי לוי' }, project: { id: 3, name: 'בניין א' },
  created_by: { id: 9, name: 'עו"ד' }, opened_at: '2026-10-01T00:00:00Z', closed_at: null,
  progress: { resolved: 2, total: 5, percent: 40, next_stage_key: null }, assignee_ids: [],
}

vi.mock('../../../lib/legalApi', () => ({
  LegalAPI: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    close: vi.fn(async () => undefined),
    reopen: vi.fn(async () => undefined),
    landlords: vi.fn(async () => [{ id: 2, name: 'יוסי לוי' }]),
    projects: vi.fn(async () => [{ project_id: 3, project_name: 'בניין א' }, { project_id: null, project_name: null }]),
    projectOptions: vi.fn(async () => [{ id: 5, name: 'כניסה 1', parent_name: 'בניין א' }, { id: 6, name: 'עצמאי', parent_name: null }]),
    searchContacts: vi.fn(async () => [{ id: 1, name: 'דנה כהן', phone: '0501111111', phone_2: null, email: 'd@example.com', address: 'א' }]),
  },
}))
vi.mock('../../../lib/collectionApi', () => ({ CollectionAPI: { projectOptions: vi.fn(async () => []) } }))
vi.mock('../../../lib/api', () => ({ default: { get: vi.fn().mockResolvedValue({ data: [] }) }, avatarUrl: (p: string | null) => p, fileAttachmentUrl: (p: string | null) => p }))

import { LegalAPI } from '../../../lib/legalApi'
import { CollectionAPI } from '../../../lib/collectionApi'
import LegalProceedings from '../../../pages/LegalProceedings'

const api = LegalAPI as unknown as Record<keyof typeof LegalAPI, ReturnType<typeof vi.fn>>

function renderPage(role: 'Admin' | 'Member' = 'Admin') {
  const store = configureStore({
    reducer: { auth: authReducer, permissions: permissionsReducer } as any,
    preloadedState: {
      auth: { me: { id: 1, role, full_name: 'x', email: 'x@example.com' } },
      permissions: { permissions: [{ resource_type: 'legal_proceeding', action: 'read' }], loaded: true },
    } as any,
  })
  return render(<Provider store={store}><MemoryRouter><LegalProceedings /></MemoryRouter></Provider>)
}

const page = (items: unknown[], total = items.length) => ({ items, total, page: 1, page_size: 25 })
const apiError = (status: number, detail: unknown) => ({ response: { status, data: { detail } } })

describe('LegalProceedings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.list.mockResolvedValue(page([item]))
  })

  it('shows the proceeding details in the table', async () => {
    renderPage()
    const row = (await screen.findByRole('button', { name: 'חוב ועד בית' })).closest('tr') as HTMLElement
    for (const text of ['דנה כהן', 'שוכר', 'יוסי לוי', '12', 'בניין א', '2 מתוך 5', 'פתוח']) {
      expect(within(row).getByText(text)).toBeInTheDocument()
    }
  })

  it('shows the loading state, then an empty state', async () => {
    let resolve: (value: unknown) => void = () => undefined
    api.list.mockReturnValue(new Promise((r) => { resolve = r }))
    renderPage()
    expect(screen.getAllByTestId('legal-skeleton').length).toBeGreaterThan(0)
    resolve(page([]))
    expect(await screen.findByText('עדיין אין הליכים משפטיים')).toBeInTheDocument()
  })

  it('shows an error and retries', async () => {
    api.list.mockRejectedValueOnce(apiError(403, 'Permission denied'))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('אין לך הרשאה')
    await userEvent.click(screen.getByRole('button', { name: 'ניסיון חוזר' }))
    expect(await screen.findByRole('button', { name: 'חוב ועד בית' })).toBeInTheDocument()
  })

  it('sends the status filter to the server and resets the page', async () => {
    api.list.mockResolvedValue(page([item], 60))
    renderPage()
    await screen.findByRole('button', { name: 'חוב ועד בית' })
    await userEvent.click(screen.getByRole('button', { name: 'העמוד הבא' }))
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })))
    await userEvent.selectOptions(screen.getByLabelText('סינון לפי סטטוס'), 'closed')
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'closed', page: 1 })))
  })

  it('offers an empty-filter message that clears the filters', async () => {
    renderPage()
    await screen.findByRole('button', { name: 'חוב ועד בית' })
    api.list.mockResolvedValue(page([]))
    await userEvent.selectOptions(screen.getByLabelText('סינון לפי סטטוס'), 'closed')
    await userEvent.click(await screen.findByRole('button', { name: 'ניקוי המסננים' }))
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ status: null })))
  })

  it('hides create and close from a user without those permissions', async () => {
    renderPage('Member')
    await screen.findByRole('button', { name: 'חוב ועד בית' })
    expect(screen.queryByRole('button', { name: /הליך חדש/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /סגירת הליך/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /צפייה בהליך/ })).toBeInTheDocument()
  })

  it('requires a reason to close a proceeding', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /סגירת הליך/ }))
    const submit = screen.getByRole('button', { name: 'סגירה' })
    expect(submit).toBeDisabled()
    await userEvent.type(screen.getByLabelText('סיבה'), 'שולם')
    await userEvent.click(submit)
    await waitFor(() => expect(api.close).toHaveBeenCalledWith(7, 'שולם'))
  })

  describe('create', () => {
    const open = async () => {
      renderPage()
      await userEvent.click(await screen.findByRole('button', { name: /הליך חדש/ }))
    }
    const fillBasics = async () => {
      await userEvent.type(screen.getByLabelText('מספר דירה'), '4')
      await userEvent.type(screen.getByLabelText('כותרת'), 'תיק')
    }
    const pickContact = async (searchLabel: string) => {
      await userEvent.type(screen.getByLabelText(searchLabel), 'דנ')
      await userEvent.click(await screen.findByRole('button', { name: /דנה כהן/ }))
    }

    it('offers legal project options with the parent name, not the collection list', async () => {
      await open()
      await waitFor(() => expect(api.projectOptions).toHaveBeenCalled())
      await userEvent.click(screen.getByRole('button', { name: 'פרויקט להליך' }))
      expect(await screen.findByText('בניין א › כניסה 1')).toBeInTheDocument()
      expect(screen.getByText('עצמאי')).toBeInTheDocument()
      expect(CollectionAPI.projectOptions).not.toHaveBeenCalled()
    })

    it('shows the landlord picker only for a tenant, and clears it when switching', async () => {
      await open()
      await pickContact('חיפוש בעל הדירה המשויך')
      expect(screen.getByText('בעל הדירה המשויך')).toBeInTheDocument()
      for (const role of ['landlord', 'supplier', 'other']) {
        await userEvent.selectOptions(screen.getByLabelText('סוג איש הקשר'), role)
        expect(screen.queryByText('בעל הדירה המשויך')).not.toBeInTheDocument()
      }
      await userEvent.selectOptions(screen.getByLabelText('סוג איש הקשר'), 'tenant')
      expect(screen.getByLabelText('חיפוש בעל הדירה המשויך')).toBeInTheDocument()  // the choice was cleared
    })

    it('sends the selection for a non-tenant without a landlord', async () => {
      api.create.mockResolvedValue(undefined)
      await open()
      await userEvent.selectOptions(screen.getByLabelText('סוג איש הקשר'), 'supplier')
      await fillBasics()
      await pickContact('חיפוש ספק')
      await userEvent.click(screen.getByRole('button', { name: 'פתיחת הליך' }))
      await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
      const body = api.create.mock.calls[0][0]
      expect(body).toMatchObject({ party_role: 'supplier', apartment_number: '4', title: 'תיק', contact: { contact_id: 1 } })
      expect(body).not.toHaveProperty('landlord')
    })

    it('asks before continuing on a server warning, then resends with the confirmation', async () => {
      const message = 'לאיש קשר זה כבר קיים הליך משפטי פתוח. האם להמשיך?'
      api.create.mockRejectedValueOnce(apiError(409, { code: 'tenant_has_open_proceeding', message })).mockResolvedValueOnce(undefined)
      await open()
      await fillBasics()
      await pickContact('חיפוש שוכר')
      await pickContact('חיפוש בעל הדירה המשויך')
      await userEvent.click(screen.getByRole('button', { name: 'פתיחת הליך' }))
      expect(await screen.findByRole('alertdialog')).toHaveTextContent(message)
      await userEvent.click(screen.getByRole('button', { name: 'המשך בכל זאת' }))
      await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2))
      expect(api.create.mock.calls[1][0]).toMatchObject({ confirm_open_proceeding: true })
    })

    it('shows the server message when a card is missing details', async () => {
      const message = 'חסרים פרטי חובה בכרטיס איש הקשר. יש לפנות למנהל להשלמת הפרטים.'
      api.create.mockRejectedValueOnce(apiError(422, { code: 'contact_details_incomplete', message, party: 'contact', missing: ['email'] }))
      await open()
      await fillBasics()
      await pickContact('חיפוש שוכר')
      await pickContact('חיפוש בעל הדירה המשויך')
      await userEvent.click(screen.getByRole('button', { name: 'פתיחת הליך' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('לפנות למנהל')
    })
  })
})
