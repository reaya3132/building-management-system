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
