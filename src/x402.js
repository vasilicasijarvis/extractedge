// x402.js — x402 v2 payment gate for Cloudflare Workers (USDC on Base mainnet).
// Facilitator: Coinbase CDP (api.cdp.coinbase.com) with per-request Ed25519 JWT (also indexes the Bazaar).
// Flow: POST /extract without payment -> 402 + PAYMENT-REQUIRED (base64 JSON).
// Retry with PAYMENT-SIGNATURE (base64 PaymentPayload JSON) -> verify+settle -> 200 + PAYMENT-RESPONSE.

import { HttpError } from "./errors.js";

const NETWORK = "eip155:8453";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const PRICE_ATOMIC = "1000"; // 0.001 USDC (6 decimals)
const CDP_HOST = "api.cdp.coinbase.com";
const CDP_X402_BASE = `https://${CDP_HOST}/platform/v2/x402`;

const enc = new TextEncoder();
const b64std = (str) => {
  const bytes = enc.encode(str);
  let s = "";
  for (let x = 0; x < bytes.length; x++) s += String.fromCharCode(bytes[x]);
  return btoa(s);
};
const b64stdDecode = (s) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
const b64urlBytes = (bytes) => {
  let s = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let x = 0; x < arr.length; x++) s += String.fromCharCode(arr[x]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export function makeJsonResponse(obj, status = 402, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function buildPaymentRequired(origin, opts = {}) {
  const pr = {
    x402Version: 2,
    error: opts.error || undefined,
    resource: {
      url: `${origin}/extract`,
      description: "ExtractEdge: clean markdown extraction of any web page (Firecrawl-lite), paid per request in USDC on Base",
      mimeType: "application/json",
      serviceName: "extractedge",
      tags: ["web", "extraction", "markdown", "scraper", "firecrawl-alternative"],
    },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        asset: USDC_BASE,
        amount: PRICE_ATOMIC,
        payTo: opts.payTo,
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body: { url: "https://example.com/blog/post", format: "markdown" },
          },
          output: {
            type: "json",
            example: {
              success: true,
              format: "markdown",
              content: "# Example Domain\n\nPage content as clean markdown...",
              metadata: { title: "Example Domain", source: "https://example.com/", links: [] },
            },
          },
        },
        schema: {
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["http"] },
                method: { type: "string", enum: ["POST"] },
                bodyType: { type: "string", enum: ["json"] },
                body: {
                  type: "object",
                  properties: { url: { type: "string" }, format: { type: "string", enum: ["markdown", "text"] } },
                  required: ["url"],
                },
              },
              required: ["type", "method", "body"],
            },
            output: {
              type: "object",
              properties: { type: { type: "string" }, example: { type: "object" } },
            },
          },
          required: ["input"],
        },
      },
    },
  };
  return pr;
}

export function settleHeader(settleObj) {
  return b64std(JSON.stringify(settleObj));
}

// ------------------------------------------------------------------ CDP JWT auth
function cdpConfig(env) {
  const kid = (env && env.CDP_API_KEY_ID || "").trim();
  const sec = (env && env.CDP_API_KEY_SECRET || "").trim();
  if (!kid || !sec) return null;
  let raw;
  try {
    raw = Uint8Array.from(atob(sec), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (raw.length < 32) return null;
  return { kid, seed: raw.slice(0, 32) };
}

function randHex(nBytes) {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function cdpJwt(cfg, path, method) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", kid: cfg.kid, typ: "JWT", nonce: randHex(8) };
  const payload = {
    sub: cfg.kid,
    iss: "cdp",
    nbf: now,
    exp: now + 120,
    uris: [`${method} ${CDP_HOST}${path}`],
  };
  const h = b64urlBytes(enc.encode(JSON.stringify(header)));
  const p = b64urlBytes(enc.encode(JSON.stringify(payload)));
  // Workers WebCrypto: private Ed25519 keys must be imported as PKCS8 DER
  // (raw import = public key). Wrap the 32-byte seed in the standard prefix.
  const PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  const der = new Uint8Array(48);
  der.set(PKCS8_PREFIX, 0);
  der.set(cfg.seed, 16);
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("Ed25519", key, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64urlBytes(new Uint8Array(sig))}`;
}

export async function facilitatorCall(phase, payloadObj, reqObj, env) {
  const cfg = cdpConfig(env);
  const body = {
    x402Version: 2,
    paymentPayload: payloadObj,
    paymentRequirements: reqObj,
  };
  const headers = { "content-type": "application/json" };
  if (cfg) {
    const jwt = await cdpJwt(cfg, `/platform/v2/x402/${phase}`, "POST");
    headers["authorization"] = `Bearer ${jwt}`;
  }
  const r = await fetch(`${CDP_X402_BASE}/${phase}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (r.status !== 200) {
    const t = await r.text();
    throw new HttpError(502, `Facilitator ${phase} failed (${r.status}): ${t.slice(0, 200)}`);
  }
  return r.json();
}

export async function requirePayment(request, origin, payTo, env) {
  const hdr = request.headers.get("payment-signature") || request.headers.get("x-payment");
  if (!hdr) {
    const pr = buildPaymentRequired(origin, { error: "Payment required", payTo });
    return {
      paid: false,
      response: makeJsonResponse(
        {
          error: "Payment required",
          howToPay: "POST {url} to /extract; read the base64 PAYMENT-REQUIRED header, sign a USDC (Base) EIP-3009 transferWithAuthorization for 1000 atomic units (0.001 USDC) to payTo, then retry with the PAYMENT-SIGNATURE header containing the base64 PaymentPayload JSON.",
          x402: pr,
        },
        402,
        {
          "payment-required": b64std(JSON.stringify(pr)),
          "access-control-expose-headers": "payment-required, payment-response",
        }
      ),
    };
  }
  let payloadObj;
  try {
    payloadObj = JSON.parse(b64stdDecode(hdr.trim()));
  } catch {
    throw new HttpError(402, "Invalid PAYMENT-SIGNATURE encoding (expected base64 JSON)");
  }
  if (Number(payloadObj.x402Version) !== 2) throw new HttpError(402, "Unsupported x402 version (want 2)");
  const accepted = payloadObj.accepted || {};
  if (accepted.scheme !== "exact") throw new HttpError(402, "Unsupported scheme (want exact)");
  if (accepted.network !== NETWORK) throw new HttpError(402, "Unsupported network (want eip155:8453)");
  if (String(accepted.asset || "").toLowerCase() !== USDC_BASE.toLowerCase()) throw new HttpError(402, "Unsupported asset");
  if (accepted.payTo && String(accepted.payTo).toLowerCase() !== String(payTo).toLowerCase()) throw new HttpError(402, "payTo mismatch");
  const amount = String(accepted.amount || "0");
  if (!/^\d+$/.test(amount)) throw new HttpError(402, "Invalid amount");
  if (Number(amount) < 1000) throw new HttpError(402, "Underpayment (< 0.001 USDC)");
  const reqObj = buildPaymentRequired(origin, { payTo }).accepts[0];
  const verify = await facilitatorCall("verify", payloadObj, reqObj, env);
  if (!verify || verify.isValid !== true) {
    throw new HttpError(402, `Payment verification failed: ${(verify && (verify.invalidReason || verify.invalid_reason)) || "unknown"}`);
  }
  const settle = await facilitatorCall("settle", payloadObj, reqObj, env);
  if (!settle || settle.success !== true) {
    throw new HttpError(402, `Settlement failed: ${(settle && (settle.errorReason || settle.error_reason)) || "unknown"}`);
  }
  return { paid: true, payer: verify.payer, settle };
}