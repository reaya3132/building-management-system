import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface ModalOverlayProps {
  isOpen: boolean
  onClose: () => void
  children: React.ReactNode
  /** Max width class, e.g. "max-w-md", "max-w-lg", "max-w-2xl" */
  maxWidth?: string
  /** Border color class for the modal card */
  borderColor?: string
  /** Z-index class */
  zIndex?: string
  /** When false, clicking the backdrop does not close the modal. Defaults to true. */
  closeOnBackdropClick?: boolean
}

/**
 * Reusable animated modal overlay with backdrop blur.
 * Handles backdrop click-to-close, animation, and consistent styling.
 */
const ModalOverlay: React.FC<ModalOverlayProps> = ({
  isOpen,
  onClose,
  children,
  maxWidth = 'max-w-md',
  borderColor = 'border-gray-200 dark:border-gray-700',
  zIndex = 'z-[70]',
  closeOnBackdropClick = true,
}) => {
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="modal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className={`fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center ${zIndex} p-4`}
          onClick={closeOnBackdropClick ? onClose : undefined}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className={`bg-white dark:bg-gray-800 rounded-2xl shadow-2xl ${maxWidth} w-full overflow-hidden border ${borderColor}`}
            onClick={e => e.stopPropagation()}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default ModalOverlay
