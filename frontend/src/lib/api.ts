import axios from 'axios'
import { getToken, setToken, getRefreshToken, setRefreshToken, clearAuthCache } from './authCache'
console.log("VITE_API_URL =", import.meta.env.VITE_API_URL);

const api = axios.create({
  baseURL:import.meta.env.VITE_API_URL,
  timeout: 60000, // 60s default covers Render.com cold starts (30-60s)
  withCredentials: false,
})

let refreshPromise: Promise<{ access_token: string; refresh_token?: string }> | null = null

api.interceptors.request.use((config) => {
  const isFormData = config.data instanceof FormData

  const token = getToken()
  if (token) {
    config.headers = config.headers ?? {}
    config.headers.Authorization = `Bearer ${token}`
  }

  // For FormData, don't set Content-Type - let axios/browser set it with boundary
  if (isFormData) {
    delete config.headers['Content-Type']
  }

  return config
})

/** Base URL of the backend (origin) for building absolute URLs for uploads/avatars */
const getBaseUrl = () => {
  const base = api.defaults.baseURL ?? ''
  const withoutPath = base.replace(/\/api\/v1\/?$/, '')
  return withoutPath || (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL
    ? String(import.meta.env.VITE_API_URL).replace(/\/api\/v1\/?$/, '')
    : '')
}

/**
 * Returns absolute URL for an avatar path from the API (e.g. /uploads/avatars/xxx).
 * Returns null if path is falsy.
 */
export function avatarUrl(path: string | null | undefined): string | null {
  if (path == null || path === '') return null
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  const base = getBaseUrl()
  return base ? `${base}${path.startsWith('/') ? path : `/${path}`}` : path
}

/**
 * Returns absolute URL for a file attachment path from the API.
 * Returns null if path is falsy.
 */
export function fileAttachmentUrl(path: string | null | undefined): string | null {
  if (path == null || path === '') return null
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  const base = getBaseUrl()
  return base ? `${base}${path.startsWith('/') ? path : `/${path}`}` : path
}

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const status = error?.response?.status
    const originalRequest = error.config

    if (status === 401) {
      const refreshToken = getRefreshToken()
      const isAuthEndpoint = originalRequest?.url?.includes('/auth/')

      // Try refresh if we have refresh_token and this isn't a login/refresh request
      if (refreshToken && !isAuthEndpoint && !originalRequest._retry) {
        originalRequest._retry = true
        try {
          refreshPromise ??= axios
            .post(api.defaults.baseURL + 'auth/refresh', { refresh_token: refreshToken })
            .then(({ data }) => {
              refreshPromise = null
              return data
            })
            .catch((err) => {
              refreshPromise = null
              throw err
            })
          const data = await refreshPromise
          setToken(data.access_token)
          if (data.refresh_token) {
            setRefreshToken(data.refresh_token)
          }
          originalRequest.headers.Authorization = `Bearer ${data.access_token}`
          return api(originalRequest)
        } catch (refreshErr) {
          refreshPromise = null
          // Fall through to redirect
        }
      }

      // No refresh token or refresh failed - clear cache and redirect to login
      clearAuthCache()
      const currentPath = window.location.pathname + window.location.search
      if (currentPath !== '/login' && currentPath !== '/register') {
        localStorage.setItem('redirectAfterLogin', currentPath)
      }
      window.location.href = '/login'
    } else if (status === 403) {
      window.dispatchEvent(new CustomEvent('permission-denied', {
        detail: { message: error.response?.data?.detail || 'אין לך הרשאה לבצע פעולה זו' }
      }))
    } else {
      console.error("API Error:", error.response?.data || error.message)
    }

    return Promise.reject(error)
  }
)

export type ArchivedTaskPreset = 'last_week' | 'last_month' | 'last_3_months'

export interface ArchivedTasksParams {
  preset?: ArchivedTaskPreset
  date_from?: string // ISO string
  date_to?: string   // ISO string
  assigned_to_user_id?: number
}

export async function getArchivedTasks(params: ArchivedTasksParams = {}) {
  const { data } = await api.get('/tasks/archived', { params })
  return data
}

export async function restoreTask(taskId: number) {
  const { data } = await api.post(`/tasks/${taskId}/restore`)
  return data
}

export async function getSuperTasks(): Promise<import('../pages/TaskCalendar').Task[]> {
  const { data } = await api.get('/tasks/super')
  return data
}

export async function getBacklogTasks(): Promise<import('../pages/TaskCalendar').Task[]> {
  const { data } = await api.get('/tasks/backlog')
  return data
}

export default api
