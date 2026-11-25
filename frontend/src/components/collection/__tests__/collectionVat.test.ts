/**
 * The frontend VAT preview must equal backend/services/vat.py exactly — the same
 * cases as backend/tests/test_collection_vat.py::TestVatBreakdown.
 */
import { describe, expect, it } from 'vitest'
import { agorotToAmount, formatVatRate, vatBreakdown, vatChoiceLabel } from '../collectionUtils'
import { statementFromDraft, type DraftLine } from '../StatementExportModal'
import { describeCollectionEvent } from '../CollectionHistory'
import type { CollectionAuditEntry } from '../../../lib/collectionApi'

const money = (p: ReturnType<typeof vatBreakdown>) =>
  p && [p.netAgorot == null ? null : agorotToAmount(p.netAgorot), p.vatAgorot == null ? null : agorotToAmount(p.vatAgorot), agorotToAmount(p.grossAgorot)]

describe('vatBreakdown (mirror of the server rule)', () => {
  it('matches the spec example', () => {
    expect(money(vatBreakdown('1000.00', false, '0.18'))).toEqual(['1000.00', '180.00', '1180.00'])
    expect(money(vatBreakdown('1000.00', true, '0.18'))).toEqual(['847.46', '152.54', '1000.00'])
  })

  it.each([
    ['0.25', false, '0.18', '0.25', '0.05', '0.30'],
    ['0.25', false, '0.1800', '0.25', '0.05', '0.30'],
    ['0.24', false, '0.18', '0.24', '0.04', '0.28'],
    ['0.01', false, '0.18', '0.01', '0.00', '0.01'],
    ['0.01', true, '0.18', '0.01', '0.00', '0.01'],
    ['1000.25', false, '0.18', '1000.25', '180.05', '1180.30'],
    ['118.00', true, '0.18', '100.00', '18.00', '118.00'],
    ['1000.00', false, '0.1750', '1000.00', '175.00', '1175.00'],
    ['33.33', true, '0.1750', '28.37', '4.96', '33.33'],
    ['99.99', false, '0', '99.99', '0.00', '99.99'],
    ['99.99', true, '0.0000', '99.99', '0.00', '99.99'],
    ['9999999999.99', false, '0.18', '9999999999.99', '1800000000.00', '11799999999.99'],
  ] as const)('%s, included=%s, rate %s', (amount, included, rate, net, vat, gross) => {
    expect(money(vatBreakdown(amount, included, rate))).toEqual([net, vat, gross])
  })

  it('net + vat = gross for many amounts', () => {
    for (let agorot = 1; agorot <= 5000; agorot += 7) {
      for (const included of [true, false]) {
        const p = vatBreakdown(agorotToAmount(agorot), included, '0.18')!
        expect(p.netAgorot! + p.vatAgorot!).toBe(p.grossAgorot)
        expect(p.grossAgorot).toBe(included ? agorot : agorot + p.vatAgorot!)
      }
    }
  })

  it('has no breakdown without VAT facts, and rejects bad input', () => {
    expect(money(vatBreakdown('50.00', null, null))).toEqual([null, null, '50.00'])
    expect(vatBreakdown('abc', true, '0.18')).toBeNull()
    expect(vatBreakdown('10.00', true, '1')).toBeNull()
    expect(vatBreakdown('10.00', true, '0.18001')).toBeNull()
  })

  it('formats rates and choices', () => {
    expect(formatVatRate('0.1800')).toBe('18%')
    expect(formatVatRate('0.1750')).toBe('17.5%')
    expect(formatVatRate(null)).toBe('')
    expect(vatChoiceLabel(true)).toBe('כולל מע״מ')
    expect(vatChoiceLabel(false)).toBe('+ מע״מ')
    expect(vatChoiceLabel(null)).toBe('')
  })
})

