#!/usr/bin/env python3
"""Best-effort lightweight HLS probe for Streamed/embed.st pages.

This avoids Chromium when the embed page exposes a literal or encoded HLS URL.
If the page only creates the HLS request from obfuscated runtime JavaScript,
the script exits 2 and Node falls back to Chromium.
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import re
import sys
import urllib.error
import urllib.request
from typing import Iterable


UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
)
HLS_RE = re.compile(r"https?://[^\"'\s<>\\]+?\.m3u8(?:\?[^\"'\s<>\\]*)?", re.I)
SOURCE_RE = re.compile(r"https?://embedhd\.org/source/streamed\.php\?[^\"'\s<>\\]+", re.I)
MAESTRO_RE = re.compile(r"(?:https?:)?//exposestrat\.com/maestrohd1\.php\?[^\"'\s<>\\]+", re.I)
FID_RE = re.compile(r"\bfid\s*=\s*[\"']([^\"']+)[\"']", re.I)
CHAR_ARRAY_RE = re.compile(r"return\s*\(\s*\[(?P<chars>(?:\s*[\"'][^\"']*[\"']\s*,?)+)\s*\]\.join\(\s*[\"']{2}\s*\)", re.I)
JS_STRING_RE = re.compile(r"[\"']([^\"']*)[\"']")
BASE64ISH_RE = re.compile(r"[A-Za-z0-9+/=_-]{32,}")


def fetch_text(url: str, timeout: float, referer: str = "https://streamed.pk/") -> str:
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer": referer,
            "User-Agent": UA,
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read(2_000_000).decode("utf-8", "ignore")


def absolute_url(url: str) -> str:
    if url.startswith("//"):
        return "https:" + url
    if url.startswith("http://") or url.startswith("https://"):
        return url
    return "https://" + url.lstrip("/")


def maybe_b64_decode(value: str) -> str | None:
    normalized = value.strip().replace("-", "+").replace("_", "/")
    normalized += "=" * (-len(normalized) % 4)
    try:
        decoded = base64.b64decode(normalized, validate=False)
    except Exception:
        return None
    if not decoded:
        return None
    text = decoded.decode("utf-8", "ignore")
    return text if ".m3u8" in text or "strmd" in text else None


def candidate_texts(text: str) -> Iterable[str]:
    yield text
    yield html.unescape(text)
    for token in BASE64ISH_RE.findall(text):
        decoded = maybe_b64_decode(token)
        if decoded:
            yield decoded


def find_hls(text: str) -> str | None:
    for candidate in candidate_texts(text):
        match = HLS_RE.search(candidate)
        if match:
            return html.unescape(match.group(0))
    return None


def find_char_array_hls(text: str) -> str | None:
    for match in CHAR_ARRAY_RE.finditer(text):
        joined = "".join(JS_STRING_RE.findall(match.group("chars"))).replace("\\/", "/")
        if ".m3u8" in joined and joined.startswith("http"):
            return html.unescape(joined)
    return None


def find_source_url(text: str) -> str | None:
    match = SOURCE_RE.search(html.unescape(text))
    return html.unescape(match.group(0)) if match else None


def find_maestro_url(text: str) -> str | None:
    direct = MAESTRO_RE.search(html.unescape(text))
    if direct:
        return absolute_url(html.unescape(direct.group(0)))
    fid = FID_RE.search(text)
    if fid:
        return f"https://exposestrat.com/maestrohd1.php?player=desktop&live={fid.group(1)}"
    return None


def resolve_hls(url: str, timeout: float) -> str | None:
    first = fetch_text(url, timeout, "https://streamed.pk/")
    hls_url = find_hls(first) or find_char_array_hls(first)
    if hls_url:
        return hls_url

    source_url = find_source_url(first)
    if not source_url:
        return None

    source = fetch_text(source_url, timeout, url)
    hls_url = find_hls(source) or find_char_array_hls(source)
    if hls_url:
        return hls_url

    maestro_url = find_maestro_url(source)
    if not maestro_url:
        return None

    maestro = fetch_text(maestro_url, timeout, source_url)
    return find_hls(maestro) or find_char_array_hls(maestro)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--timeout", type=float, default=2.5)
    args = parser.parse_args()

    try:
        hls_url = resolve_hls(args.url, args.timeout)
    except urllib.error.URLError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1

    if not hls_url:
        print(json.dumps({"ok": False, "error": "no hls found"}))
        return 2

    print(json.dumps({"ok": True, "url": hls_url}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
