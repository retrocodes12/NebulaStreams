#!/usr/bin/env python3
"""Small Scrapling sidecar for NebulaStreams.

Keeps Python scraping/browser deps outside Node request path. If Scrapling is
not installed, falls back to urllib so main addon still works.
"""

from __future__ import annotations

import json
import os
import re
import signal
import sys
import time
from html import unescape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import quote_plus, urljoin, urlparse
from urllib.request import Request, urlopen

try:
    from scrapling.fetchers import Fetcher, StealthyFetcher  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    Fetcher = None
    StealthyFetcher = None


PORT = int(os.environ.get("SCRAPLING_SERVICE_PORT", "8787"))
TMDB_API_KEY = os.environ.get("TMDB_API_KEY", "439c478a771f35c05022f9feabcca01c")
TIMEOUT_SECONDS = float(os.environ.get("SCRAPLING_FETCH_TIMEOUT_SECONDS", "8"))
USER_AGENT = os.environ.get(
    "SCRAPLING_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
)


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True

HDHUB4U_DOMAINS = [
    "https://new1.hdhub4u.limo",
    "https://new3.hdhub4u.fo",
    "https://new4.hdhub4u.fo",
    "https://new5.hdhub4u.fo",
    "https://hdhub4u.cv",
    "https://hdhub4u.tv",
    "https://hdhub4u.com",
    "https://hdhub4u.global",
]

FOURKHDHUB_DOMAINS = [
    "https://4khdhub.link",
    "https://4khdhub.fans",
    "https://4khdhub.click",
]

UHDMOVIES_DOMAINS = [
    "https://uhdmovies.rip",
    "https://uhdmovies.pink",
]

STREAM_HOST_PATTERNS = [
    "hubcloud",
    "hubcdn",
    "hubdrive",
    "pixeldrain",
    "streamtape",
    "hdstream",
    "hblinks",
    "hubstream",
    "gdflix",
    "gofile",
    "workers.dev",
    "10gbps",
    "fastdl",
    "m3u8",
    "mp4",
    "mkv",
]

HDHUB4U_SEARCH_API = "https://search.hdhub4u.glass/collections/post/documents/search"

FOLLOW_LINK_PATTERNS = [
    "download",
    "hubcloud",
    "hubcdn",
    "hblinks",
    "gdflix",
    "links",
    "server",
    "watch",
]


def compact_text(value: str) -> str:
    return re.sub(r"\s+", " ", unescape(value or "")).strip()


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def fetch_text(url: str, *, stealth: bool = False) -> tuple[str, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": f"{urlparse(url).scheme}://{urlparse(url).netloc}/",
    }

    if stealth and StealthyFetcher is not None:
        page = StealthyFetcher.fetch(
            url,
            headless=True,
            network_idle=False,
            disable_resources=True,
            timeout=int(TIMEOUT_SECONDS * 1000),
        )
        return str(page.body.decode("utf-8", "ignore") if isinstance(page.body, bytes) else page.body), str(getattr(page, "url", url))

    if Fetcher is not None:
        page = Fetcher.get(url, headers=headers, timeout=int(TIMEOUT_SECONDS * 1000))
        body = page.body.decode("utf-8", "ignore") if isinstance(page.body, bytes) else str(page.body)
        return body, str(getattr(page, "url", url))

    request = Request(url, headers=headers)
    with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return response.read().decode("utf-8", "ignore"), response.geturl()


def fetch_text_post(url: str, data: dict[str, str], *, referer: str | None = None, extra_headers: dict[str, str] | None = None) -> tuple[str, str]:
    body = "&".join(f"{quote_plus(str(key))}={quote_plus(str(value))}" for key, value in data.items()).encode("utf-8")
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    if referer:
        headers["Referer"] = referer
    if extra_headers:
        headers.update(extra_headers)
    request = Request(url, data=body, headers=headers)
    with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return response.read().decode("utf-8", "ignore"), response.geturl()


