import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

vi.mock('../../../lib/legalApi', () => ({
  LegalAPI: {
    get: vi.fn(), documents: vi.fn(), entries: vi.fn(), createEntry: vi.fn(), updateEntry: vi.fn(), deleteEntry: vi.fn(),
    uploadEntryDocuments: vi.fn(), deleteEntryDocument: vi.fn(), uploadDocuments: vi.fn(), deleteDocument: vi.fn(),
    completeStage: vi.fn(), skipStage: vi.fn(), reopenStage: vi.fn(), close: vi.fn(), reopen: vi.fn(),
    addLedgerItem: vi.fn(), updateLedgerItem: vi.fn(), archiveLedgerItem: vi.fn(),
    team: vi.fn(), saveAssignees: vi.fn(),
  },
}))
vi.mock('../../../lib/api', () => ({ default: { get: vi.fn() } }))
vi.mock('../../../lib/collectionApi', () => ({ CollectionAPI: { projectOptions: vi.fn() } }))

import { LegalAPI } from '../../../lib/legalApi'
import { CollectionAPI } from '../../../lib/collectionApi'
import httpApi from '../../../lib/api'
import LegalProceedingPage from '../../../pages/LegalProceedingPage'

const api = LegalAPI as unknown as Record<keyof typeof LegalAPI, ReturnType<typeof vi.fn>>

const stage = (key: string, position: number, label: string, components: Array<[string, string]> = [], extra = {}) => ({
  key, position, label, description: null, requires_communication: position === 1, status: 'pending', resolved_at: null, resolved_by: null,
  components: components.map(([k, l]) => ({ key: k, label: l })), ...extra,
})
const DOOR: Array<[string, string]> = [['door_placement', 'תיעוד הדבקה על הדלת'], ['letter_file', 'קובץ המכתב'], ['email_proof', 'אסמכתת שליחה במייל'], ['whatsapp_proof', 'אסמכתת שליחה בוואטסאפ']]
const STAGES = [
  stage('collection_messages', 1, 'שליחת הודעות גבייה'),
  stage('first_door_notice', 2, 'מכתב ראשון על הדלת', DOOR),
  stage('second_door_notice', 3, 'מכתב נוסף על הדלת', DOOR),
  stage('lawyer_warning', 4, 'מכתב התראה מעו"ד', [['lawyer_letter', 'מכתב עורך הדין']]),
  stage('supervisor_claim', 5, 'תביעה מול המפקחת', [['claim_filing', 'פתיחת הליך התביעה'], ['supervisor_decision', 'החלטת המפקחת']]),
]
const detail = {
  id: 7, title: 'חוב ועד בית', status: 'open', party_role: 'tenant', claim_details: null, total_amount: '150.00',
  contact: { id: 1, name: 'דנה כהן', phone: '050', phone_2: null, email: 'd@example.com', address: 'א', apartment_number: '12' },
  linked_landlord: { id: 2, name: 'יוסי לוי', phone: '052', phone_2: null, email: null, address: null, apartment_number: null },
  project: null, opened_at: '2026-10-01T00:00:00Z', closed_at: null, close_reason: null,
  progress: { resolved: 0, total: 5, percent: 0, next_stage_key: 'collection_messages' }, stages: STAGES,
  permissions: { can_update: true, can_assign: true, can_delete_others: false },
  ledger_items: [
    { id: 1, item_type: 'base_amount', subject: 'בסיס', amount: '100.00', sort_order: 0 },
    { id: 2, item_type: 'addition', subject: 'תוספת', amount: '50.00', sort_order: 1 },
  ],
}
const doc = (id: number, extra = {}) => ({ id, file_name: `קובץ ${id}.pdf`, download_url: `https://files/${id}`, uploaded_by: null, uploaded_at: null, stage_key: null, component_key: null, entry_id: null, ...extra })
const entry = (id: number, extra = {}) => ({ id, entry_type: 'note', stage_key: null, context_key: null, content: `הערה ${id}`, channel: null, occurred_at: null, created_by: null, created_at: '2026-10-01T00:00:00Z', updated_at: null, can_modify: true, documents: [], ...extra })
const TEAM = {
  owner: { id: 1, full_name: 'מנהלת ראשית' },
  assignees: [{ user: { id: 3, full_name: 'משה לוי' }, assigned_by: { id: 1, full_name: 'מנהלת ראשית' }, assigned_at: '2026-11-01T00:00:00Z' }],
}
const USERS = [{ id: 1, full_name: 'מנהלת ראשית' }, { id: 3, full_name: 'משה לוי' }, { id: 4, full_name: 'רות כץ' }, { id: 5, full_name: 'אבי פרץ' }]
const apiError = (status: number, detailBody: unknown) => ({ response: { status, data: { detail: detailBody } } })

