import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppDispatch, useAppSelector } from '../utils/hooks'
import { fetchMe } from '../store/slices/authSlice'
import api, { avatarUrl } from '../lib/api'
import ArchiveUserModal from '../components/ArchiveUserModal'
import RestoreUserModal from '../components/RestoreUserModal'

const DEFAULT_CALENDAR_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16']

interface User {
  id: number
  email: string
  full_name: string
  role: 'Admin' | 'Member'
  group_id?: number
  is_active: boolean
  created_at: string
  calendar_color?: string | null
  avatar_url?: string | null
  phone?: string | null
}

interface RestoreReport {
  snapshot_found: boolean
  restored_project_roles: unknown[]
  restored_resource_policies: unknown[]
  restored_cems_role: string | null
  restored_cems_warehouse_id: string | null
  skipped: { kind: string; item: unknown; reason: string }[]
}

interface RestoreResult {
  user: User
  report: RestoreReport
}

const restoreSummary = (userName: string, report: RestoreReport) => {
  const lines = [`המשתמש ${userName} שוחזר בהצלחה.`]
  if (!report.snapshot_found) {
    lines.push('לא נמצא תיעוד של ההרשאות מלפני ההעברה לארכיון, ולכן לא שוחזרו הרשאות.')
    return lines.join('\n')
  }
  lines.push(
    `שוחזרו ${report.restored_project_roles.length} תפקידים בפרויקטים ו-${report.restored_resource_policies.length} הרשאות משאבים.`
  )
  if (report.restored_cems_role) lines.push(`שוחזר תפקיד מחסנים: ${report.restored_cems_role}.`)
  if (report.skipped.length > 0) {
    lines.push(`${report.skipped.length} הרשאות לא שוחזרו כי הישות שאליה הן שייכות כבר לא קיימת או שההרשאה כבר קיימת.`)
  }
  return lines.join('\n')
}

interface ArchivedUser extends User {
  archived_at: string
  last_login?: string | null
}

const formatDate = (value?: string | null) =>
  value ? new Date(value).toLocaleDateString('he-IL') : '—'

