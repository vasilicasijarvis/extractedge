// index.js — ExtractEdge Worker entrypoint.
// Routes:
//   GET  /                      -> info + pricing
//   POST /extract               -> x402-paid extraction (or free demo via X-ExtractEdge-Demo)
//   POST /extract?demo=1        -> free capped demo lane
//   POST|GET /mcp               -> MCP server (Streamable HTTP JSON-RPC)
//   GET  /.well-known/x402.json -> discovery info
//   anything else               -> 404

import { HttpError } from "./errors.js";
import { requirePayment, makeJsonResponse, buildPaymentRequired, settleHeader, PRICE_ATOMIC } from "./x402.js";
import { extractUrl } from "./extract.js";
import { handleMcp } from "./mcp.js";
import { checkRate } from "./rl.js";

const OWNER_ADDR = "0xa1b8be63bde77ddc65d9ffe8a21a2a5f2c9ca6a8";
const DEMO_CAP = 3000;
const buckets = new Map();

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, payment-signature, x-payment, x-extractedge-demo",
  "access-control-expose-headers": "payment-required, payment-response",
};

function withCors(headers) {
  return { ...CORS, ...headers };
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        return makeJsonResponse({ error: e.message }, e.status, withCors({}));
      }
      return makeJsonResponse({ error: (e && e.message) || "Internal error" }, 500, withCors({}));
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const origin = url.origin;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: withCors({}) });
  }

  if (path === "/" || path === "/health") return handleInfo(url.origin);
  if (path === "/extract") return handleExtract(request, url.origin, env, ctx);
  if (path === "/mcp") return handleMcp(request);
  if (path === "/.well-known/x402.json") return handleWellKnown(url.origin);
  if (path === "/.well-known/agent-registration.json") return handleAgentRegistration(url.origin);
  return makeJsonResponse({ error: "Not found", routes: ["/", "POST /extract", "/mcp", "/.well-known/x402.json"] }, 404, withCors({}));
}

function handleInfo(origin) {
  return makeJsonResponse(
    {
      service: "extractedge",
      tagline: "Firecrawl-lite: turn any web page into clean markdown — cheap, fast, agent-native",
      endpoints: {
        "POST /extract": {
          body: { url: "https://example.com/article", format: "markdown|text" },
          payment: `x402 v2, 0.001 USDC (${PRICE_ATOMIC} atomic) on Base mainnet; 402 -> sign -> retry with PAYMENT-SIGNATURE header`,
          freeDemo: "add header X-ExtractEdge-Demo: 1 (or ?demo=1) for a capped 3000-char preview",
        },
        "POST /mcp": "MCP server (JSON-RPC 2.0 Streamable HTTP): tools/call extract {url, demo?}",
        "GET /.well-known/x402.json": "payment discovery",
      },
      pricing: { per_extract_usdc: 0.001, network: "eip155:8453 (Base)", pay_to: OWNER_ADDR },
      compare: "Firecrawl starts at $16/mo for ~1k credits; ExtractEdge is $0.001/extract pay-per-use, no signup, crypto-native.",
      version: "0.1.0",
    },
    200,
    withCors({})
  );
}

async function handleWellKnown(origin) {
  const pr = buildPaymentRequired(origin, { payTo: OWNER_ADDR });
  return makeJsonResponse(
    {
      x402Version: 2,
      resource: `${origin}/extract`,
      accepts: pr.accepts,
      facilitator: "https://facilitator.daydreams.systems",
      docs: "POST {url} -> 402 with PAYMENT-REQUIRED (base64) -> sign EIP-3009 USDC transferWithAuthorization -> retry with PAYMENT-SIGNATURE (base64 PaymentPayload)",
    },
    200,
    withCors({})
  );
}

function handleAgentRegistration(origin) {
  return makeJsonResponse(
    {
      type: "https://erc8004.spec/schema/v1/agent-registration.json",
      name: "ExtractEdge",
      description: "Web page -> clean markdown extraction API (Firecrawl-lite) with MCP server and x402 USDC payments on Base.",
      endpoints: [{ name: "extractedge-api", endpoint: origin, capabilities: ["extract", "mcp", "x402"] }],
      x402Support: true,
      active: true,
    },
    200,
    withCors({})
  );
}

async function handleExtract(request, origin, env, ctx) {
  const url = new URL(request.url);
  const isDemo = request.headers.get("x-extractedge-demo") !== null || url.searchParams.get("demo") === "1";

  let body;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body: expected {url, format?}");
  }
  const target = String((body && body.url) || "").trim();
  if (!target) throw new HttpError(400, "Missing url");

  // abuse control: per-IP bucket on the free demo lane only
  if (isDemo) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const ok = await checkRate(buckets, ip, 20, 60000);
    if (!ok) throw new HttpError(429, "Demo rate limit exceeded (20/min). Use the paid lane.");
    return serveDemo(target, body);
  }

  const gate = await requirePayment(request, origin, OWNER_ADDR, env);
  if (!gate.paid) return gate.response;

  const result = await extractUrl(target, { format: body.format });
  const headers = withCors({
    "content-type": "application/json; charset=utf-8",
    "payment-response": settleHeader(gate.settle),
  });
  return new Response(
    JSON.stringify({
      success: true,
      format: result.format,
      content: result.content,
      textContent: result.textContent,
      metadata: { ...result.metadata, title: result.title, description: result.description },
      payment: { payer: gate.payer, transaction: gate.settle.transaction, amount: PRICE_ATOMIC },
    }),
    { headers }
  );
}

async function serveDemo(target, body) {
  const result = await extractUrl(target, { format: body && body.format });
  const full = String(result.content || "");
  const capped = full.slice(0, DEMO_CAP);
  const truncated = full.length > DEMO_CAP;
  return makeJsonResponse(
    {
      success: true,
      demo: true,
      format: result.format,
      content: capped,
      metadata: { ...result.metadata, title: result.title, description: result.description },
      truncated,
      totalChars: full.length,
      upgrade: truncated
        ? `Free demo capped at ${DEMO_CAP} of ${full.length} chars. Full extraction: 0.001 USDC on Base via x402 — POST without the demo header and follow the 402 instructions.`
        : "Free demo returned the full page (under the cap). Full-featured lane adds link refs + payment receipts.",
    },
    200,
    withCors({})
  );
}