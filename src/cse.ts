import { Credentials } from "./config.js";

const BASE = "https://componentsearchengine.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export interface PartResult {
  uid: string;
  mpn: string;
  manufacturer: string;
  description: string;
  package: string;
  hasModel: boolean;
}

export function partViewUrl(mpn: string, manufacturer: string): string {
  return `${BASE}/part-view/${encodeURI(mpn)}/${encodeURI(manufacturer)}`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&apos;/g, "'");
}

export function parseSearchResults(html: string): PartResult[] {
  const results: PartResult[] = [];
  const rows = html.split("<tr id='row-").slice(1);
  for (const row of rows) {
    const chunk = row.split("</tr>")[0];
    const uid = chunk.match(/data-uid="(-?\d+)"/)?.[1] ?? "";
    const partLink = chunk.match(/class="part-number"[^>]*>\s*([^<]+?)\s*<\/a>/);
    const mpn = partLink ? decodeEntities(partLink[1].trim()) : "";
    const manuf = chunk.match(/<span class="grey-text">\s*([^<]+?)\s*<\/span>/);
    const manufacturer = manuf ? decodeEntities(manuf[1].trim()) : "";
    const desc = chunk.match(/<span class="td-description">([^<]*)<\/span>/);
    const description = desc ? decodeEntities(desc[1].trim()) : "";
    const pkg = chunk.match(/<span class="td-package-category">([^<]*)<\/span>/);
    const packageName = pkg ? decodeEntities(pkg[1].trim()) : "";
    const hasModel = /ecad-icon-wrapper/.test(chunk) && !uid.startsWith("-");
    if (!uid && !mpn) continue;
    results.push({ uid, mpn, manufacturer, description, package: packageName, hasModel });
  }
  return results;
}

export interface SearchResultSet {
  results: PartResult[];
  total: number;
  fetchedPages: number;
}

const PER_PAGE = 25;
const MAX_PAGES = 40;

export async function search(
  term: string,
  opts: { limit?: number } = {}
): Promise<SearchResultSet> {
  const limit = opts.limit ?? 3 * PER_PAGE;
  const maxPages = Number.isFinite(limit) ? Math.max(1, Math.ceil(limit / PER_PAGE)) : MAX_PAGES;
  const all: PartResult[] = [];
  const seen = new Set<string>();
  let total = 0;
  let fetchedPages = 0;

  for (let page = 1; page <= maxPages; page++) {
    const url = `${BASE}/search?term=${encodeURIComponent(term)}&page=${page}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (res.status === 403) {
      throw new Error(
        "Search blocked by Component Search Engine (HTTP 403). Try again, or use 'kicad-manager add --id <partID>' with an ID from componentsearchengine.com."
      );
    }
    if (!res.ok) {
      if (page === 1) throw new Error(`Search failed (HTTP ${res.status})`);
      break;
    }
    const html = await res.text();
    if (page === 1) {
      const m = html.match(/of <strong>(\d+) results/);
      total = m ? parseInt(m[1], 10) : 0;
    }
    const results = parseSearchResults(html);
    if (results.length === 0) break;

    let added = 0;
    for (const r of results) {
      if (seen.has(r.uid)) continue;
      seen.add(r.uid);
      all.push(r);
      added++;
    }
    fetchedPages = page;
    if (added === 0 || results.length < PER_PAGE) break;
    if (Number.isFinite(limit) && all.length >= limit) break;
  }
  return { results: all, total, fetchedPages };
}

export async function getSamacId(mpn: string, manufacturer: string): Promise<string | null> {
  const url = `${BASE}/part-preview/${encodeURI(mpn)}/${encodeURI(manufacturer)}?type=footprint`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const m =
    html.match(/data-samac-id="(\d+)"/) ??
    html.match(/data-samacsys-part-id="(\d+)"/) ??
    html.match(/samacPartId=(\d+)/);
  return m ? m[1] : null;
}

export async function downloadZip(partId: string, creds: Credentials): Promise<Buffer> {
  const url = `${BASE}/ga/model.php?partID=${encodeURIComponent(partId)}`;
  const token = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Authorization: `Basic ${token}`,
      Accept: "application/x-zip, application/octet-stream",
    },
  });
  if (res.status === 401) {
    throw new Error("Component Search Engine authentication failed. Run 'kicad-manager login' to set your credentials.");
  }
  if (!res.ok) {
    throw new Error(`Download failed (HTTP ${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-zip") && !contentType.includes("application/zip")) {
    const snippet = buf.slice(0, 160).toString("utf8").replace(/\s+/g, " ").trim();
    throw new Error(`Download failed: server returned "${contentType}" instead of a zip. ${snippet}`);
  }
  if (buf.length === 0) {
    throw new Error("Download returned an empty file.");
  }
  return buf;
}