function renderPage() {
  return render(<MemoryRouter initialEntries={['/legal-proceedings/7']}><Routes>
    <Route path="/legal-proceedings/:proceedingId" element={<LegalProceedingPage />} />
    <Route path="/legal-proceedings" element={<div>רשימת ההליכים</div>} />
  </Routes></MemoryRouter>)
}
const stagesNav = () => screen.findByRole('navigation', { name: 'שלבי ההליך' })
const openStage = async (name: RegExp) => userEvent.click(within(await stagesNav()).getByRole('button', { name }))

describe('LegalProceedingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockResolvedValue(detail)
    api.documents.mockResolvedValue([
      doc(1), doc(2, { stage_key: 'first_door_notice', component_key: 'door_placement' }),
      doc(3, { stage_key: 'first_door_notice', component_key: 'door_placement', entry_id: 9 }),
    ])
    api.entries.mockImplementation(async (_id: number, filters: { general_only?: boolean; stage_key?: string }) => ({
      items: filters.general_only ? [entry(1, { content: 'הערה כללית קיימת' })]
        : filters.stage_key === 'collection_messages'
          ? [entry(5, { entry_type: 'communication', stage_key: 'collection_messages', channel: 'whatsapp', occurred_at: '2026-10-02T09:00:00Z', content: 'נשלחה תזכורת' })]
          : filters.stage_key === 'first_door_notice'
            ? [entry(6, { stage_key: 'first_door_notice', context_key: 'door_placement', content: 'הודבק בשעה 9' }),
               entry(8, { stage_key: 'first_door_notice', content: 'הערה לשלב השני' })]
            : [],
      next_before_id: null,
    }))
    api.team.mockResolvedValue(TEAM)
    ;(httpApi.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: USERS })
  })

  describe('team', () => {
    const teamCard = () => screen.findByRole('region', { name: 'צוות ההליך' })

    it('shows the creator as primary owner and the assigned users', async () => {
      renderPage()
      const card = await teamCard()
      expect(await within(card).findByText('מנהלת ראשית')).toBeInTheDocument()
      expect(within(card).getByText('אחראי ראשי')).toBeInTheDocument()
      expect(within(card).getByText('משה לוי')).toBeInTheDocument()
      expect(within(card).getByText(/שויך ע"י מנהלת ראשית/)).toBeInTheDocument()
      expect(api.team).toHaveBeenCalledWith(7)
    })

    it('offers editing only with can_assign on an open proceeding', async () => {
      api.get.mockResolvedValue({ ...detail, permissions: { ...detail.permissions, can_assign: false } })
      const { unmount } = renderPage()
      const card = await teamCard()
      await within(card).findByText('משה לוי')
      expect(within(card).queryByRole('button', { name: /עריכת שיוכים/ })).not.toBeInTheDocument()
      unmount()

      api.get.mockResolvedValue({ ...detail, status: 'closed', closed_at: '2026-10-05T00:00:00Z', close_reason: 'שולם' })
      renderPage()
      const closed = await teamCard()
      await within(closed).findByText('משה לוי')
      expect(within(closed).queryByRole('button', { name: /עריכת שיוכים/ })).not.toBeInTheDocument()
    })

    it('saves the wanted set of users, without the creator in the choices, and shows what changed', async () => {
      api.saveAssignees.mockResolvedValue({
        added: [4], removed: [3],
        team: { owner: TEAM.owner, assignees: [{ user: { id: 4, full_name: 'רות כץ' }, assigned_by: TEAM.owner, assigned_at: '2026-11-12T00:00:00Z' }] },
      })
      renderPage()
      const card = await teamCard()
      await userEvent.click(await within(card).findByRole('button', { name: /עריכת שיוכים/ }))
      await userEvent.click(within(card).getByRole('button', { name: 'הסר משה לוי' }))
      await userEvent.click(within(card).getByRole('textbox'))
      expect(within(card).queryByRole('button', { name: 'מנהלת ראשית' })).not.toBeInTheDocument()  // the owner is not offered
      await userEvent.click(within(card).getByRole('button', { name: 'רות כץ' }))
      await userEvent.click(within(card).getByRole('button', { name: 'שמירה' }))

      await waitFor(() => expect(api.saveAssignees).toHaveBeenCalledWith(7, [4]))
      const status = await within(card).findByRole('status')
      expect(status).toHaveTextContent('רות כץ שויך להליך')
      expect(status).toHaveTextContent('משה לוי הוסר מההליך')
      expect(within(card).getByRole('button', { name: /עריכת שיוכים/ })).toBeInTheDocument()  // back to the view
    })

    it('a rejected save changes nothing: it shows the reason, keeps editing open and re-reads the team', async () => {
      api.saveAssignees.mockRejectedValue(apiError(422, { code: 'user_not_assignable', message: 'The user does not exist or is not active', user_id: 5 }))
      renderPage()
      const card = await teamCard()
      await userEvent.click(await within(card).findByRole('button', { name: /עריכת שיוכים/ }))
      await userEvent.click(within(card).getByRole('textbox'))
      await userEvent.click(within(card).getByRole('button', { name: 'רות כץ' }))
      await userEvent.click(within(card).getByRole('button', { name: 'אבי פרץ' }))
      await userEvent.click(within(card).getByRole('button', { name: 'שמירה' }))

      await waitFor(() => expect(api.saveAssignees).toHaveBeenCalledWith(7, [3, 4, 5]))
      const status = await within(card).findByRole('status')
      expect(status).toHaveTextContent('השיוכים לא נשמרו: המשתמש אינו קיים או אינו פעיל.')
      expect(status).not.toHaveTextContent('שויך להליך')
      expect(api.team).toHaveBeenCalledTimes(2)                                           // re-read after the failure
      expect(within(card).getByRole('button', { name: 'שמירה' })).toBeInTheDocument()  // still editing, to retry
      await userEvent.click(within(card).getByRole('button', { name: 'ביטול' }))
      expect(within(card).getByText('משה לוי')).toBeInTheDocument()                     // the server's team, unchanged
      expect(within(card).queryByText('רות כץ')).not.toBeInTheDocument()
    })
  })

  const panelOf = (position: number, label: string) => screen.findByRole('region', { name: `שלב ${position}: ${label}` })
  const component = (panel: HTMLElement, name: string) => within(panel).getByRole('group', { name })
  const expand = async (group: HTMLElement) => userEvent.click(within(group).getByRole('button', { expanded: false }))

  it('shows the header, compact parties and exactly the stages the server sends', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'חוב ועד בית' })).toBeInTheDocument()
    expect(screen.getByText('0 מתוך 5 שלבים')).toBeInTheDocument()
    const parties = screen.getByRole('region', { name: 'צדדים' })
    expect(within(parties).getByText('דנה כהן')).toBeInTheDocument()
    expect(within(parties).getByText('יוסי לוי')).toBeInTheDocument()
    expect(within(parties).getByText(/דירה 12/)).toBeInTheDocument()
    const steps = within(await stagesNav()).getAllByRole('button')
    expect(steps.map((b) => b.getAttribute('aria-label'))).toEqual([
      'שלב 1: שליחת הודעות גבייה, ממתין', 'שלב 2: מכתב ראשון על הדלת, ממתין', 'שלב 3: מכתב נוסף על הדלת, ממתין',
      'שלב 4: מכתב התראה מעו"ד, ממתין', 'שלב 5: תביעה מול המפקחת, ממתין'])
    expect(steps[0]).toHaveAttribute('aria-current', 'step')
    // the selected stage's full name is shown for narrow screens too
    expect(within(await stagesNav()).getByText('שלב 1: שליחת הודעות גבייה')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /הוספת שלב|מחיקת שלב/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /חזרה לרשימת ההליכים/ })).toHaveAttribute('href', '/legal-proceedings')
    expect(CollectionAPI.projectOptions).not.toHaveBeenCalled()
  })

  it('shows the ledger total and counts, with the breakdown only on demand', async () => {
    renderPage()
    const ledger = await screen.findByRole('region', { name: 'כרטסת' })
    expect(within(ledger).getByText(/150\.00/)).toBeInTheDocument()
    expect(within(ledger).getByText('1 פריטי בסיס · 1 תוספות')).toBeInTheDocument()
    expect(within(ledger).queryByLabelText('נושא פריט חדש')).not.toBeInTheDocument()
    await userEvent.click(within(ledger).getByRole('button', { name: /הצגת הפירוט/ }))
    expect(within(ledger).getByLabelText('נושא פריט חדש')).toBeInTheDocument()
  })

  it('lists the fixed components with a written state, and keeps records and files apart', async () => {
    renderPage()
    await openStage(/מכתב ראשון על הדלת/)
    const panel = await panelOf(2, 'מכתב ראשון על הדלת')
    expect(within(panel).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(
      ['תיעוד הדבקה על הדלת', 'קובץ המכתב', 'אסמכתת שליחה במייל', 'אסמכתת שליחה בוואטסאפ'])
    expect(within(component(panel, 'תיעוד הדבקה על הדלת')).getByText('תועד')).toBeInTheDocument()
    expect(within(component(panel, 'קובץ המכתב')).getByText('חסר')).toBeInTheDocument()
    expect(within(panel).getByText('1 מתוך 4 רכיבים תועדו')).toBeInTheDocument()
    const door = component(panel, 'תיעוד הדבקה על הדלת')
    expect(within(door).queryByRole('link')).not.toBeInTheDocument()                     // collapsed until opened
    await expand(door)
    expect(within(door).getByText('הודבק בשעה 9')).toBeInTheDocument()                   // a record
    expect(within(door).getByRole('link', { name: 'הורדת קובץ 2.pdf' })).toHaveAttribute('href', 'https://files/2')
    expect(within(door).getByRole('button', { name: 'קובץ 2.pdf' })).toBeInTheDocument()   // opens the viewer in the page
    expect(within(door).queryByText('קובץ 3.pdf')).not.toBeInTheDocument()               // an entry's file is not the component's
    expect(within(door).getByLabelText('העלאת קבצים: תיעוד הדבקה על הדלת')).toBeInTheDocument()
    expect(within(panel).queryByText('הערה לשלב השני')).not.toBeInTheDocument()          // stage notes are on their own tab
    await userEvent.click(within(panel).getByRole('tab', { name: 'הערות לשלב 2' }))
    expect(within(panel).getByText('הערה לשלב השני')).toBeInTheDocument()
    expect(api.entries).toHaveBeenCalledWith(7, { stage_key: 'first_door_notice' })
  })

  it('opens the note form only on request and adds a note to a component', async () => {
    api.createEntry.mockResolvedValue(entry(10))
    renderPage()
    await openStage(/מכתב ראשון על הדלת/)
    const letter = component(await panelOf(2, 'מכתב ראשון על הדלת'), 'קובץ המכתב')
    await expand(letter)
    expect(within(letter).queryByLabelText('הערה: קובץ המכתב')).not.toBeInTheDocument()
    await userEvent.click(within(letter).getByRole('button', { name: /הוספת הערה/ }))
    await userEvent.type(within(letter).getByLabelText('הערה: קובץ המכתב'), 'המכתב נשמר')
    await userEvent.click(within(letter).getByRole('button', { name: 'הוספה' }))
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledWith(7, { entry_type: 'note', stage_key: 'first_door_notice', context_key: 'letter_file', content: 'המכתב נשמר' }))
  })

  it('records a sent message in stage 1 through a form opened on request', async () => {
    api.createEntry.mockResolvedValue(entry(11))
    renderPage()
    const panel = await panelOf(1, 'שליחת הודעות גבייה')
    expect(await within(panel).findByText('נשלחה תזכורת')).toBeInTheDocument()
    expect(within(panel).getByRole('tab', { name: 'תיעוד שליחה (1)' })).toHaveAttribute('aria-selected', 'true')
    expect(within(panel).queryByLabelText('ערוץ')).not.toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: /הוספת תיעוד שליחה/ }))
    await userEvent.selectOptions(within(panel).getByLabelText('ערוץ'), 'email')
    await userEvent.type(within(panel).getByLabelText('תוכן ההודעה'), 'מייל דרישה')
    await userEvent.click(within(panel).getByRole('button', { name: 'שמירת התיעוד' }))
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledTimes(1))
    expect(api.createEntry.mock.calls[0][1]).toMatchObject({ entry_type: 'communication', stage_key: 'collection_messages', channel: 'email', content: 'מייל דרישה', files: [] })
  })

  it('warns about missing documentation and completes only after an explicit confirmation', async () => {
    api.completeStage
      .mockRejectedValueOnce(apiError(409, { code: 'stage_requirements_missing', message: 'x', missing: [{ key: 'letter_file', label: 'קובץ המכתב' }] }))
      .mockResolvedValueOnce({ ...detail, stages: STAGES.map((s) => (s.position === 2 ? { ...s, status: 'completed' } : s)) })
    renderPage()
    await openStage(/מכתב ראשון על הדלת/)
    await userEvent.click(await screen.findByRole('button', { name: /סימון כהושלם/ }))
    const warning = await screen.findByRole('alertdialog', { name: 'תיעוד חסר' })
    expect(warning).toHaveTextContent('קובץ המכתב')
    expect(api.completeStage).toHaveBeenLastCalledWith(7, 'first_door_notice')
    await userEvent.click(within(warning).getByRole('button', { name: 'סימון כהושלם בכל זאת' }))
    await waitFor(() => expect(api.completeStage).toHaveBeenLastCalledWith(7, 'first_door_notice', true))
    expect(await within(await stagesNav()).findByRole('button', { name: 'שלב 2: מכתב ראשון על הדלת, הושלם' })).toBeInTheDocument()
  })

  it('skips a pending stage and reopens it, asking for an optional reason only then', async () => {
    api.skipStage.mockResolvedValue({ ...detail, stages: STAGES.map((s) => (s.position === 5 ? { ...s, status: 'skipped' } : s)) })
    api.reopenStage.mockResolvedValue(detail)
    renderPage()
    await openStage(/תביעה מול המפקחת/)
    expect(screen.queryByLabelText('סיבה')).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: /סימון כלא רלוונטי/ }))
    await userEvent.type(screen.getByLabelText('סיבה'), 'שולם')
    await userEvent.click(screen.getByRole('button', { name: 'אישור: לא רלוונטי' }))
    await waitFor(() => expect(api.skipStage).toHaveBeenCalledWith(7, 'supervisor_claim', 'שולם'))
    await userEvent.click(await screen.findByRole('button', { name: /פתיחת השלב מחדש/ }))
    await userEvent.click(screen.getByRole('button', { name: 'אישור פתיחה מחדש' }))
    await waitFor(() => expect(api.reopenStage).toHaveBeenCalledWith(7, 'supervisor_claim', ''))
  })

  it('shows general documents and notes apart, without component or entry files', async () => {
    renderPage()
    const general = await screen.findByRole('region', { name: 'מסמכים והערות כלליים' })
    expect(within(general).getByRole('button', { name: 'קובץ 1.pdf' })).toBeInTheDocument()
    expect(within(general).queryByText('קובץ 2.pdf')).not.toBeInTheDocument()
    expect(within(general).getByText('הערה כללית קיימת')).toBeInTheDocument()
    expect(within(general).queryByLabelText('הערה כללית')).not.toBeInTheDocument()
    expect(api.entries).toHaveBeenCalledWith(7, { general_only: true })
  })

  it('is read-only when the proceeding is closed', async () => {
    api.get.mockResolvedValue({ ...detail, status: 'closed', closed_at: '2026-10-05T00:00:00Z', close_reason: 'שולם' })
    renderPage()
    await screen.findByRole('heading', { name: 'חוב ועד בית' })
    expect(screen.getByText('ההליך סגור. השלבים והתיעוד לקריאה בלבד.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /סימון כהושלם/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /הוספת/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/העלאת/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /הצגת הפירוט/ }))
    expect(screen.getByText('ההליך סגור. הכרטסת לקריאה בלבד.')).toBeInTheDocument()
    expect(screen.queryByLabelText('נושא פריט חדש')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /פתיחה מחדש/ })).toBeInTheDocument()
  })

  it('manages ledger items through the legal API', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    api.addLedgerItem.mockResolvedValue({})
    api.archiveLedgerItem.mockResolvedValue({})
    renderPage()
    const ledger = await screen.findByRole('region', { name: 'כרטסת' })
    await userEvent.click(within(ledger).getByRole('button', { name: /הצגת הפירוט/ }))
    expect(within(ledger).queryByRole('button', { name: 'העבר לארכיון בסיס' })).not.toBeInTheDocument()
    await userEvent.type(within(ledger).getByLabelText('נושא פריט חדש'), 'הוצאה')
    await userEvent.type(within(ledger).getByLabelText('סכום פריט חדש'), '20')
    await userEvent.click(within(ledger).getByRole('button', { name: /הוסף פריט/ }))
    await waitFor(() => expect(api.addLedgerItem).toHaveBeenCalledWith(7, { subject: 'הוצאה', amount: '20' }))
    await userEvent.click(within(ledger).getByRole('button', { name: 'העבר לארכיון תוספת' }))
    await waitFor(() => expect(api.archiveLedgerItem).toHaveBeenCalledWith(7, 2))
  })

  it('closes the proceeding with a reason', async () => {
    api.close.mockResolvedValue(undefined)
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /סגירת הליך/ }))
    const submit = screen.getByRole('button', { name: 'סגירה' })
    expect(submit).toBeDisabled()
    await userEvent.type(screen.getByLabelText('סיבת שינוי הסטטוס'), 'שולם')
    await userEvent.click(submit)
    await waitFor(() => expect(api.close).toHaveBeenCalledWith(7, 'שולם'))
  })

  it('shows an error when the proceeding cannot be loaded', async () => {
    api.get.mockRejectedValue(apiError(404, 'Proceeding not found'))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('ההליך לא נמצא')
  })
})