def tmdb_details(tmdb_id: int, media_type: str) -> dict[str, Any]:
    endpoint = "tv" if media_type in {"tv", "series"} else "movie"
    url = f"https://api.themoviedb.org/3/{endpoint}/{tmdb_id}?api_key={TMDB_API_KEY}&append_to_response=external_ids"
    body, _ = fetch_text(url)
    data = json.loads(body)
    title = data.get("name") if endpoint == "tv" else data.get("title")
    date = data.get("first_air_date") if endpoint == "tv" else data.get("release_date")
    return {
        "title": title or data.get("original_title") or data.get("original_name") or "",
        "year": int(str(date or "0")[:4] or 0),
        "imdb_id": (data.get("external_ids") or {}).get("imdb_id") or data.get("imdb_id") or "",
    }


def extract_links(html: str, base_url: str) -> list[dict[str, str]]:
    links: list[dict[str, str]] = []
    pattern = re.compile(r"<a\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", re.I | re.S)
    for href, label_html in pattern.findall(html or ""):
        href = unescape(href).strip()
        if not href or href.startswith("#") or href.lower().startswith(("javascript:", "mailto:")):
            continue
        label = compact_text(re.sub(r"<[^>]+>", " ", label_html))
        links.append({"url": urljoin(base_url, href), "label": label})
    return links


def extract_form_action(html: str) -> str | None:
    match = re.search(r"<form[^>]*action=[\"']([^\"']+)", html or "", re.I)
    return unescape(match.group(1)).strip() if match else None


def extract_form_inputs(html: str) -> dict[str, str]:
    inputs: dict[str, str] = {}
    for tag in re.findall(r"<input[^>]+>", html or "", re.I):
        name = re.search(r"name=[\"']([^\"']+)", tag, re.I)
        value = re.search(r"value=[\"']([^\"']*)", tag, re.I)
        if name:
            inputs[unescape(name.group(1))] = unescape(value.group(1)) if value else ""
    return inputs


def extract_meta_refresh_url(html: str) -> str | None:
    match = re.search(r"<meta[^>]*http-equiv=[\"']?refresh[\"']?[^>]*content=[\"'][^\"']*url=([^\"'>]+)", html or "", re.I)
    return unescape(match.group(1)).strip() if match else None


def link_score(link: dict[str, str], title: str, year: int, season: int | None = None) -> int:
    text = slug(f"{link.get('label', '')} {link.get('url', '')}")
    title_words = [word for word in slug(title).split() if len(word) > 2]
    score = sum(10 for word in title_words if word in text)
    if year and str(year) in text:
        score += 12
    if season and (f"season {season}" in text or f"s{season:02d}" in text or f"s{season}" in text):
        score += 10
    if any(token in text for token in ["hindi", "multi", "dual", "web dl", "bluray", "download"]):
        score += 4
    return score


def title_word_hits(link: dict[str, str], title: str) -> int:
    text = slug(f"{link.get('label', '')} {link.get('url', '')}")
    title_words = [word for word in slug(title).split() if len(word) > 2]
    return sum(1 for word in title_words if word in text)


def is_streamish(url: str, label: str = "") -> bool:
    raw = f"{url} {label}".lower()
    return any(token in raw for token in STREAM_HOST_PATTERNS)


def should_follow(url: str, label: str = "") -> bool:
    raw = f"{url} {label}".lower()
    if "how-to-download" in raw or "download-tutorial" in raw:
        return False
    return any(token in raw for token in FOLLOW_LINK_PATTERNS)


def is_hubcloud_wrapper(url: str) -> bool:
    try:
        host = urlparse(url).hostname or ""
    except Exception:
        host = ""
    return "hubcloud" in host.lower()


def quality_from_text(text: str) -> str:
    match = re.search(r"\b(2160p|4k|1440p|1080p|720p|480p|360p)\b", text or "", re.I)
    if not match:
        return "Unknown"
    value = match.group(1).lower()
    return "2160p" if value == "4k" else value


def size_from_text(text: str) -> str | None:
    match = re.search(r"\b(\d+(?:\.\d+)?)\s*(GB|MB)\b", text or "", re.I)
    return f"{match.group(1)} {match.group(2).upper()}" if match else None


def make_stream(url: str, title: str, provider: str, source: str, referer: str) -> dict[str, Any]:
    stream = {
        "url": url,
        "title": title,
        "quality": quality_from_text(f"{title} {url}"),
        "source": source,
        "provider": provider,
        "headers": {"Referer": referer, "User-Agent": USER_AGENT},
    }
    size = size_from_text(title)
    if size:
        stream["size"] = size
    return stream


