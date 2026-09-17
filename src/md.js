// md.js — HTML -> DOM (via HTMLRewriter) -> Markdown/Text + main-content scoring.

const SKIP_RENDER = new Set([
  "script", "style", "noscript", "svg", "iframe", "template", "button",
  "select", "option", "form", "label", "input", "head", "meta", "link",
]);

const INLINE_TAGS = new Set([
  "a", "b", "strong", "i", "em", "code", "img", "br", "span", "small",
  "sup", "sub", "s", "u", "mark", "abbr", "time", "cite", "q", "kbd",
  "samp", "var", "font", "bdi", "bdo", "wbr",
]);

const SUPPRESS_TEXT = new Set(["script", "style", "svg", "noscript", "template"]);

const AUTOCLOSE = {
  li: ["li"],
  p: ["p"],
  dt: ["dt"],
  dd: ["dd"],
  option: ["option"],
  tr: ["tr", "td", "th"],
  td: ["td", "th"],
  th: ["td", "th"],
  tbody: ["tbody", "thead", "tr", "td", "th"],
  thead: ["thead", "tbody", "tr", "td", "th"],
  tfoot: ["tbody", "thead", "tr", "td", "th"],
};

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "source", "track", "wbr",
]);

// Named + numeric HTML entity decoding (streamed text arrives still encoded).
function decodeEntities(s) {
  if (!s) return "";
  if (s.indexOf("&") === -1) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ").replace(/&middot;/g, "\u00b7").replace(/&bull;/g, "\u2022")
    .replace(/&mdash;/g, "\u2014").replace(/&ndash;/g, "\u2013").replace(/&hellip;/g, "\u2026")
    .replace(/&rsquo;/g, "\u2019").replace(/&lsquo;/g, "\u2018")
    .replace(/&rdquo;/g, "\u201d").replace(/&ldquo;/g, "\u201c")
    .replace(/&copy;/g, "\u00a9").replace(/&reg;/g, "\u00ae").replace(/&trade;/g, "\u2122")
    .replace(/&amp;/g, "&");
}

class DOMBuilder {
  constructor(baseUrl) {
    this.base = baseUrl;
    this.root = { tag: "#root", attrs: {}, children: [], parent: null };
    this.cur = this.root;
    this.title = "";
    this.description = "";
    this.canonical = "";
    this.suppress = 0;
  }
  push(node) {
    node.parent = this.cur;
    this.cur.children.push(node);
    this.cur = node;
    return node;
  }
  pop() {
    if (this.cur.parent) this.cur = this.cur.parent;
  }
  onTag(tag, attrs) {
    const closes = AUTOCLOSE[tag];
    if (closes) {
      while (closes.includes(this.cur.tag)) this.pop();
    }
    if (SUPPRESS_TEXT.has(tag)) this.suppress++;
    if (VOID_TAGS.has(tag)) {
      this.push({ tag, attrs, children: [], parent: null });
      this.pop();
      if (SUPPRESS_TEXT.has(tag)) this.suppress = Math.max(0, this.suppress - 1);
      return;
    }
    this.push({ tag, attrs, children: [], parent: null });
  }
  onEndTag(tag) {
    if (SUPPRESS_TEXT.has(tag)) this.suppress = Math.max(0, this.suppress - 1);
    if (VOID_TAGS.has(tag)) return;
    let n = this.cur;
    while (n && n.tag !== tag && n.tag !== "#root") n = n.parent;
    if (n && n.tag === tag && n.parent) this.cur = n.parent;
  }
  appendText(t) {
    if (!t || this.suppress > 0) return;
    this.push({ tag: "#text", attrs: {}, text: decodeEntities(t), children: [], parent: null });
    this.pop();
  }
}

