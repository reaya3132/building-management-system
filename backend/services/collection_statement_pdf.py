"""PDF statement for a ledger (כרטסת) collection task.

Holds exactly: the billing month and year, the project, a table of the
document's items and their total. Pure rendering — no database access; the
caller decides which items go in (see the statement endpoint).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from io import BytesIO

from backend.services.pdf_hebrew import register_hebrew_font, rtl

HEBREW_MONTHS = (
    "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
    "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
)

_TEXT = "#1F2937"
_MUTED = "#6B7280"
_HEADER_BG = "#ECFDF5"
_ACCENT = "#047857"
_GRID = "#E5E7EB"


@dataclass(frozen=True)
class StatementLine:
    subject: str
    amount: Decimal


def format_month(month: date) -> str:
    return f"{HEBREW_MONTHS[month.month - 1]} {month.year}"


def format_ils(amount: Decimal) -> str:
    # Left-to-right number with the shekel sign, as shown in the app.
    return f"₪{amount:,.2f}"


def render_statement_pdf(*, billing_month: date, project: str, lines: list[StatementLine], total: Decimal) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    font = register_hebrew_font()

    def style(name, size, align, color=_TEXT, leading=None):
        return ParagraphStyle(name, fontName=font, fontSize=size, alignment=align,
                              textColor=colors.HexColor(color), leading=leading or size * 1.35)

    title = style("title", 18, TA_RIGHT, _ACCENT)
    meta_label = style("metaLabel", 9, TA_RIGHT, _MUTED)
    meta_value = style("metaValue", 12, TA_RIGHT)
    cell = style("cell", 10, TA_RIGHT)
    number = style("number", 10, TA_LEFT)
    head = style("head", 10, TA_RIGHT, _ACCENT)
    head_number = style("headNumber", 10, TA_LEFT, _ACCENT)
    index = style("index", 9, TA_CENTER, _MUTED)

    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
                            topMargin=18 * mm, bottomMargin=18 * mm,
                            title="Collection statement")
    width = doc.width

    # Meta block: two right-aligned columns (month | project), RTL order.
    meta = Table(
        [[Paragraph(rtl("פרויקט"), meta_label), Paragraph(rtl("חודש חיוב"), meta_label)],
         [Paragraph(rtl(project), meta_value), Paragraph(rtl(format_month(billing_month)), meta_value)]],
        colWidths=[width * 0.6, width * 0.4],
    )
    meta.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                              ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))

    # Item table. reportlab lays columns out left to right, so the visual
    # right-to-left order is amount | subject | #.
    rows = [[Paragraph(rtl("סכום"), head_number), Paragraph(rtl("נושא"), head), Paragraph("#", index)]]
    for i, line in enumerate(lines, start=1):
        rows.append([Paragraph(format_ils(line.amount), number), Paragraph(rtl(line.subject), cell),
                     Paragraph(str(i), index)])
    rows.append([Paragraph(format_ils(total), head_number), Paragraph(rtl('סה"כ'), head), ""])

    table = Table(rows, colWidths=[width * 0.25, width * 0.65, width * 0.10], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(_HEADER_BG)),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor(_HEADER_BG)),
        ("LINEBELOW", (0, 0), (-1, -2), 0.5, colors.HexColor(_GRID)),
        ("LINEABOVE", (0, -1), (-1, -1), 1, colors.HexColor(_ACCENT)),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))

    elements = [Paragraph(rtl("כרטסת גבייה"), title), Spacer(1, 6 * mm), meta, Spacer(1, 8 * mm), table]
    if not lines:
        elements += [Spacer(1, 4 * mm), Paragraph(rtl("אין פריטים במסמך"), meta_label)]
    doc.build(elements)
    return buffer.getvalue()
