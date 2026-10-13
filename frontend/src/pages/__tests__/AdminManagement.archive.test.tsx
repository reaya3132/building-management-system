/**
 * Tests for the admin archive flow on the AdminManagement page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import AdminManagement from '../AdminManagement'
import authSlice from '../../store/slices/authSlice'
import api from '../../lib/api'

vi.mock('../../lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}))

const me = { id: 1, email: 'admin@test.com', full_name: 'Main Admin', role: 'Admin', is_active: true, created_at: '2024-01-01' }
const other = { id: 5, email: 'other@test.com', full_name: 'Other Admin', role: 'Admin', is_active: true, created_at: '2024-01-01' }

const renderPage = () => {
  const store = configureStore({
    reducer: { auth: authSlice },
    preloadedState: {
      auth: { token: 't', me, loading: false, error: null, requiresPasswordChange: false } as any,
    },
  })
  return render(
    <Provider store={store}>
      <AdminManagement />
    </Provider>
  )
}

describe('AdminManagement archive', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue({ data: [me, other] } as any)
    vi.mocked(api.post).mockResolvedValue({ data: {} } as any)
    vi.spyOn(window, 'confirm')
  })

  it('cancel closes the modal without archiving', async () => {
    renderPage()
    await screen.findByText('Other Admin')
    await userEvent.click(screen.getByText('העבר לארכיון'))
    expect(screen.getByText('האם להעביר את המשתמש Other Admin לארכיון?')).toBeTruthy()
    await userEvent.click(screen.getByText('ביטול'))
    expect(screen.queryByText('אישור העברה לארכיון')).toBeNull()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('confirm archives the admin via the archive endpoint', async () => {
    renderPage()
    await screen.findByText('Other Admin')
    await userEvent.click(screen.getByText('העבר לארכיון'))
    await userEvent.click(screen.getByText('אישור העברה לארכיון'))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/users/5/archive'))
    await waitFor(() => expect(screen.queryByText('אישור העברה לארכיון')).toBeNull())
    expect(window.confirm).not.toHaveBeenCalled()
  })
})