def dedupe_streams(streams: list[dict[str, Any]], limit: int = 25) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    for stream in streams:
        url = str(stream.get("url") or "")
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        deduped.append(stream)
    return deduped[:limit]


def scrape_hdhub4u(payload: dict[str, Any]) -> list[dict[str, Any]]:
    tmdb_id = int(payload.get("tmdbId") or 0)
    media_type = str(payload.get("mediaType") or "movie").lower()
    season = payload.get("season")
    episode = payload.get("episode")
    season_int = int(season) if str(season or "").isdigit() else None
    details = tmdb_details(tmdb_id, media_type)
    title = details["title"]
    year = details["year"]

    queries = [f"{title} {year}".strip(), title]
    if media_type in {"tv", "series"} and season_int:
        queries.insert(0, f"{title} Season {season_int}")

    post_links: list[dict[str, str]] = []
    for query in queries:
        try:
            api_url = (
                f"{HDHUB4U_SEARCH_API}?q={quote_plus(query)}"
                "&query_by=post_title,category,stars,director,imdb_id"
                "&query_by_weights=4,2,2,2,4&sort_by=sort_by_date:desc"
                "&limit=8&highlight_fields=none&use_cache=true&page=1"
            )
            data = json.loads(fetch_text(api_url)[0])
            for hit in data.get("hits", []):
                doc = hit.get("document") or {}
                permalink = str(doc.get("permalink") or "")
                post_title = compact_text(str(doc.get("post_title") or ""))
                if not permalink:
                    continue
                url = permalink if permalink.startswith("http") else urljoin(HDHUB4U_DOMAINS[0], permalink)
                candidate = {"url": url, "label": post_title}
                if link_score(candidate, title, year, season_int) > 0:
                    post_links.append(candidate)
        except Exception:
            continue

    if not post_links:
        for domain in HDHUB4U_DOMAINS[:2]:
            for query in queries[:1]:
                try:
                    html, final_url = fetch_text(f"{domain}/search.html?q={quote_plus(query)}")
                except Exception:
                    continue
                candidates = extract_links(html, final_url)
                ranked = sorted(
                    (link for link in candidates if link_score(link, title, year, season_int) > 0),
                    key=lambda item: link_score(item, title, year, season_int),
                    reverse=True,
                )
                post_links.extend(ranked[:4])
            if post_links:
                break

    seen_pages: set[str] = set()
    stream_links: list[dict[str, Any]] = []

    def visit(url: str, label: str, depth: int) -> None:
        if len(stream_links) >= 30 or depth > 2 or url in seen_pages:
            return
        seen_pages.add(url)
        if is_streamish(url, label):
            stream_links.append(make_stream(
                url,
                label or title,
                "scrapling-hdhub4u",
                "Scrapling HDHub4u",
                f"{urlparse(url).scheme}://{urlparse(url).netloc}/",
            ))
            return
        try:
            html, final_url = fetch_text(url, stealth=False)
        except Exception:
            return
        for link in extract_links(html, final_url):
            if is_streamish(link["url"], link["label"]):
                stream_links.append(make_stream(
                    link["url"],
                    link["label"] or label or title,
                    "scrapling-hdhub4u",
                    "Scrapling HDHub4u",
                    final_url,
                ))
            elif should_follow(link["url"], link["label"]):
                visit(link["url"], link["label"], depth + 1)

    for post in post_links[:6]:
        visit(post["url"], post["label"], 0)

    return dedupe_streams(stream_links)


