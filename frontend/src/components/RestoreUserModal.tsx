import Modal from './Modal'

interface RestoreUserModalProps {
  open: boolean
  userName: string
  onClose: () => void
  onConfirm: () => void
  loading?: boolean
}

export default function RestoreUserModal({
  open,
  userName,
  onClose,
  onConfirm,
  loading = false
}: RestoreUserModalProps) {
  return (
    <Modal
      open={open}
      onClose={loading ? () => {} : onClose}
      title="שחזור משתמש מהארכיון"
    >
      <div className="space-y-4">
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4 space-y-1">
          <p className="text-green-900 dark:text-green-200 font-semibold">
            האם לשחזר את המשתמש {userName} מהארכיון?
          </p>
          <p className="text-green-800 dark:text-green-300 text-sm">
            המשתמש יוכל להתחבר שוב למערכת, וההרשאות שהיו לו לפני ההעברה לארכיון ישוחזרו.
          </p>
          <p className="text-green-800 dark:text-green-300 text-sm">
            הרשאות לישויות שנמחקו בינתיים לא ישוחזרו.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors disabled:opacity-50"
            disabled={loading}
          >
            ביטול
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'משחזר...' : 'אישור שחזור'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
