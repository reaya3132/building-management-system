import Modal from './Modal'

interface ArchiveUserModalProps {
  open: boolean
  userName: string
  onClose: () => void
  onConfirm: () => void
  loading?: boolean
}

export default function ArchiveUserModal({
  open,
  userName,
  onClose,
  onConfirm,
  loading = false
}: ArchiveUserModalProps) {
  return (
    <Modal
      open={open}
      onClose={loading ? () => {} : onClose}
      title="העברת משתמש לארכיון"
    >
      <div className="space-y-4">
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4 space-y-1">
          <p className="text-amber-900 dark:text-amber-200 font-semibold">
            האם להעביר את המשתמש {userName} לארכיון?
          </p>
          <p className="text-amber-800 dark:text-amber-300 text-sm">
            המשתמש לא יוכל להתחבר למערכת וכל הרשאותיו יבוטלו.
          </p>
          <p className="text-amber-800 dark:text-amber-300 text-sm">
            פרטיו ונתוניו יישמרו.
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
            className="flex-1 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'מעביר לארכיון...' : 'אישור העברה לארכיון'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