// Parse raw HTML into a DOM tree + metadata using Cloudflare HTMLRewriter.
export function parseHtml(raw, baseUrl) {
  const b = new DOMBuilder(baseUrl);
  let textBuf = "";
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const attrs = {};
        try {
          for (const [k, v] of el.attributes) attrs[k] = v;
        } catch {}
        const tag = (el.tagName || "").toLowerCase();
        b.onTag(tag, attrs);
        try {
          el.onEndTag(() => b.onEndTag(tag));
        } catch {}
      },
      text(t) {
        textBuf += t.text;
        if (t.lastInTextNode) {
          b.appendText(textBuf);
          textBuf = "";
        }
      },
      comments() {},
    })
    .on("title", {
      text(t) {
        b.title += t.text;
        // title text should not duplicate into body; harmless either way (in head)
      },
    })
    .on("meta[name], meta[property]", {
      element(el) {
        const name = (el.getAttribute("name") || el.getAttribute("property") || "").toLowerCase();
        const content = el.getAttribute("content") || "";
        if (name === "description" && content && !b.description) b.description = content;
        if (name === "og:description" && content && !b.description) b.description = content;
      },
    })
    .on("link[rel=canonical]", {
      element(el) {
        const href = el.getAttribute("href") || "";
        if (href && !b.canonical) b.canonical = href;
      },
    });

  const resp = new Response(raw, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  const out = rewriter.transform(resp);
  // Drain transformed output (parser events already fired during streaming).
  return out.arrayBuffer().then(() => ({
    root: b.root,
    title: (b.title || "").trim(),
    description: (b.description || "").trim(),
    canonical: b.canonical || "",
  }));
}

// ------------------------------------------------------------------ markdown

function collectText(n) {
  let t = "";
  const stack = [n];
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === "string") { t += x; continue; }
    if (x.tag === "#text") { t += x.text || ""; continue; }
    if (SKIP_RENDER.has(x.tag)) continue;
    const kids = x.children || [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return t;
}

export function extractMarkdown(root, baseUrl) {
  const out = [];
  const links = [];
  const linkMap = new Map(); // abs href -> ref index

  function inline(nodes) {
    let s = "";
    for (const n of nodes) {
      if (typeof n === "string") { s += n; continue; }
      const tag = n.tag;
      if (tag === "#text") { s += n.text || ""; continue; }
      if (SKIP_RENDER.has(tag)) continue;
      if (tag === "br") { s += "\n"; continue; }
      if (tag === "b" || tag === "strong") {
        const inner = inline(n.children || []).trim();
        if (inner) s += "**" + inner + "**";
        continue;
      }
      if (tag === "i" || tag === "em") {
        const inner = inline(n.children || []).trim();
        if (inner) s += "*" + inner + "*";
        continue;
      }
      if (tag === "code") {
        s += "`" + inline(n.children || []) + "`";
        continue;
      }
      if (tag === "a") {
        const attrs = n.attrs || {};
        const href = attrs.href ? String(attrs.href) : "";
        const txt = inline(n.children || []).replace(/\s+/g, " ").trim();
        if (!href || href.startsWith("#") || !txt) { s += txt; continue; }
        let abs;
        try { abs = new URL(href, baseUrl).href; } catch { s += txt; continue; }
        let idx = linkMap.get(abs);
        if (idx === undefined) { idx = linkMap.size + 1; linkMap.set(abs, idx); }
        s += "[" + txt + "][" + idx + "]";
        links.push(abs);
        continue;
      }
      if (tag === "img") {
        const attrs = n.attrs || {};
        const src = attrs.src ? String(attrs.src) : "";
        const alt = attrs.alt || "";
        if (src) {
          let abs;
          try { abs = new URL(src, baseUrl).href; } catch { abs = src; }
          s += "![" + alt + "](" + abs + ")";
          links.push(abs);
        }
        continue;
      }
      s += inline(n.children || []);
    }
    return s;
  }

  function cleanInline(s) {
    return s.replace(/[ \t]*\n[ \t]*/g, " ").replace(/[ \t]{2,}/g, " ").trim();
  }

  function renderBlock(node, depth) {
    if (typeof node === "string") return;
    const tag = node.tag;
    if (SKIP_RENDER.has(tag)) return;
    const kids = node.children || [];
    switch (tag) {
      case "#root": {
        for (const k of kids) renderBlock(k, depth);
        return;
      }
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        const s = cleanInline(inline(kids));
        if (s) out.push("\n" + "#".repeat(Number(tag[1])) + " " + s);
        return;
      }
      case "p": {
        const s = cleanInline(inline(kids));
        if (s) out.push("\n" + s);
        return;
      }
      case "pre": {
        const t = collectText(node).replace(/\n+$/, "");
        if (t.trim()) out.push("\n```\n" + t + "\n```");
        return;
      }
      case "blockquote": {
        const saveLen = out.length;
        for (const k of kids) renderBlock(k, depth);
        if (out.length > saveLen) {
          const inner = out.splice(saveLen).join("\n").trim();
          if (inner) out.push("\n" + inner.split("\n").map((l) => "> " + l).join("\n"));
        }
        return;
      }
      case "ul": case "ol": {
        let i = 1;
        for (const k of kids) {
          if (typeof k === "string" || k.tag !== "li") continue;
          const marker = (depth > 0 ? "  ".repeat(depth) : "") + (tag === "ol" ? i + ". " : "- ");
          i++;
          const inlineKids = (k.children || []).filter(
            (c) => typeof c === "string" || (c.tag !== "ul" && c.tag !== "ol")
          );
          const inner = cleanInline(inline(inlineKids));
          if (inner) out.push("\n" + marker + inner);
          for (const c of k.children || []) {
            if (typeof c !== "string" && (c.tag === "ul" || c.tag === "ol")) {
              renderBlock(c, depth + 1);
            }
          }
        }
        return;
      }
      case "table": {
        const rows = [];
        const walk = (n) => {
          if (n.tag === "tr") {
            const cells = [];
            for (const c of n.children || []) {
              if (typeof c === "string") continue;
              if (c.tag === "td" || c.tag === "th") {
                cells.push(cleanInline(inline(c.children || [])).replace(/\|/g, "\\|"));
              } else walk(c);
            }
            if (cells.length) rows.push(cells);
            return;
          }
          for (const c of n.children || []) if (typeof c !== "string") walk(c);
        };
        walk(node);
        if (rows.length) {
          const header = rows[0];
          out.push("\n| " + header.join(" | ") + " |");
          out.push("|" + header.map(() => " --- ").join("|") + "|");
          for (let r = 1; r < rows.length; r++) {
            const row = rows[r].slice(0, header.length);
            while (row.length < header.length) row.push("");
            out.push("| " + row.join(" | ") + " |");
          }
        }
        return;
      }
      case "hr": {
        out.push("\n---");
        return;
      }
      case "figcaption": {
        const s = cleanInline(inline(kids));
        if (s) out.push("\n" + s);
        return;
      }
      case "br": return;
      default: {
        const inlineKids = kids.filter(
          (k) => typeof k === "string" || k.tag === "#text" || INLINE_TAGS.has(k.tag)
        );
        if (inlineKids.length) {
          const s = cleanInline(inline(inlineKids));
          if (s) out.push("\n" + s);
        }
        for (const k of kids) {
          if (typeof k !== "string" && !INLINE_TAGS.has(k.tag)) renderBlock(k, depth);
        }
      }
    }
  }

  renderBlock(root, 0);
  const refs = [...linkMap.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([u, i]) => "[" + i + "]: " + u);
  let md = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (refs.length) md += "\n\n" + refs.join("\n");
  return { markdown: md, links };
}

