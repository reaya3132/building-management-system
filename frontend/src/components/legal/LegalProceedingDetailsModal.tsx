import { useEffect, useState } from 'react'
import { formatILS } from '../collection/collectionUtils'
import { LegalAPI, type ContactSummary, type LegalProceedingDetail } from '../../lib/legalApi'
import LegalModal from './LegalModal'
import { PARTY_ROLE_LABELS, STAGE_STATUS_LABELS, STATUS_LABELS, formatDate, legalErrorMessage } from './legalUtils'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="text-gray-900 dark:text-white text-left">{children}</dd>
    </div>
  )
}

function ContactBlock({ title, contact }: { title: string; contact: ContactSummary }) {
  return (
    <section>
      <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">{title}</h3>
      <div className="font-medium text-sm text-gray-900 dark:text-white">{contact.name}</div>
      <div className="text-xs text-gray-500 dark:text-gray-400">
        {[contact.phone, contact.phone_2, contact.email, contact.address].filter(Boolean).join(' · ')}
      </div>
    </section>
  )
}

/** Read-only summary of one proceeding. */
export default function LegalProceedingDetailsModal({ proceedingId, onClose }: { proceedingId: number | null; onClose: () => void }) {
  const [detail, setDetail] = useState<LegalProceedingDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (proceedingId === null) return
    let cancelled = false
    setDetail(null)
    setError(null)
    LegalAPI.get(proceedingId)
      .then((data) => { if (!cancelled) setDetail(data) })
      .catch((e) => { if (!cancelled) setError(legalErrorMessage(e, 'טעינת ההליך נכשלה.')) })
    return () => { cancelled = true }
  }, [proceedingId])

  return (
    <LegalModal isOpen={proceedingId !== null} onClose={onClose} title={detail?.title ?? 'פרטי הליך'} subtitle={proceedingId ? `הליך #${proceedingId}` : undefined}>
      {error && <div role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</div>}
      {!detail && !error && <p className="text-sm text-gray-500">טוען...</p>}
      {detail && (
        <div className="space-y-4">
          <ContactBlock title={PARTY_ROLE_LABELS[detail.party_role]} contact={detail.contact} />
          {detail.linked_landlord && <ContactBlock title="בעל הדירה המשויך" contact={detail.linked_landlord} />}
          <dl className="divide-y divide-gray-100 dark:divide-gray-800">
            <Row label="סטטוס">{STATUS_LABELS[detail.status]}</Row>
            <Row label="מספר דירה">{detail.apartment_number}</Row>
            <Row label="פרויקט">{detail.project?.name ?? '—'}</Row>
            <Row label="סכום תביעה">{detail.claim_amount ? formatILS(detail.claim_amount) : '—'}</Row>
            <Row label="נפתח">{formatDate(detail.opened_at)}</Row>
            {detail.closed_at && <Row label="נסגר">{formatDate(detail.closed_at)}</Row>}
            {detail.close_reason && <Row label="סיבת סגירה">{detail.close_reason}</Row>}
          </dl>
          {detail.claim_details && <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{detail.claim_details}</p>}
          <section>
            <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">שלבים</h3>
            <ol className="divide-y divide-gray-100 dark:divide-gray-800">
              {detail.stages.map((stage) => (
                <li key={stage.key} className="flex justify-between gap-3 py-1.5 text-sm">
                  <span className="text-gray-900 dark:text-white">{stage.position}. {stage.label}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{STAGE_STATUS_LABELS[stage.status]}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </LegalModal>
  )
}
