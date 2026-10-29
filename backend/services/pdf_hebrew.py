"""Hebrew / RTL support for reportlab PDFs.

The font search order and the reshape + bidi handling follow the logic that
``ReportService`` inlines in its PDF generators (Heebo bundled with the app,
then the Linux fonts the Dockerfile installs, then Windows fonts), extracted
here as generic helpers for new PDF documents. ``ReportService`` is unchanged.

The font is registered under its own name so it never collides with the
``'Hebrew'`` font ``ReportService`` registers.
"""
from __future__ import annotations

import logging
import os
from functools import lru_cache

logger = logging.getLogger(__name__)

HEBREW_FONT_NAME = "HebrewShared"
FALLBACK_FONT_NAME = "Helvetica"

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_PROJECT_ROOT = os.path.dirname(_BACKEND_DIR)

_FONT_CANDIDATES: list[str] = [
    "/app/backend/static/fonts/Heebo-Regular.ttf",
    os.path.join(_BACKEND_DIR, "static", "fonts", "Heebo-Regular.ttf"),
    os.path.join(_PROJECT_ROOT, "backend", "static", "fonts", "Heebo-Regular.ttf"),
    "/usr/share/fonts/truetype/noto/NotoSansHebrew-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    r"C:\Windows\Fonts\arial.ttf",
    r"C:\Windows\Fonts\tahoma.ttf",
    r"C:\Windows\Fonts\arialuni.ttf",
]


# Characters a document needs besides Hebrew letters. Some Hebrew fonts (e.g.
# NotoSansHebrew, installed in the Docker image) hold only Hebrew glyphs, so
# digits, punctuation and Latin text silently disappear; such fonts are skipped.
REQUIRED_CHARS = "אבגדהוזחטיכלמנסעפצקרשתךםןףץ0123456789.,:;-–\"'()/%₪›#ABCabc "


def font_covers(font, chars: str = REQUIRED_CHARS) -> bool:
    """True when the reportlab TTFont has a glyph for every character."""
    cmap = font.face.charToGlyph
    return all(ord(c) in cmap for c in chars)


@lru_cache(maxsize=1)
def register_hebrew_font() -> str:
    """Registers the first available font that covers Hebrew together with
    digits, punctuation and the shekel sign (once per process) and returns its
    reportlab name, or Helvetica when none is found."""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    for path in _FONT_CANDIDATES:
        if not os.path.exists(path):
            continue
        try:
            font = TTFont(HEBREW_FONT_NAME, path)
        except Exception as exc:  # a broken / unsupported font file: try the next one
            logger.warning("Could not load font %s: %s", path, exc)
            continue
        if not font_covers(font):
            logger.info("Skipping font %s: missing digits / punctuation / Hebrew glyphs", path)
            continue
        pdfmetrics.registerFont(font)
        return HEBREW_FONT_NAME
    logger.warning("No font covering Hebrew, digits and ₪ found; PDF text may not render")
    return FALLBACK_FONT_NAME


@lru_cache(maxsize=1)
def _bidi():
    try:
        import arabic_reshaper
        from bidi.algorithm import get_display
        return arabic_reshaper.reshape, get_display
    except ImportError:
        logger.warning("arabic-reshaper / python-bidi unavailable; RTL text is not reordered")
        return None


def rtl(text) -> str:
    """Visual (display) order for mixed Hebrew / numeric text, as reportlab
    draws strings left-to-right."""
    if text is None:
        return ""
    text = str(text)
    if not text:
        return text
    helpers = _bidi()
    if helpers is None:
        return text
    reshape, get_display = helpers
    try:
        return get_display(reshape(text))
    except Exception:
        return text
