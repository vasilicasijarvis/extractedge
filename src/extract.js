// extract.js — URL extraction pipeline: fetch (timeout, redirect cap) -> parse -> markdown/text.

import { parseHtml, extractMarkdown, renderToText, scoreMainCandidates } from "./md.js";
import { HttpError } from "./errors.js";

const MAX_FETCH_MS = 15000;
const MAX_REDIRECTS = 5;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export async function extractUrl(url, opts = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, "Invalid URL");
  }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, "Only http(s) URLs are supported");
  const started = Date.now();
  const resp = await fetchFollow(u);
  const ctype = (resp.headers.get("content-type") || "").toLowerCase();
  const finalUrl = resp.url || u.href;

  if (ctype.includes("application/json") || ctype.endsWith("+json")) {
    const body = await resp.text();
    let pretty = body;
    try { pretty = JSON.stringify(JSON.parse(body), null, 2); } catch {}
    return {
      format: "json",
      content: pretty,
      metadata: baseMeta(finalUrl, resp.status, ctype, body.length, started, []),
    };
  }
  if (/^(image|audio|video)\//.test(ctype) || ctype === "application/pdf") {
    const len = Number(resp.headers.get("content-length") || 0);
    return {
      format: "binary-notice",
      content: `Binary resource (${ctype.split(";")[0]}). ExtractEdge returns text content only; size: ${len || "unknown"} bytes.`,
      metadata: baseMeta(finalUrl, resp.status, ctype, len, started, []),
    };
  }

  const raw = await resp.text();
  if (raw.length > 3 * 1024 * 1024) {
    throw new HttpError(413, `Page too large (${raw.length} bytes, limit 3MB)`);
  }
  const parsed = await parseHtml(raw, finalUrl);
  const main = scoreMainCandidates(parsed.root);
  const { markdown, links } = extractMarkdown(main, finalUrl);
  let content = markdown;
  if (opts.format === "text") content = renderToText(main).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return {
    format: opts.format === "text" ? "text" : "markdown",
    content,
    metadata: baseMeta(finalUrl, resp.status, ctype, raw.length, started, links),
    title: parsed.title,
    description: parsed.description,
  };
}

function baseMeta(source, statusCode, contentType, contentLength, started, links) {
  return {
    source,
    statusCode,
    contentType,
    contentLength,
    fetchMs: Date.now() - started,
    links: [...new Set(links)].slice(0, 200),
  };
}

async function fetchFollow(u) {
  let cur = u;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), MAX_FETCH_MS);
    let resp;
    try {
      resp = await fetch(cur.href, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
      });
    } catch (e) {
      clearTimeout(t);
      throw new HttpError(502, `Fetch failed: ${(e && e.message) || e}`);
    }
    clearTimeout(t);
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) return resp;
      let next;
      try { next = new URL(loc, cur); } catch { throw new HttpError(502, "Bad redirect location"); }
      if (!/^https?:$/.test(next.protocol)) throw new HttpError(502, "Unsupported redirect scheme");
      cur = next;
      continue;
    }
    return resp;
  }
  throw new HttpError(508, "Too many redirects");
}