import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import authReducer from '../../../store/slices/authSlice'
import permissionsReducer from '../../../store/slices/permissionsSlice'

const item = {
  id: 7, title: 'חוב ועד בית', status: 'open', party_role: 'tenant', apartment_number: '12', total_amount: '1500.00',
  contact: { id: 1, name: 'דנה כהן' }, linked_landlord: { id: 2, name: 'יוסי לוי' }, project: { id: 3, name: 'בניין א' },
  created_by: { id: 9, name: 'עו"ד' }, opened_at: '2026-10-01T00:00:00Z', closed_at: null,
  progress: { resolved: 2, total: 5, percent: 40, next_stage_key: null }, assignee_ids: [],
}

vi.mock('../../../lib/legalApi', () => ({
  LegalAPI: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    addLedgerItem: vi.fn(async () => ({})),
    updateLedgerItem: vi.fn(async () => ({})),
    archiveLedgerItem: vi.fn(async () => ({})),
    close: vi.fn(async () => undefined),
    reopen: vi.fn(async () => undefined),
    landlords: vi.fn(async () => [{ id: 2, name: 'יוסי לוי' }]),
    projects: vi.fn(async () => [{ project_id: 3, project_name: 'בניין א' }, { project_id: null, project_name: null }]),
    projectOptions: vi.fn(async () => [{ id: 5, name: 'כניסה 1', parent_name: 'בניין א' }, { id: 6, name: 'עצמאי', parent_name: null }]),
    searchContacts: vi.fn(async () => [{ id: 1, name: 'דנה כהן', phone: '0501111111', phone_2: null, email: 'd@example.com', address: 'א', apartment_number: '12' }]),
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
  const Target = () => <div>עמוד הליך {useParams().proceedingId}</div>
  return render(<Provider store={store}><MemoryRouter initialEntries={['/legal-proceedings']}><Routes>
    <Route path="/legal-proceedings" element={<LegalProceedings />} />
    <Route path="/legal-proceedings/:proceedingId" element={<Target />} />
  </Routes></MemoryRouter></Provider>)
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
      await userEvent.type(screen.getByLabelText('נושא ההליך'), 'תיק')
      await userEvent.type(screen.getByLabelText('נושא סכום 1'), 'סכום תביעה')
      await userEvent.type(screen.getByLabelText('סכום 1'), '100')
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

    const chooseRole = (name: string) => userEvent.click(screen.getByRole('radio', { name }))

    it('keeps the proceeding details on top, one party choice and no general apartment field', async () => {
      await open()
      expect(screen.getByRole('radiogroup', { name: 'מי הצד בהליך?' })).toBeInTheDocument()
      expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['שוכר', 'בעל דירה', 'ספק', 'אחר'])
      expect(screen.queryByLabelText('סוג איש הקשר')).not.toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'פרטי ההליך' })).toBeInTheDocument()
      expect(screen.queryByLabelText('מספר דירה')).not.toBeInTheDocument()
      expect(screen.getByLabelText('נושא ההליך')).toHaveAttribute('placeholder')
    })

    it('does not render the landlord section until a tenant is selected', async () => {
      await open()
      expect(screen.queryByText('בעל הדירה המשויך')).not.toBeInTheDocument()
      await pickContact('חיפוש שוכר')
      expect(screen.getByText('בעל הדירה המשויך')).toBeInTheDocument()
    })

    it('shows a landlord section only for a tenant, and clears the choices when switching', async () => {
      await open()
      await pickContact('חיפוש שוכר')
      await pickContact('חיפוש בעל הדירה המשויך')
      for (const role of ['בעל דירה', 'ספק', 'אחר']) {
        await chooseRole(role)
        expect(screen.queryByText('בעל הדירה המשויך')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /^הסרת/ })).not.toBeInTheDocument()
      }
      await chooseRole('שוכר')
      expect(screen.getByLabelText('חיפוש שוכר')).toBeInTheDocument()
      expect(screen.queryByText('בעל הדירה המשויך')).not.toBeInTheDocument()
    })

    it('removing the tenant drops the landlord that was chosen for it', async () => {
      await open()
      await pickContact('חיפוש שוכר')
      await pickContact('חיפוש בעל הדירה המשויך')
      await userEvent.click(screen.getByRole('button', { name: 'הסרת שוכר' }))
      expect(screen.queryByText('בעל הדירה המשויך')).not.toBeInTheDocument()
      await pickContact('חיפוש שוכר')
      expect(screen.getByLabelText('חיפוש בעל הדירה המשויך')).toBeInTheDocument()
    })

    it('a new tenant reveals the landlord only after its details are confirmed', async () => {
      await open()
      await userEvent.click(screen.getByRole('tab', { name: 'שוכר חדש' }))
      const confirm = screen.getByRole('button', { name: 'אישור פרטי השוכר' })
      expect(confirm).toBeDisabled()
      expect(screen.queryByText('בעל הדירה המשויך')).not.toBeInTheDocument()
      for (const [field, text] of [['שם', 'דנה'], ['טלפון', '0501111111'], ['דוא"ל', 'd@example.com'], ['כתובת', 'רחוב'], ['מספר דירה', '4']]) {
        await userEvent.type(screen.getByLabelText(`שוכר ${field}`), text)
      }
      expect(confirm).toBeEnabled()
      await userEvent.click(confirm)
      expect(screen.getByText('בעל הדירה המשויך')).toBeInTheDocument()
      expect(screen.getByLabelText('שוכר שם')).toBeDisabled()
      await userEvent.click(screen.getByRole('button', { name: 'עריכת פרטי השוכר' }))
      expect(screen.queryByText('בעל הדירה המשויך')).not.toBeInTheDocument()
    })

    it('asks only for the details this role is missing and sends them as a completion', async () => {
      api.searchContacts.mockResolvedValueOnce([{ id: 1, name: 'דנה כהן', phone: '0501111111', phone_2: null, email: null, address: 'א', apartment_number: null }])
      api.create.mockResolvedValue(undefined)
      await open()
      await chooseRole('ספק')
      await fillBasics()
      await pickContact('חיפוש ספק')
      expect(screen.queryByLabelText('ספק כתובת')).not.toBeInTheDocument()
      await userEvent.type(screen.getByLabelText('ספק דוא"ל'), 'd@example.com')
      await userEvent.type(screen.getByLabelText('ספק מספר דירה'), '9')
      await userEvent.type(screen.getByLabelText('ספק טלפון נוסף'), '0522222222')
      await userEvent.click(screen.getByRole('button', { name: 'פתיחת הליך' }))
      await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
      expect(api.create.mock.calls[0][0].contact).toEqual({ contact_id: 1, complete: { email: 'd@example.com', apartment_number: '9', phone_2: '0522222222' } })
    })

    it('blocks a primary party with missing details and does not call the server', async () => {
      api.searchContacts.mockResolvedValueOnce([{ id: 1, name: 'דנה כהן', phone: '0501111111', phone_2: null, email: null, address: null, apartment_number: null }])
      await open()
      await chooseRole('אחר')
      await fillBasics()
      await pickContact('חיפוש אחר')
      await userEvent.click(screen.getByRole('button', { name: 'פתיחת הליך' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('להשלים')
      expect(api.create).not.toHaveBeenCalled()
    })

    it('a linked landlord does not require an email, address or apartment', async () => {
      api.create.mockResolvedValue(undefined)
      await open()
      await fillBasics()
      await pickContact('חיפוש שוכר')
      await userEvent.click(screen.getByRole('tab', { name: 'בעל דירה חדש' }))
      await userEvent.type(screen.getByLabelText('בעל הדירה המשויך שם'), 'יוסי')
      await userEvent.type(screen.getByLabelText('בעל הדירה המשויך טלפון'), '0502222222')
      await userEvent.click(screen.getByRole('button', { name: 'פתיחת הליך' }))
      await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
      expect(api.create.mock.calls[0][0].landlord).toEqual({ details: { kind: 'person', name: 'יוסי', phone: '0502222222' } })
    })

    it('sends every base amount', async () => {
      api.create.mockResolvedValue(undefined)
      await open()
      await chooseRole('ספק')
      await fillBasics()
      await userEvent.click(screen.getByRole('button', { name: 'הוספת סכום' }))
      await userEvent.type(screen.getByLabelText('נושא סכום 2'), 'ועד')
      await userEvent.type(screen.getByLabelText('סכום 2'), '50.5')
      await pickContact('חיפוש ספק')
      await userEvent.click(screen.getByRole('button', { name: 'פתיחת הליך' }))
      await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
      expect(api.create.mock.calls[0][0].base_items).toEqual([{ subject: 'סכום תביעה', amount: '100' }, { subject: 'ועד', amount: '50.5' }])
    })

    it('requires a valid amount', async () => {
      await open()
      await chooseRole('ספק')
      await userEvent.type(screen.getByLabelText('נושא ההליך'), 'תיק')
      await userEvent.type(screen.getByLabelText('נושא סכום 1'), 'סכום תביעה')
      await pickContact('חיפוש ספק')
      await userEvent.click(screen.getByRole('button', { name: 'פתיחת הליך' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('סכום לא תקין')
      expect(api.create).not.toHaveBeenCalled()
    })

    it('shows a loading, error and empty state for the projects', async () => {
      let reject: (reason: unknown) => void = () => undefined
      api.projectOptions.mockReturnValueOnce(new Promise((_, r) => { reject = r }))
      await open()
      expect(screen.getByRole('button', { name: 'פרויקט להליך' })).toHaveTextContent('טוען')
      reject(new Error('x'))
      expect(await screen.findByText(/טעינת הפרויקטים נכשלה/)).toBeInTheDocument()
      api.projectOptions.mockResolvedValueOnce([])
      await userEvent.click(screen.getByRole('button', { name: 'ניסיון חוזר' }))
      expect(await screen.findByText('אין פרויקטים פעילים לבחירה.')).toBeInTheDocument()
    })

    it('sends the selection for a non-tenant without a landlord', async () => {
      api.create.mockResolvedValue(undefined)
      await open()
      await chooseRole('ספק')
      await fillBasics()
      await pickContact('חיפוש ספק')
      await userEvent.click(screen.getByRole('button', { name: 'פתיחת הליך' }))
      await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
      const body = api.create.mock.calls[0][0]
      expect(body).toMatchObject({ party_role: 'supplier', title: 'תיק', contact: { contact_id: 1 }, base_items: [{ subject: 'סכום תביעה', amount: '100' }] })
      expect(body).not.toHaveProperty('apartment_number')
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
      const message = 'חסרים פרטי חובה בכרטיס איש הקשר. יש להשלים את הפרטים החסרים.'
      api.create.mockRejectedValueOnce(apiError(422, { code: 'contact_details_incomplete', message, party: 'contact', missing: ['email'] }))
      await open()
      await fillBasics()
      await pickContact('חיפוש שוכר')
      await pickContact('חיפוש בעל הדירה המשויך')
      await userEvent.click(screen.getByRole('button', { name: 'פתיחת הליך' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('להשלים')
    })
  })

  it('opens a proceeding on its own page instead of a dialog', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'חוב ועד בית' }))
    expect(await screen.findByText('עמוד הליך 7')).toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalled()
  })
})
