import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import authReducer from '../../../store/slices/authSlice'
import permissionsReducer from '../../../store/slices/permissionsSlice'
import notificationsReducer from '../../../store/slices/notificationsSlice'

vi.mock('../../../lib/api', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: { total_unread: 0, count: 0 } }) },
  avatarUrl: (p: string | null) => p,
}))
vi.mock('../../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }) }))
vi.mock('../../../contexts/InventorySettingsContext', () => ({ useInventorySettings: () => ({ open: vi.fn() }) }))

import { Sidebar } from '../../ui/Sidebar'

function renderSidebar(role: string, permissions: { resource_type: string; action: string }[]) {
  const store = configureStore({
    reducer: { auth: authReducer, permissions: permissionsReducer, notifications: notificationsReducer },
    preloadedState: {
      auth: { me: { id: 5, role, full_name: 'בודק' } } as any,
      permissions: {
        permissions: permissions.map((p) => ({ ...p, source: 'resource_policy' })),
        loading: false,
        loaded: true,
        error: null,
      },
    } as any,
  })
  render(
    <Provider store={store}>
      <MemoryRouter>
        <Sidebar isCollapsed={false} onToggle={() => {}} />
      </MemoryRouter>
    </Provider>
  )
}

const collectionLink = () => screen.queryByRole('link', { name: /גבייה/ })

describe('collection menu item (existing any-permission rule)', () => {
  it('is shown to a user with any collection_task permission', () => {
    renderSidebar('Member', [{ resource_type: 'collection_task', action: 'read' }])
    expect(collectionLink()).toHaveAttribute('href', '/collection-tasks')
  })

  it('is shown for a non-read permission too, as for every other module', () => {
    renderSidebar('Member', [{ resource_type: 'collection_task', action: 'write' }])
    expect(collectionLink()).toBeInTheDocument()
  })

  it('is hidden without a collection_task permission, while other items keep their rules', () => {
    renderSidebar('Member', [{ resource_type: 'task', action: 'read' }])
    expect(collectionLink()).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /ניהול משימות/ })).toBeInTheDocument()
  })

  it('is shown to an Admin', () => {
    renderSidebar('Admin', [])
    expect(collectionLink()).toBeInTheDocument()
  })
})
