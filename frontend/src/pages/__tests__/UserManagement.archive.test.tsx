/**
 * Tests for the user archive flow on the UserManagement page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter } from 'react-router-dom'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import UserManagement from '../UserManagement'
import authSlice from '../../store/slices/authSlice'
import api from '../../lib/api'

vi.mock('../../lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  avatarUrl: () => null,
}))

const me = { id: 1, email: 'admin@test.com', full_name: 'Admin', role: 'Admin', is_active: true, created_at: '2024-01-01' }
const member = { id: 2, email: 'member@test.com', full_name: 'Dana Member', role: 'Member', is_active: true, created_at: '2024-01-01' }
const archived = { ...member, id: 3, full_name: 'Old User', is_active: false, archived_at: '2024-06-01T10:00:00', phone: '050-1234567' }

const renderPage = () => {
  const store = configureStore({
    reducer: { auth: authSlice },
    preloadedState: {
      auth: { token: 't', me, loading: false, error: null, requiresPasswordChange: false } as any,
    },
  })
  return render(
    <Provider store={store}>
      <BrowserRouter>
        <UserManagement />
      </BrowserRouter>
    </Provider>
  )
}

describe('UserManagement archive', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockImplementation((url: string) =>
      Promise.resolve({ data: url === '/users/archived' ? [archived] : [me, member] }) as any
    )
    vi.mocked(api.post).mockResolvedValue({ data: {} } as any)
    vi.spyOn(window, 'confirm')
    vi.spyOn(window, 'alert').mockImplementation(() => {})
  })

  it('shows an archive button instead of delete, not for the current user', async () => {
    renderPage()
    await screen.findByText('Dana Member')
    expect(screen.getAllByText('העבר לארכיון')).toHaveLength(1)
    expect(screen.queryByText('מחק')).toBeNull()
  })

  it('opens the archive modal with the user name without calling the API', async () => {
    renderPage()
    await screen.findByText('Dana Member')
    await userEvent.click(screen.getByText('העבר לארכיון'))
    expect(screen.getByText('האם להעביר את המשתמש Dana Member לארכיון?')).toBeTruthy()
    expect(api.post).not.toHaveBeenCalled()
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('cancel closes the modal without archiving', async () => {
    renderPage()
    await screen.findByText('Dana Member')
    await userEvent.click(screen.getByText('העבר לארכיון'))
    await userEvent.click(screen.getByText('ביטול'))
    expect(screen.queryByText('אישור העברה לארכיון')).toBeNull()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('confirm archives the user via the archive endpoint and closes the modal', async () => {
    renderPage()
    await screen.findByText('Dana Member')
    await userEvent.click(screen.getByText('העבר לארכיון'))
    await userEvent.click(screen.getByText('אישור העברה לארכיון'))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/users/2/archive'))
    await waitFor(() => expect(screen.queryByText('אישור העברה לארכיון')).toBeNull())
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('shows archived users in the archive view', async () => {
    renderPage()
    await screen.findByText('Dana Member')
    await userEvent.click(screen.getByText('ארכיון'))
    expect(await screen.findByText('Old User')).toBeTruthy()
    expect(screen.getByText('050-1234567')).toBeTruthy()
    expect(api.get).toHaveBeenCalledWith('/users/archived')
    expect(screen.getByText('חזרה למשתמשים')).toBeTruthy()
  })
})

describe('UserManagement restore', () => {
  const report = {
    snapshot_found: true,
    restored_project_roles: [{ project_id: 7, role: 'editor' }],
    restored_resource_policies: [],
    restored_cems_role: null,
    restored_cems_warehouse_id: null,
    skipped: [{ kind: 'project_role', item: { project_id: 9 }, reason: 'project_not_found' }],
  }

  const openArchive = async () => {
    renderPage()
    await screen.findByText('Dana Member')
    await userEvent.click(screen.getByText('ארכיון'))
    await screen.findByText('Old User')
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockImplementation((url: string) =>
      Promise.resolve({ data: url === '/users/archived' ? [archived] : [me, member] }) as any
    )
    vi.mocked(api.post).mockResolvedValue({ data: { user: { ...archived, is_active: true }, report } } as any)
    vi.spyOn(window, 'confirm')
    vi.spyOn(window, 'alert').mockImplementation(() => {})
  })

  it('shows a restore button for each archived user and opens the modal without calling the API', async () => {
    await openArchive()
    await userEvent.click(screen.getByText('שחזר'))
    expect(screen.getByText('האם לשחזר את המשתמש Old User מהארכיון?')).toBeTruthy()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('cancel closes the modal without restoring', async () => {
    await openArchive()
    await userEvent.click(screen.getByText('שחזר'))
    await userEvent.click(screen.getByText('ביטול'))
    expect(screen.queryByText('אישור שחזור')).toBeNull()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('confirm restores the user, refreshes the archive list and reports restored/skipped grants', async () => {
    await openArchive()
    const archiveFetchesBefore = vi.mocked(api.get).mock.calls.filter(([url]) => url === '/users/archived').length

    await userEvent.click(screen.getByText('שחזר'))
    await userEvent.click(screen.getByText('אישור שחזור'))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/users/3/restore'))
    await waitFor(() => {
      const after = vi.mocked(api.get).mock.calls.filter(([url]) => url === '/users/archived').length
      expect(after).toBeGreaterThan(archiveFetchesBefore)
    })
    await waitFor(() => expect(window.alert).toHaveBeenCalled())
    const message = vi.mocked(window.alert).mock.calls[0][0] as string
    expect(message).toContain('המשתמש Old User שוחזר בהצלחה')
    expect(message).toContain('שוחזרו 1 תפקידים בפרויקטים')
    expect(message).toContain('1 הרשאות לא שוחזרו')
    expect(screen.queryByText('אישור שחזור')).toBeNull()
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('shows the server error when restore fails', async () => {
    vi.mocked(api.post).mockRejectedValue({ response: { data: { detail: 'User is not archived' } } })
    await openArchive()
    await userEvent.click(screen.getByText('שחזר'))
    await userEvent.click(screen.getByText('אישור שחזור'))
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('שגיאה בשחזור המשתמש: User is not archived'))
    expect(screen.queryByText('אישור שחזור')).toBeNull()
  })
})
