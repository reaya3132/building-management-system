/**
 * A document opened from inside a dialog (e.g. the collection task's "קבצים" tab,
 * built on ModalOverlay) must show ABOVE that dialog, and closing it must return
 * to the dialog exactly as it was — the dialog stays open, its state kept.
 */
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import AttachmentView from '../AttachmentView'
import ModalOverlay from '../../ui/ModalOverlay'

vi.mock('../../../lib/api', () => ({
  default: { get: vi.fn(() => Promise.resolve({ data: new Blob() })) },
}))

const PDF_URL = 'https://example.test/uploads/report.pdf'

/** The numeric z-index of a `z-[N]` class on an element. */
function zOf(el: Element | null): number {
  const m = el?.className.toString().match(/\bz-\[(\d+)\]/)
  return m ? Number(m[1]) : NaN
}

const viewerOverlay = () => document.querySelector('iframe')?.closest('.fixed') ?? null
const dialogOverlay = () => screen.queryByTestId('dialog-body')?.closest('.fixed') ?? null

function DialogWithFile({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'details' | 'files'>('details')
  return (
    <ModalOverlay isOpen onClose={onClose}>
      <div data-testid="dialog-body">
        <button type="button" onClick={() => setTab('files')}>קבצים</button>
        <span data-testid="tab">{tab}</span>
        {tab === 'files' && <AttachmentView fileName="report.pdf" fileUrl={PDF_URL} />}
      </div>
    </ModalOverlay>
  )
}

async function openFromDialog() {
  const user = userEvent.setup()
  const onDialogClose = vi.fn()
  render(<DialogWithFile onClose={onDialogClose} />)
  await user.click(screen.getByRole('button', { name: 'קבצים' }))
  await user.click(screen.getByRole('button', { name: /report\.pdf/ }))
  await waitFor(() => expect(viewerOverlay()).not.toBeNull())
  return { user, onDialogClose }
}

describe('a document opened from inside a dialog', () => {
  it('shows above the dialog', async () => {
    await openFromDialog()
    expect(zOf(viewerOverlay())).toBeGreaterThan(zOf(dialogOverlay()))
  })

  it('Escape closes only the viewer; the dialog stays on the same tab', async () => {
    const { onDialogClose } = await openFromDialog()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(viewerOverlay()).toBeNull())
    expect(onDialogClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('tab')).toHaveTextContent('files')
  })

  it("a click on the viewer's backdrop closes only the viewer", async () => {
    const { user, onDialogClose } = await openFromDialog()
    await user.click(viewerOverlay() as HTMLElement)
    await waitFor(() => expect(viewerOverlay()).toBeNull())
    expect(onDialogClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('tab')).toHaveTextContent('files')
  })
})