describe('statementFromDraft with VAT', () => {
  const line = (over: Partial<DraftLine>): DraftLine => ({ key: 'k', include: true, subject: 's', amount: '1000.00', ...over })

  it('totals each line to pay, using the frozen rate or the current one for new lines', () => {
    const result = statementFromDraft([
      line({ key: 'a', itemId: 1, vatIncluded: false, vatRate: '0.1800' }),
      line({ key: 'b', itemId: 2, vatIncluded: true, vatRate: '0.1800' }),
      line({ key: 'c', amount: '100.00', vatIncluded: false }),
    ], '0.2000')
    expect(result.totalAgorot).toBe(230000)
    expect(result.lines).toEqual([
      { subject: 's', amount: '1000.00', item_id: 1, vat_included: false },
      { subject: 's', amount: '1000.00', item_id: 2, vat_included: true },
      { subject: 's', amount: '100.00', vat_included: false },
    ])
  })

  it('sends no choice for an old item, which counts as stored', () => {
    const result = statementFromDraft([line({ itemId: 3, vatIncluded: null, vatRate: null, amount: '250.00' })], '0.18')
    expect(result.lines).toEqual([{ subject: 's', amount: '250.00', item_id: 3 }])
    expect(result.totalAgorot).toBe(25000)
  })
})


describe('vatBreakdown for reductions (negative adjustments)', () => {
  it.each([
    ['-100.00', false, '-118.00'],
    ['-100.00', true, '-100.00'],
    ['-0.25', false, '-0.30'],
    ['-1000.25', false, '-1180.30'],
    ['-20.00', null, '-20.00'],
  ] as const)('%s, included=%s → %s to pay', (amount, included, gross) => {
    const p = vatBreakdown(amount, included, included === null ? null : '0.18')!
    expect(agorotToAmount(p.grossAgorot)).toBe(gross)
  })

  it('mirrors the addition exactly', () => {
    for (let agorot = 1; agorot <= 3000; agorot += 7) {
      for (const included of [true, false]) {
        const plus = vatBreakdown(agorotToAmount(agorot), included, '0.18')!
        const minus = vatBreakdown(agorotToAmount(-agorot), included, '0.18')!
        expect(minus.grossAgorot).toBe(-plus.grossAgorot)
      }
    }
  })
})

describe('history of VAT amounts', () => {
  const entry = (action: string, details: Record<string, unknown>) =>
    ({ id: 1, action, details, created_at: '' }) as CollectionAuditEntry

  it('shows amounts to pay with their label and no rate or breakdown', () => {
    const added = describeCollectionEvent(entry('adjustment_added', {
      after: { amount: '100.00', note: 'קנס', vat_included: false, vat_rate: '0.1800' },
    }))!
    // formatILS (he-IL) writes the ₪ after the number, with direction marks.
    expect(added).toMatch(/^תוספת .*118\.00.* ללא מע״מ · קנס$/)
    const reduced = describeCollectionEvent(entry('adjustment_added', {
      after: { amount: '-100.00', note: 'הנחה', vat_included: false, vat_rate: '0.1800' },
    }))!
    expect(reduced).toMatch(/^הפחתה .*118\.00.* ללא מע״מ · הנחה$/)
    const changed = describeCollectionEvent(entry('adjustment_vat_changed', {
      before: { amount: '100.00', vat_included: true, vat_rate: '0.1800' },
      after: { amount: '100.00', vat_included: false, vat_rate: '0.1800' },
    }))!
    expect(changed).toMatch(/100\.00.* כולל מע״מ ← .*118\.00.* ללא מע״מ/)
    const item = describeCollectionEvent(entry('ledger_item_added', {
      after: { subject: 'ועד', amount: '1000.00', vat_included: false, vat_rate: '0.1800' },
    }))!
    expect(item).toMatch(/1,180\.00.* כולל מע״מ/)
    for (const text of [added, reduced, changed, item]) expect(text).not.toMatch(/18%|לפני מע״מ/)
  })

  it('shows an entry written before VAT support as stored, unlabelled', () => {
    const old = describeCollectionEvent(entry('adjustment_added', { after: { amount: '50.00', note: 'ישן' } }))!
    expect(old).toMatch(/^תוספת .*50\.00.* · ישן$/)
    expect(old).not.toMatch(/מע״מ/)
  })
})
