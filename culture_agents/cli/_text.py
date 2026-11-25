"""Make untrusted text safe to print on a terminal, one line at a time.

Task text, harness output, summaries, reasons and error messages come from a
run: a model working inside a sandbox wrote them. Printed as they are, an
escape sequence would act on the operator's terminal and a newline would break
the one-line-per-event format. :func:`visible` shows such characters instead of
sending them. Text mode only: ``--json`` output stays the exact data.
"""

from __future__ import annotations

import json
import re
from typing import Any

_NAMED = {"\n": "\\n", "\r": "\\r", "\t": "\\t"}

#: C0 controls, DEL, C1 controls, the two Unicode line breaks, lone surrogates
#: (which cannot be encoded to a terminal at all).
_UNSAFE = re.compile("[\x00-\x1f\x7f-\x9f  \ud800-\udfff]")


#: What ``json.dumps(ensure_ascii=False)`` leaves raw although a line reader or a
#: terminal treats it specially (DEL, C1, the Unicode line breaks) or it cannot
#: be encoded at all (a lone surrogate).
_JSON_RAW = re.compile("[\x7f-\x9f\u2028\u2029\ud800-\udfff]")


def _shown(match: re.Match[str]) -> str:
    char = match.group(0)
    if char in _NAMED:
        return _NAMED[char]
    code = ord(char)
    return f"\\x{code:02x}" if code <= 0xFF else f"\\u{code:04x}"


def visible(value: Any) -> str:
    """*value* as text with every control character shown, never sent.

    ``ESC`` becomes the four characters ``\\x1b``, a newline becomes ``\\n``.
    Ordinary Unicode, and a backslash already in the text, are left as they
    are, so the result is for reading and is not a reversible encoding.
    """
    return _UNSAFE.sub(_shown, value if isinstance(value, str) else str(value))


def json_line(payload: Any) -> str:
    """*payload* as JSON on exactly one line, for a stream of one object per line.

    The data is exact: the characters in :data:`_JSON_RAW` are written as JSON
    ``\\uXXXX`` escapes, which every JSON parser reads back as the same
    character, so no reader splits an object in two.
    """
    text = json.dumps(payload, ensure_ascii=False)
    return _JSON_RAW.sub(lambda match: f"\\u{ord(match.group(0)):04x}", text)
