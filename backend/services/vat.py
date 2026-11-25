"""VAT (מע״מ) for collection amounts — the one place it is computed.

An amount is stored as entered (NUMERIC(12,2)) with two facts frozen beside it:
``vat_included`` (does the entered amount already include VAT?) and ``vat_rate``
(the rate in force when the amount was set, NUMERIC(5,4)). Both NULL = an amount
saved before VAT support: it is the amount to pay and no VAT breakdown is known.

Rule (per amount; a total is the sum of its rounded amounts; a negative amount —
a single task's reduction — mirrors the positive one):
- VAT excluded: vat = round_half_up(amount × rate);          to pay = amount + vat
- VAT included: vat = round_half_up(amount × rate / (1+rate)); to pay = amount
  (before VAT = amount − vat)

Rounding is to the agora, ROUND_HALF_UP. The arithmetic is exact: agorot (int) ×
rate in ten-thousandths (int), so Python, the SQL total (``gross_amount_sql``, the
same integers) and the frontend preview (``collectionUtils.vatBreakdown``, BigInt)
give identical results. Amounts are always positive here.

The current rate comes from ``settings.VAT_RATE`` only (the VAT_RATE environment
variable, required at startup). It is frozen on an amount when the amount or its
VAT choice is set; changing VAT_RATE later never changes a saved amount.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import BigInteger, Numeric, and_, case, cast, func, literal

from backend.core.config import settings

_CENT = Decimal("0.01")
_RATE_SCALE = 10_000  # vat_rate is NUMERIC(5,4)


def current_vat_rate() -> Decimal:
    """The rate in force now (VAT_RATE), e.g. Decimal('0.1800')."""
    return settings.VAT_RATE


@dataclass(frozen=True)
class VatBreakdown:
    """One amount. ``net``/``vat`` are None when the VAT facts are unknown."""
    net: Decimal | None
    vat: Decimal | None
    gross: Decimal

    @property
    def known(self) -> bool:
        return self.vat is not None


def _agorot(amount: Decimal) -> int:
    value = Decimal(amount) * 100
    if value != value.to_integral_value():
        raise ValueError(f"amount must have at most two decimal places: {amount}")
    return int(value)


def _rate_units(rate: Decimal) -> int:
    value = Decimal(rate) * _RATE_SCALE
    if value != value.to_integral_value() or not 0 <= value < _RATE_SCALE:
        raise ValueError(f"VAT rate must be 0 <= rate < 1 with at most four decimal places: {rate}")
    return int(value)


def _div_round_half_up(numerator: int, denominator: int) -> int:
    """round_half_up(numerator / denominator) for numerator >= 0, denominator > 0."""
    return (2 * numerator + denominator) // (2 * denominator)


def _money(agorot: int) -> Decimal:
    return (Decimal(agorot) / 100).quantize(_CENT)


def vat_breakdown(amount: Decimal, vat_included: bool | None, vat_rate: Decimal | None) -> VatBreakdown:
    """Before VAT / VAT / to pay of one amount (see the module rule).

    A negative amount (a single task's reduction) is the exact mirror of the
    positive one: the rule is applied to |amount| and the sign put back, so a
    reduction of X always cancels an addition of X with the same VAT choice."""
    if vat_included is None or vat_rate is None:
        return VatBreakdown(net=None, vat=None, gross=Decimal(amount).quantize(_CENT))
    agorot = _agorot(amount)
    sign, agorot = (-1 if agorot < 0 else 1), abs(agorot)
    units = _rate_units(vat_rate)
    if vat_included:
        vat = _div_round_half_up(agorot * units, _RATE_SCALE + units)
        net, gross = agorot - vat, agorot
    else:
        vat = _div_round_half_up(agorot * units, _RATE_SCALE)
        net, gross = agorot, agorot + vat
    return VatBreakdown(net=_money(sign * net), vat=_money(sign * vat), gross=_money(sign * gross))


def sum_breakdowns(parts: list[VatBreakdown]) -> VatBreakdown:
    """Totals of several amounts: the sum of each rounded amount. ``net``/``vat``
    are None as soon as one part has no known VAT (a partial breakdown would
    look complete); ``gross`` is always the exact sum."""
    gross = sum((p.gross for p in parts), Decimal("0.00"))
    if any(not p.known for p in parts):
        return VatBreakdown(net=None, vat=None, gross=gross)
    return VatBreakdown(
        net=sum((p.net for p in parts), Decimal("0.00")),
        vat=sum((p.vat for p in parts), Decimal("0.00")),
        gross=gross,
    )


def gross_amount_sql(amount, vat_included, vat_rate):
    """SQL "to pay" of one amount — the same rule as ``vat_breakdown(...).gross``.

    Only an amount saved WITHOUT VAT grows; an amount with VAT included, or with
    no VAT facts (NULL), is paid as stored. The VAT is computed in the same exact
    integers as Python — agorot × ten-thousandths, rounded half up by integer
    division — so it does not depend on a database's ROUND or on floating point
    (SQLite keeps NUMERIC as REAL). Max 2 × 999,999,999,999 × 9,999 < 2^63.
    A negative amount (a reduction) mirrors the positive one: the VAT of |amount|
    is computed and the sign put back (integer division never sees a negative).
    """
    agorot = cast(func.round(func.abs(amount) * 100), BigInteger)
    units = cast(func.round(vat_rate * _RATE_SCALE), BigInteger)
    vat_agorot = (agorot * units * 2 + _RATE_SCALE) // (_RATE_SCALE * 2)
    vat = vat_agorot * literal(_CENT, Numeric(12, 2))
    return case(
        (and_(vat_included.is_(False), amount < 0), amount - vat),
        (vat_included.is_(False), amount + vat),
        else_=amount,
    )