def scrape_4khdhub(payload: dict[str, Any]) -> list[dict[str, Any]]:
    tmdb_id = int(payload.get("tmdbId") or 0)
    media_type = str(payload.get("mediaType") or "movie").lower()
    season = payload.get("season")
    season_int = int(season) if str(season or "").isdigit() else None
    details = tmdb_details(tmdb_id, media_type)
    title = details["title"]
    year = details["year"]

    queries = [f"{title} {year}".strip(), title]
    if media_type in {"tv", "series"} and season_int:
        queries.insert(0, f"{title} Season {season_int}")

    post_links: list[dict[str, str]] = []
    for domain in FOURKHDHUB_DOMAINS:
        for query in queries:
            try:
                html, final_url = fetch_text(f"{domain}/?s={quote_plus(query)}")
            except Exception:
                continue
            candidates = extract_links(html, final_url)
            ranked = sorted(
                (
                    link for link in candidates
                    if "/category/" not in link["url"]
                    and title_word_hits(link, title) > 0
                    and link_score(link, title, year, season_int) > 0
                ),
                key=lambda item: link_score(item, title, year, season_int),
                reverse=True,
            )
            post_links.extend(ranked[:3])
        if post_links:
            break

    streams: list[dict[str, Any]] = []
    for post in post_links[:4]:
        try:
            html, final_url = fetch_text(post["url"])
        except Exception:
            continue
        blocks = re.findall(r'<div class="download-item\b[\s\S]*?(?=<div class="download-item\b|<script\b|</main>)', html or "", re.I)
        if not blocks:
            blocks = [html]
        for block in blocks:
            file_title_match = re.search(r'<div class="file-title">([\s\S]*?)</div>', block, re.I)
            file_title = compact_text(re.sub(r"<[^>]+>", " ", file_title_match.group(1))) if file_title_match else post["label"]
            header_match = re.search(r'<div class="flex-1[^>]*>([\s\S]*?)</div>', block, re.I)
            header_title = compact_text(re.sub(r"<[^>]+>", " ", header_match.group(1))) if header_match else ""
            stream_title = compact_text(file_title or header_title or post["label"])
            block_links = [
                link for link in extract_links(block, final_url)
                if is_streamish(link["url"], link["label"])
            ]
            if any(not is_hubcloud_wrapper(link["url"]) for link in block_links):
                block_links = [
                    link for link in block_links
                    if not is_hubcloud_wrapper(link["url"])
                ]
            for link in block_links:
                if not is_streamish(link["url"], link["label"]):
                    continue
                streams.append(make_stream(
                    link["url"],
                    stream_title,
                    "scrapling-4khdhub",
                    "Scrapling 4KHDHub",
                    final_url,
                ))

    return dedupe_streams(streams)


def uhdmovies_search_posts(title: str, year: int) -> list[dict[str, str]]:
    posts: list[dict[str, str]] = []
    for domain in UHDMOVIES_DOMAINS:
        try:
            html, final_url = fetch_text(f"{domain}/?s={quote_plus(f'{title} {year}'.strip())}")
        except Exception:
            continue
        for link in extract_links(html, final_url):
            if "uhdmovies" not in urlparse(link["url"]).hostname.lower():
                continue
            if title_word_hits(link, title) <= 0:
                continue
            score = link_score(link, title, year)
            if score <= 0:
                continue
            posts.append({"url": link["url"], "label": link["label"], "score": str(score)})
        if posts:
            break
    posts.sort(key=lambda item: int(item.get("score") or "0"), reverse=True)
    seen: set[str] = set()
    deduped: list[dict[str, str]] = []
    for post in posts:
        if post["url"] in seen:
            continue
        seen.add(post["url"])
        deduped.append(post)
    return deduped[:3]


def uhdmovies_post_source_links(post_url: str) -> list[dict[str, str]]:
    try:
        html, final_url = fetch_text(post_url)
    except Exception:
        return []
    links: list[dict[str, str]] = []
    anchor_pattern = re.compile(r"<a\b([^>]*)href=[\"']([^\"']+)[\"']([^>]*)>([\s\S]*?)</a>", re.I)
    for match in anchor_pattern.finditer(html or ""):
        attrs = f"{match.group(1)} {match.group(3)}"
        href = unescape(match.group(2)).strip()
        label = compact_text(re.sub(r"<[^>]+>", " ", match.group(4)))
        raw = f"{href} {label} {attrs}".lower()
        if "cloud.unblockedgames.world" not in raw or "maxbutton" not in raw:
            continue
        if not any(token in raw for token in ("download", "g-drive", "drive")):
            continue
        links.append({"url": urljoin(final_url, href), "label": label})
    return links[:8]


