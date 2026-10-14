/**
 * Pull a URL out of whatever a browser puts on a drag: text/uri-list
 * (may hold '#' comment lines and several URLs), text/x-moz-url
 * ("url\ntitle"), the legacy "URL" type, text/plain (possibly with
 * trailing text) and text/html (an <a href>).
 */

const URL_RE = /https?:\/\/[^\s"'<>]+/i;

export const LINK_DRAG_TYPES = [
  "text/uri-list",
  "text/x-moz-url",
  "URL",
  "text/plain",
  "text/html",
] as const;

function firstUrlInText(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(URL_RE);
    if (m) return m[0];
  }
  return null;
}

export function extractDroppedUrl(
  getData: (type: string) => string,
): string | null {
  const read = (type: string): string => {
    try {
      return getData(type) || "";
    } catch {
      return "";
    }
  };

  for (const type of ["text/uri-list", "text/x-moz-url", "URL", "text/plain"]) {
    const found = firstUrlInText(read(type));
    if (found) return found;
  }

  const html = read("text/html");
  if (html) {
    const href = html.match(/href\s*=\s*["']?(https?:\/\/[^"'\s>]+)/i);
    if (href) return href[1].replace(/&amp;/g, "&");
    const bare = html.match(URL_RE);
    if (bare) return bare[0].replace(/&amp;/g, "&");
  }

  return null;
}

export function isScholarExportUrl(url: string): boolean {
  return (
    /^https?:\/\/(?:scholar\.googleusercontent\.com|scholar\.google\.[a-z.]+)\//i.test(
      url,
    ) && /\/scholar\.(?:bib|enw|ris)(?:\?|$|#)/i.test(url)
  );
}
