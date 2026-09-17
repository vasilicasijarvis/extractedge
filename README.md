# ExtractEdge

**Firecrawl-lite: turn any web page into clean LLM-ready markdown.** Fast, cheap, crypto-native.
Live: https://extractedge.lastunmihai1986.workers.dev

## Why

Firecrawl starts at $16/mo for ~1k credits and requires signup + API key.
ExtractEdge is **$0.001/extract pay-per-use** over x402 (USDC on Base mainnet), no signup, no API key — designed for AI agents.

## Quick start (free demo)

```bash
curl -X POST "https://extractedge.lastunmihai1986.workers.dev/extract?demo=1" \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com"}'
```

Free demo returns up to 3,000 chars of the page as markdown. No payment needed.

## Paid extraction (x402, USDC on Base)

1. `POST /extract {"url":"https://target.page"}` → **402** with `PAYMENT-REQUIRED` header (base64 JSON)
2. Sign an EIP-3009 `transferWithAuthorization` for **1000 atomic units (0.001 USDC)** on Base
   - asset: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC)
   - payTo: `0xa1b8be63bde77ddc65d9ffe8a21a2a5f2c9ca6a8`
3. Retry with the `PAYMENT-SIGNATURE` header (base64 `PaymentPayload` JSON) → **200** with full markdown + `PAYMENT-RESPONSE` receipt

Python client example: see `scripts/e2e_paid2.py` (eth_account EIP-712 signing, ~40 lines).

## MCP server

Streamable HTTP MCP endpoint (JSON-RPC 2.0):

```
https://extractedge.lastunmihai1986.workers.dev/mcp
```

- `tools/list` → `extract` tool
- `tools/call extract {"url":"...", "demo":true}` → free capped markdown
- Listed on **Smithery**: https://smithery.ai/server/admin-qnk4/extractedge

## REST endpoints

| Endpoint | Description |
|---|---|
| `POST /extract` | Paid extraction (x402) or free demo (`?demo=1` / `X-ExtractEdge-Demo` header) |
| `POST /mcp` | MCP JSON-RPC (initialize / tools/list / tools/call / ping) |
| `GET /.well-known/x402.json` | Payment discovery |
| `GET /.well-known/agent-registration.json` | ERC-8004 agent registration file |
| `GET /` | Service info |

## Response shape

```json
{
  "success": true,
  "format": "markdown",
  "content": "# Page title\n\nClean markdown...",
  "textContent": "plain text variant",
  "metadata": {
    "title": "Page title", "description": "meta description",
    "source": "https://final.url/", "statusCode": 200,
    "contentLength": 48211, "fetchMs": 731,
    "links": ["https://..."]
  },
  "payment": {"payer": "0x...", "transaction": "0x...", "amount": "1000"}
}
```

## Features

- Main-content detection (scores article/main/div candidates by text density, drops nav/footer/ads)
- HTML → markdown: headings, bold/italic, links (reference-style), images, ordered/unordered lists (nested), code blocks, blockquotes, tables (GFM), hr
- Entity decoding (named + numeric), script/style/svg stripped
- JSON endpoints returned pretty-printed; binary resources answered with a notice
- Redirect following (≤5), 15s timeout, 3MB cap, per-IP demo rate limit (20/min)
- CORS enabled; abuse control on demo lane only — paid lane unlimited

## Architecture

Single Cloudflare Worker (stdlib-only, zero npm deps):
- `src/index.js` — router + info endpoints
- `src/extract.js` — fetch pipeline (timeout, redirects, content-type dispatch)
- `src/md.js` — HTMLRewriter → DOM tree → markdown/text + main-content scoring
- `src/x402.js` — x402 v2 gate: 402/PAYMENT-REQUIRED, EIP-3009 verify+settle via Coinbase CDP facilitator (Ed25519 JWT per request), Bazaar discovery declaration
- `src/mcp.js` — MCP Streamable HTTP server (JSON-RPC 2.0)

## Pricing comparison

| | Firecrawl | ExtractEdge |
|---|---|---|
| Entry price | $16/mo (~1k credits) | $0 pay-per-use |
| Per page | ~$0.016 | **$0.001** |
| Signup/API key | required | none |
| Payment | card | USDC on Base (x402) |
| Agent-native (MCP) | hosted | MCP + x402 + Bazaar |

## Status

- Worker live on `extractedge.lastunmihai1986.workers.dev` (global edge)
- 3 real settled payments on Base mainnet (tx receipts verified on-chain)
- MCP published on Smithery (`admin-qnk4/extractedge`)