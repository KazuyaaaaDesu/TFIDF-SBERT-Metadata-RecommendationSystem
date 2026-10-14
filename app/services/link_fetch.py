"""
Fetch a dropped link on the server and turn it into citation text.

Browsers cannot read most cited pages cross-origin, so the Upload drop
zone asks the backend. Results are ``{"format", "text", "url"}`` where
format is bib / ris / enw (citation text the normal file preview can
parse) or ``doi`` (an identifier the identifier preview can resolve).
"""

from __future__ import annotations

import html as html_lib
import re
from html.parser import HTMLParser
from urllib.parse import urlsplit

import requests

from app.services.url_safety import UnsafeUrlError, safe_get

MAX_LINK_BYTES = 2 * 1024 * 1024
LINK_TIMEOUT = 10

SCHOLAR_HOSTS = {"scholar.googleusercontent.com", "scholar.google.com"}

_DOI_RE = re.compile(r"\b(10\.\d{4,9}/[^\s\"'<>]+)", re.IGNORECASE)


class LinkFetchError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def clean_url(raw: str) -> str:
    """First http(s) URL in `raw` (tolerates trailing text / uri-list)."""

    for line in (raw or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.search(r"https?://[^\s\"'<>]+", line, re.IGNORECASE)
        if match:
            return match.group(0)
    return (raw or "").strip()


def sniff_citation_format(text: str) -> str | None:
    head = text.lstrip("﻿ \t\r\n")
    if re.match(r"(?is)<(!doctype|html|\?xml)", head):
        return None
    if re.search(r"(?m)^%0\s", text):
        return "enw"
    if re.search(r"(?im)^TY\s*-", text):
        return "ris"
    if re.search(r"@\w+\s*\{", text):
        return "bib"
    return None


class _MetaParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: list[tuple[str, str]] = []
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            name = (a.get("name") or a.get("property") or "").lower()
            if name and a.get("content"):
                self.meta.append((name, a["content"].strip()))
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data


def _first(meta, *names):
    for want in names:
        for name, value in meta:
            if name == want and value:
                return value
    return None


def _bib_escape(value: str) -> str:
    return re.sub(r"\s+", " ", value).replace("{", "(").replace("}", ")").strip()


def html_to_citation(page: str, url: str) -> tuple[str, str]:
    """Return ("bib", text) from citation_* meta tags, or ("doi", doi)."""

    parser = _MetaParser()
    try:
        parser.feed(page)
    except Exception:
        pass
    meta = parser.meta

    title = _first(meta, "citation_title", "dc.title", "og:title") or parser.title.strip()
    authors = [v for n, v in meta if n in ("citation_author", "dc.creator") and v]
    doi = _first(meta, "citation_doi", "dc.identifier", "prism.doi")
    if doi:
        m = _DOI_RE.search(doi)
        doi = m.group(1).rstrip(".,;") if m else None
    if not doi:
        m = _DOI_RE.search(page[:400000])
        doi = html_lib.unescape(m.group(1)).rstrip(".,;)") if m else None

    has_citation_meta = bool(_first(meta, "citation_title")) or bool(authors)

    if not has_citation_meta:
        # Not enough citation metadata: fall back on the DOI alone.
        if doi:
            return "doi", doi
        raise LinkFetchError(
            400,
            "That page has no citation metadata or DOI to import. "
            "Drag a BibTeX / RIS / EndNote export link instead.",
        )

    if not title:
        raise LinkFetchError(400, "That page has no title to import.")

    date = _first(meta, "citation_publication_date", "citation_date",
                  "citation_online_date", "dc.date", "article:published_time") or ""
    year = (re.search(r"(1[5-9]|20)\d{2}", date) or [None])[0] if date else None
    journal = _first(meta, "citation_journal_title", "citation_conference_title",
                     "citation_inbook_title", "og:site_name")
    abstract = _first(meta, "citation_abstract", "dc.description",
                      "description", "og:description")

    fields = [("title", title), ("author", " and ".join(authors) if authors else None),
              ("year", year), ("journal", journal), ("doi", doi),
              ("abstract", abstract), ("url", url)]
    body = ",\n".join(f"  {k} = {{{_bib_escape(v)}}}" for k, v in fields if v)
    return "bib", f"@article{{dropped_link,\n{body}\n}}\n"


def fetch_link(url: str) -> dict:
    """Fetch `url` (SSRF-safe) and return {"format", "text", "url"}."""

    url = clean_url(url)
    if not re.match(r"^https?://", url, re.IGNORECASE):
        raise LinkFetchError(400, "Only http and https links can be imported.")

    host = (urlsplit(url).hostname or "").lower()
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "text/plain, application/x-bibtex, text/html;q=0.9, */*;q=0.5",
    }

    try:
        response = safe_get(url, headers=headers, timeout=LINK_TIMEOUT, stream=True)
    except UnsafeUrlError as error:
        raise LinkFetchError(400, str(error)) from error
    except requests.RequestException as error:
        who = "Google Scholar" if host in SCHOLAR_HOSTS else "that link"
        raise LinkFetchError(502, f"Could not reach {who}.") from error

    try:
        if not response.ok:
            if host in SCHOLAR_HOSTS and response.status_code in (403, 429, 503):
                raise LinkFetchError(
                    502,
                    "Google Scholar is temporarily blocking automated "
                    "requests. Please try again later.",
                )
            raise LinkFetchError(502, f"The link returned HTTP {response.status_code}.")

        chunks, size = [], 0
        for chunk in response.iter_content(65536):
            size += len(chunk)
            if size > MAX_LINK_BYTES:
                raise LinkFetchError(413, "That page is too large to import.")
            chunks.append(chunk)
        raw = b"".join(chunks)
        encoding = response.encoding or "utf-8"
        try:
            text = raw.decode(encoding, errors="replace")
        except LookupError:
            text = raw.decode("utf-8", errors="replace")
    finally:
        response.close()

    text = text.strip()
    fmt = sniff_citation_format(text)
    if fmt:
        return {"format": fmt, "text": text, "url": url}

    if re.search(r"(?is)<(html|head|body|meta)\b", text):
        kind, value = html_to_citation(text, url)
        return {"format": kind, "text": value, "url": url}

    raise LinkFetchError(
        400,
        "That link did not return a BibTeX, RIS, EndNote or web page "
        "with citation details.",
    )