def uhdmovies_bypass_unblocked(url: str) -> str | None:
    try:
        html, final_url = fetch_text(url)
        form_action = extract_form_action(html)
        form_data = extract_form_inputs(html)
        if not form_action or not form_data:
            return None

        html, final_url = fetch_text_post(form_action, form_data, referer=final_url)
        form_action = extract_form_action(html)
        form_data = extract_form_inputs(html)
        wp_http2 = form_data.get("_wp_http2", "")
        if not form_action or not form_data:
            return None

        html, final_url = fetch_text_post(form_action, form_data, referer=final_url)
        go_match = re.search(r"\?go=([^\"'&<]+)", html or "", re.I)
        if not go_match:
            return extract_meta_refresh_url(html)

        go_token = go_match.group(1)
        go_url = f"{urlparse(url).scheme}://{urlparse(url).netloc}/?go={go_token}"
        request = Request(go_url, headers={
            "User-Agent": USER_AGENT,
            "Cookie": f"{go_token}={wp_http2}",
            "Referer": final_url,
        })
        with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            go_html = response.read().decode("utf-8", "ignore")
        return extract_meta_refresh_url(go_html)
    except Exception:
        return None


def uhdmovies_extract_driveseed(url: str, label: str) -> list[dict[str, Any]]:
    streams: list[dict[str, Any]] = []
    try:
        html, final_url = fetch_text(url)
        replace_match = re.search(r"replace\([\"']([^\"']+)", html or "", re.I)
        if replace_match:
            html, final_url = fetch_text(urljoin(final_url, replace_match.group(1)))
    except Exception:
        return streams

    file_title_match = re.search(r'og:title["\']\s+content=["\']([^"\']+)', html or "", re.I)
    file_title = compact_text(file_title_match.group(1)) if file_title_match else label
    for link in extract_links(html, final_url):
        text = link["label"].lower()
        href = link["url"]
        if "instant download" in text and href.startswith("http"):
            streams.append(make_stream(href, file_title, "uhdmovies", "UHDMovies", final_url))
    return streams


def scrape_uhdmovies(payload: dict[str, Any]) -> list[dict[str, Any]]:
    tmdb_id = int(payload.get("tmdbId") or 0)
    media_type = str(payload.get("mediaType") or "movie").lower()
    details = tmdb_details(tmdb_id, media_type)
    title = details["title"]
    year = details["year"]
    streams: list[dict[str, Any]] = []

    for post in uhdmovies_search_posts(title, year):
        for source in uhdmovies_post_source_links(post["url"]):
            final_url = uhdmovies_bypass_unblocked(source["url"]) if "cloud.unblockedgames.world" in source["url"] else source["url"]
            if not final_url:
                continue
            if "driveseed" in final_url or "driveleech" in final_url:
                streams.extend(uhdmovies_extract_driveseed(final_url, source["label"] or post["label"]))
            elif final_url.startswith("http"):
                streams.append(make_stream(final_url, source["label"] or post["label"], "uhdmovies", "UHDMovies", post["url"]))
            if len(streams) >= 12:
                break
        if streams:
            break

    return dedupe_streams(streams, limit=20)


def handle_scrape(payload: dict[str, Any]) -> dict[str, Any]:
    provider = str(payload.get("provider") or "").lower()
    start = time.time()
    if provider == "scrapling-hdhub4u":
        streams = scrape_hdhub4u(payload)
    elif provider == "scrapling-4khdhub":
        streams = scrape_4khdhub(payload)
    elif provider == "uhdmovies":
        streams = scrape_uhdmovies(payload)
    else:
        return {"streams": [], "error": f"unsupported provider {provider}"}
    return {
        "streams": streams,
        "meta": {
            "provider": provider,
            "durationMs": int((time.time() - start) * 1000),
            "scraplingAvailable": Fetcher is not None,
            "stealthAvailable": StealthyFetcher is not None,
        },
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "NebulaScrapling/1.0"

    def _json(self, status: int, body: dict[str, Any]) -> None:
        data = json.dumps(body).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._json(200, {"status": "ok", "scraplingAvailable": Fetcher is not None})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/scrape":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(min(length, 64 * 1024)) or b"{}")
            self._json(200, handle_scrape(payload))
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as error:
            self._json(200, {"streams": [], "error": str(error)})

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[scrapling-service] " + (fmt % args) + "\n")


def main() -> None:
    server = ReusableThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    signal.signal(signal.SIGTERM, lambda *_: server.shutdown())
    signal.signal(signal.SIGINT, lambda *_: server.shutdown())
    print(json.dumps({"status": "listening", "port": PORT, "scraplingAvailable": Fetcher is not None}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