export function renderToText(root) {
  const blocky = new Set([
    "p", "div", "section", "article", "main", "header", "footer", "aside",
    "nav", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
    "pre", "table", "ul", "ol", "figure", "figcaption", "dl", "dt", "dd", "hr",
  ]);
  function walk(n) {
    if (typeof n === "string") return n;
    if (n.tag === "#text") return n.text || "";
    if (n.tag === "br") return "\n";
    if (SKIP_RENDER.has(n.tag)) return "";
    let kids = "";
    for (const k of n.children || []) kids += walk(k);
    return blocky.has(n.tag) ? kids + "\n" : kids;
  }
  return walk(root);
}

// ------------------------------------------------------------------ main-content scoring

function subtreeTextLength(node) {
  let t = 0;
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    for (const k of n.children || []) {
      if (typeof k === "string") t += k.length;
      else if (k.tag === "#text") t += (k.text || "").length;
      else if (!SKIP_RENDER.has(k.tag)) stack.push(k);
    }
  }
  return t;
}

export function scoreMainCandidates(root) {
  const cands = [];
  const walk = (node, depth) => {
    if (typeof node === "string") return;
    const kids = node.children || [];
    let pCount = 0;
    let elCount = 0;
    for (const k of kids) {
      if (typeof k === "string") continue;
      elCount++;
      if (k.tag === "p") pCount++;
    }
    const dLen = subtreeTextLength(node);
    if (["article", "main", "div", "section"].includes(node.tag) && dLen > 250) {
      const density = dLen / (elCount || 1);
      const score = dLen + pCount * 120 - depth * 30 + density * 0.5;
      cands.push({ node, score });
    }
    for (const k of kids) if (typeof k !== "string") walk(k, depth + 1);
  };
  walk(root, 0);
  if (!cands.length) return root;
  cands.sort((a, b) => b.score - a.score);
  return cands[0].node;
}