export default function UserManagement() {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const { me, loading: authLoading } = useAppSelector(s => s.auth)
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAddUser, setShowAddUser] = useState(false)
  const [editingUser, setEditingUser] = useState<User | null>(null)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [showArchive, setShowArchive] = useState(false)
  const [archivedUsers, setArchivedUsers] = useState<ArchivedUser[]>([])
  const [archiveTarget, setArchiveTarget] = useState<Pick<User, 'id' | 'full_name'> | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<Pick<User, 'id' | 'full_name'> | null>(null)
  const [restoring, setRestoring] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  // Add user form state
  const [newUser, setNewUser] = useState({
    email: '',
    full_name: '',
    role: 'Member' as 'Admin' | 'Member'
  })
  
  // Edit user form state
  const [editUser, setEditUser] = useState({
    full_name: '',
    role: 'Member' as 'Admin' | 'Member',
    is_active: true,
    calendar_color: '' as string
  })

  // Fetch user data if not loaded
  useEffect(() => {
    if (!me && !authLoading) {
      dispatch(fetchMe())
    }
  }, [me, authLoading, dispatch])

  // Show loading while checking auth
  if (authLoading || !me) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">טוען...</p>
        </div>
      </div>
    )
  }

  // Check if user is admin
  if (me.role !== 'Admin') {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">גישה נדחית</h1>
          <p className="text-gray-600 dark:text-gray-400">רק מנהלי מערכת יכולים לגשת לעמוד זה</p>
        </div>
      </div>
    )
  }

  const fetchUsers = async () => {
    setLoading(true)
    try {
      const response = await api.get('/users')
      setUsers(response.data)
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchUsers()
  }, [])

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      // Use the new admin create user endpoint - password will be generated automatically
      const response = await api.post('/auth/admin/create-user', {
        email: newUser.email,
        full_name: newUser.full_name,
        role: newUser.role
      })
      
      if (response.data) {
        setNewUser({ email: '', full_name: '', role: 'Member' })
        setShowAddUser(false)
        await fetchUsers() // Wait for users to be fetched
        alert('משתמש נוצר בהצלחה! סיסמה זמנית נשלחה במייל.')
      }
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to create user')
    }
  }

  const fetchArchivedUsers = async () => {
    setLoading(true)
    try {
      const response = await api.get('/users/archived')
      setArchivedUsers(response.data)
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message)
    } finally {
      setLoading(false)
    }
  }

  const toggleArchive = async () => {
    setError(null)
    if (showArchive) {
      setShowArchive(false)
      await fetchUsers()
    } else {
      setShowArchive(true)
      await fetchArchivedUsers()
    }
  }

  const handleArchiveUser = async (userId: number) => {
    setError(null)
    setArchiving(true)
    setLoading(true)
    try {
      await api.post(`/users/${userId}/archive`)
      await fetchUsers() // Refresh the list
      alert('המשתמש הועבר לארכיון בהצלחה')
    } catch (err: any) {
      const errorMessage = err.response?.data?.detail || err.message || 'Failed to archive user'
      setError(errorMessage)
      alert(`שגיאה בהעברת המשתמש לארכיון: ${errorMessage}`)
    } finally {
      setLoading(false)
      setArchiving(false)
      setArchiveTarget(null)
    }
  }

  const handleRestoreUser = async (userId: number, userName: string) => {
    setError(null)
    setRestoring(true)
    try {
      const { data } = await api.post<RestoreResult>(`/users/${userId}/restore`)
      await fetchArchivedUsers() // Refresh the archive list
      alert(restoreSummary(userName, data.report))
    } catch (err: any) {
      const errorMessage = err.response?.data?.detail || err.message || 'Failed to restore user'
      setError(errorMessage)
      alert(`שגיאה בשחזור המשתמש: ${errorMessage}`)
    } finally {
      setRestoring(false)
      setRestoreTarget(null)
    }
  }

  const handleEditUser = (user: User) => {
    setEditingUser(user)
    setEditUser({
      full_name: user.full_name,
      role: user.role,
      is_active: user.is_active,
      calendar_color: user.calendar_color || ''
    })
  }

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>, userId: number) => {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) {
      alert('נא לבחור קובץ תמונה (JPG, PNG וכו\')')
      return
    }
    setUploadingAvatar(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const endpoint = userId === me?.id ? '/users/me/avatar' : `/users/${userId}/avatar`
      const { data } = await api.post(endpoint, formData)
      await fetchUsers()
      if (editingUser?.id === userId) setEditingUser({ ...editingUser, avatar_url: data.avatar_url })
      if (userId === me?.id) dispatch(fetchMe())
    } catch (err: any) {
      alert(err.response?.data?.detail || 'שגיאה בהעלאת התמונה')
    } finally {
      setUploadingAvatar(false)
      e.target.value = ''
      avatarInputRef.current?.value && (avatarInputRef.current.value = '')
    }
  }

  const handleUpdateUser = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editingUser) return

    setError(null)
    setLoading(true)
    try {
      await api.put(`/users/${editingUser.id}`, {
        full_name: editUser.full_name,
        role: editUser.role,
        is_active: editUser.is_active,
        calendar_color: editUser.calendar_color?.trim() || null
      })
      
      setEditingUser(null)
      setEditUser({ full_name: '', role: 'Member', is_active: true, calendar_color: '' })
      await fetchUsers() // Refresh the list
      alert('משתמש עודכן בהצלחה')
    } catch (err: any) {
      const errorMessage = err.response?.data?.detail || err.message || 'Failed to update user'
      setError(errorMessage)
      alert(`שגיאה בעדכון המשתמש: ${errorMessage}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
          <div className="flex flex-wrap justify-between items-center gap-3 mb-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                {showArchive ? 'ארכיון משתמשים' : 'ניהול משתמשים'}
              </h1>
              <p className="text-gray-600 dark:text-gray-400 mt-1">
                {showArchive ? 'משתמשים שהועברו לארכיון - אין להם גישה למערכת' : 'ניהול משתמשי המערכת והרשאות'}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={toggleArchive}
                className="px-4 py-2 bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-100 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
              >
                {showArchive ? 'חזרה למשתמשים' : 'ארכיון'}
              </button>
              {!showArchive && (
                <button
                  onClick={() => setShowAddUser(true)}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  הוסף משתמש
                </button>
              )}
            </div>
          </div>

          <ArchiveUserModal
            open={archiveTarget !== null}
            userName={archiveTarget?.full_name ?? ''}
            loading={archiving}
            onClose={() => setArchiveTarget(null)}
            onConfirm={() => archiveTarget && handleArchiveUser(archiveTarget.id)}
          />

          <RestoreUserModal
            open={restoreTarget !== null}
            userName={restoreTarget?.full_name ?? ''}
            loading={restoring}
            onClose={() => setRestoreTarget(null)}
            onConfirm={() => restoreTarget && handleRestoreUser(restoreTarget.id, restoreTarget.full_name)}
          />

          {/* Edit User Modal */}
          {editingUser && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
              <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md mx-4">
                <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-4">ערוך משתמש</h2>
                <form onSubmit={handleUpdateUser} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">שם מלא</label>
                    <input
                      type="text"
                      value={editUser.full_name}
                      onChange={(e) => setEditUser({...editUser, full_name: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                      required
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">תפקיד</label>
                    <select
                      value={editUser.role}
                      onChange={(e) => setEditUser({...editUser, role: e.target.value as 'Admin' | 'Member'})}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                      required
                    >
                      <option value="Member">משתמש</option>
                      <option value="Admin">מנהל מערכת</option>
                    </select>
                  </div>
                  
                  <div>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={editUser.is_active}
                        onChange={(e) => setEditUser({...editUser, is_active: e.target.checked})}
                        className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                      />
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">משתמש פעיל</span>
                    </label>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">צבע ביומן משימות</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={editUser.calendar_color || DEFAULT_CALENDAR_COLORS[(editingUser?.id ?? 0) % DEFAULT_CALENDAR_COLORS.length]}
                        onChange={(e) => setEditUser({...editUser, calendar_color: e.target.value})}
                        className="w-10 h-10 rounded border border-gray-300 dark:border-gray-600 cursor-pointer bg-transparent"
                        title="צבע אירועים ביומן"
                      />
                      <input
                        type="text"
                        value={editUser.calendar_color || ''}
                        onChange={(e) => setEditUser({...editUser, calendar_color: e.target.value})}
                        placeholder="#3B82F6"
                        className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                      />
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">צבע האירועים של העובד ביומן (הקסדצימלי)</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">תמונת פרופיל</label>
                    <div className="flex items-center gap-4">
                      {avatarUrl(editingUser?.avatar_url) ? (
                        <img src={avatarUrl(editingUser?.avatar_url)!} alt="" className="w-14 h-14 rounded-full object-cover border border-gray-300 dark:border-gray-600" />
                      ) : (
                        <div className="w-14 h-14 rounded-full bg-gray-200 dark:bg-gray-600 flex items-center justify-center text-xl font-medium text-gray-600 dark:text-gray-400">
                          {editingUser?.full_name?.charAt(0) || '?'}
                        </div>
                      )}
                      <div>
                        <input
                          ref={avatarInputRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => editingUser && handleAvatarUpload(e, editingUser.id)}
                        />
                        <button
                          type="button"
                          disabled={uploadingAvatar}
                          onClick={() => avatarInputRef.current?.click()}
                          className="px-3 py-1.5 text-sm bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded-lg disabled:opacity-50"
                        >
                          {uploadingAvatar ? 'מעלה...' : 'העלה תמונה'}
                        </button>
                      </div>
                    </div>
                  </div>
                  
                  {error && (
                    <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                      <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
                    </div>
                  )}
                  
                  <div className="flex gap-3">
                    <button
                      type="submit"
                      className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                    >
                      עדכן משתמש
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingUser(null)
                        setEditUser({ full_name: '', role: 'Member', is_active: true, calendar_color: '' })
                      }}
                      className="flex-1 px-4 py-2 bg-gray-300 dark:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-400 dark:hover:bg-gray-500 transition-colors"
                    >
                      ביטול
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Add User Modal */}
          {showAddUser && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
              <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md mx-4">
                <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-4">הוסף משתמש חדש</h2>
                <form onSubmit={handleAddUser} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">שם מלא</label>
                    <input
                      type="text"
                      value={newUser.full_name}
                      onChange={(e) => setNewUser({...newUser, full_name: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                      required
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">אימייל</label>
                    <input
                      type="email"
                      value={newUser.email}
                      onChange={(e) => setNewUser({...newUser, email: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                      required
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">תפקיד</label>
                    <select
                      value={newUser.role}
                      onChange={(e) => setNewUser({...newUser, role: e.target.value as 'Admin' | 'Member'})}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                      required
                    >
                      <option value="Member">משתמש</option>
                      <option value="Admin">מנהל מערכת</option>
                    </select>
                  </div>
                  
                  <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
                    <p className="text-sm text-blue-800 dark:text-blue-300">
                      <strong>שים לב:</strong> סיסמה זמנית תיווצר אוטומטית ותישלח למשתמש במייל. המשתמש יתבקש לשנות את הסיסמה בהתחברות הראשונה.
                    </p>
                  </div>
                  
                  <div className="flex gap-3">
                    <button
                      type="submit"
                      className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                    >
                      הוסף משתמש
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowAddUser(false)}
                      className="flex-1 px-4 py-2 bg-gray-300 dark:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-400 dark:hover:bg-gray-500 transition-colors"
                    >
                      ביטול
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {showArchive ? (
          /* Archived Users List (read-only) */
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">תמונה</th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">שם מלא</th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">אימייל</th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">טלפון</th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">תפקיד</th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">נוצר בתאריך</th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">התחברות אחרונה</th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">הועבר לארכיון</th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">פעולות</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={9} className="text-center py-8 text-gray-500 dark:text-gray-400">
                      טוען ארכיון...
                    </td>
                  </tr>
                ) : archivedUsers.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="text-center py-8 text-gray-500 dark:text-gray-400">
                      אין משתמשים בארכיון
                    </td>
                  </tr>
                ) : (
                  archivedUsers.map((user) => (
                    <tr key={user.id} className="border-b border-gray-200 dark:border-gray-700">
                      <td className="py-3 px-4">
                        {avatarUrl(user.avatar_url) ? (
                          <img src={avatarUrl(user.avatar_url)!} alt="" className="w-8 h-8 rounded-full object-cover border border-gray-300 dark:border-gray-600 grayscale" />
                        ) : (
                          <span
                            className="inline-flex w-8 h-8 rounded-full items-center justify-center text-xs font-medium text-white bg-gray-400 border border-gray-300 dark:border-gray-600"
                            title={user.full_name}
                          >
                            {user.full_name?.charAt(0) || '?'}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-sm text-gray-900 dark:text-white">{user.full_name}</td>
                      <td className="py-3 px-4 text-sm text-gray-900 dark:text-white">{user.email}</td>
                      <td className="py-3 px-4 text-sm text-gray-900 dark:text-white whitespace-nowrap">{user.phone || '—'}</td>
                      <td className="py-3 px-4 text-sm text-gray-900 dark:text-white">{user.role === 'Admin' ? 'מנהל' : 'משתמש'}</td>
                      <td className="py-3 px-4 text-sm text-gray-900 dark:text-white whitespace-nowrap">{formatDate(user.created_at)}</td>
                      <td className="py-3 px-4 text-sm text-gray-900 dark:text-white whitespace-nowrap">{formatDate(user.last_login)}</td>
                      <td className="py-3 px-4 text-sm text-gray-900 dark:text-white whitespace-nowrap">{formatDate(user.archived_at)}</td>
                      <td className="py-3 px-4">
                        <button
                          onClick={() => setRestoreTarget({ id: user.id, full_name: user.full_name })}
                          className="text-green-600 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300 text-sm font-medium px-3 py-1 rounded hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors whitespace-nowrap"
                          title="שחזר משתמש מהארכיון"
                        >
                          שחזר
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          ) : (
          /* Users List */
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">תמונה</th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">צבע יומן</th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">שם מלא</th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">אימייל</th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">תפקיד</th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">סטטוס</th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-700 dark:text-gray-300">פעולות</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={7} className="text-center py-8 text-gray-500 dark:text-gray-400">
                      טוען משתמשים...
                    </td>
                  </tr>
                ) : users.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-8 text-gray-500 dark:text-gray-400">
                      אין משתמשים במערכת
                    </td>
                  </tr>
                ) : (
                  users.map((user) => (
                    <tr key={user.id} className="border-b border-gray-200 dark:border-gray-700">
                      <td className="py-3 px-4">
                        {avatarUrl(user.avatar_url) ? (
                          <img src={avatarUrl(user.avatar_url)!} alt="" className="w-8 h-8 rounded-full object-cover border border-gray-300 dark:border-gray-600" />
                        ) : (
                          <span
                            className="inline-flex w-8 h-8 rounded-full items-center justify-center text-xs font-medium text-white border border-gray-300 dark:border-gray-600"
                            style={{ backgroundColor: user.calendar_color || DEFAULT_CALENDAR_COLORS[(user.id - 1) % DEFAULT_CALENDAR_COLORS.length] }}
                            title={user.full_name}
                          >
                            {user.full_name?.charAt(0) || '?'}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className="inline-block w-6 h-6 rounded border border-gray-300 dark:border-gray-600"
                          style={{ backgroundColor: user.calendar_color || DEFAULT_CALENDAR_COLORS[(user.id - 1) % DEFAULT_CALENDAR_COLORS.length] }}
                          title={user.calendar_color || 'צבע ברירת מחדל'}
                        />
                      </td>
                      <td className="py-3 px-4 text-sm text-gray-900 dark:text-white">{user.full_name}</td>
                      <td className="py-3 px-4 text-sm text-gray-900 dark:text-white">{user.email}</td>
                      <td className="py-3 px-4">
                        <span className={`px-2 py-1 text-xs rounded-full ${
                          user.role === 'Admin' 
                            ? 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400'
                            : 'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400'
                        }`}>
                          {user.role === 'Admin' ? 'מנהל' : 'משתמש'}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span className={`px-2 py-1 text-xs rounded-full ${
                          user.is_active 
                            ? 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400'
                            : 'bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-400'
                        }`}>
                          {user.is_active ? 'פעיל' : 'לא פעיל'}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleEditUser(user)}
                            className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-sm font-medium px-3 py-1 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                            title="ערוך משתמש"
                          >
                            ערוך
                          </button>
                          <button
                            onClick={() => navigate(`/users/${user.id}/permissions`)}
                            className="text-purple-600 hover:text-purple-800 dark:text-purple-400 dark:hover:text-purple-300 text-sm font-medium px-3 py-1 rounded hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-colors"
                            title="ניהול הרשאות"
                          >
                            הרשאות
                          </button>
                          {user.id !== me.id && (
                            <button
                              onClick={() => setArchiveTarget({ id: user.id, full_name: user.full_name })}
                              className="text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300 text-sm font-medium px-3 py-1 rounded hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors whitespace-nowrap"
                              title="העבר משתמש לארכיון"
                            >
                              העבר לארכיון
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          )}

          {error && (
            <div className="mt-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
              <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
