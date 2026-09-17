// mcp.js — MCP server (Streamable HTTP, JSON-RPC 2.0) for ExtractEdge.
// Implements initialize, tools/list, tools/call (extract + free demo), ping.

import { extractUrl } from "./extract.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = {
  name: "extractedge",
  version: "0.1.0",
  title: "ExtractEdge",
};
const BASE_URL = "https://extractedge.lastunmihai1986.workers.dev";

const TOOLS = [
  {
    name: "extract",
    description:
      "Extract clean markdown (or plain text) content from any public web page URL. " +
      "Firecrawl-lite: fetches the page, strips ads/nav/scripts, converts the main content to markdown with metadata (title, description, links). " +
      "Paid via x402 USDC on Base (0.001 USDC/extract) — or free with {demo: true} (limited to 3000 chars).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http(s) URL of the page to extract" },
        format: { type: "string", enum: ["markdown", "text"], description: "Output format (default markdown)" },
        demo: { type: "boolean", description: "Set true for a free capped preview (3000 chars)" },
      },
      required: ["url"],
    },
  },
];

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id, error: err };
}

export async function handleMcp(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  if (request.method === "GET") {
    return new Response(JSON.stringify({ server: "extractedge", transport: "streamable-http", protocolVersion: PROTOCOL_VERSION }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  let msg;
  try {
    msg = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400, headers: MCP_HEADERS });
  }
  if (Array.isArray(msg)) {
    const results = [];
    for (const m of msg) results.push(await dispatch(m));
    return Response.json(results, { headers: MCP_HEADERS });
  }
  const out = await dispatch(msg);
  return Response.json(out, { headers: MCP_HEADERS });
}

const MCP_HEADERS = {
  "content-type": "application/json",
  "mcp-session-id": "extractedge-0",
};

async function dispatch(msg) {
  const id = msg && msg.id !== undefined ? msg.id : null;
  const method = msg && msg.method;
  try {
    if (method === "initialize") {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          "ExtractEdge converts any web page URL into clean markdown. " +
          "Call the `extract` tool with {url}. Free demo: add {demo: true} (result capped at 3000 chars). " +
          "Full result costs 0.001 USDC on Base via x402.",
      });
    }
    if (method === "notifications/initialized" || (method && method.startsWith("notifications/"))) {
      return null; // notifications: no response body
    }
    if (method === "ping") {
      return rpcResult(id, {});
    }
    if (method === "tools/list") {
      return rpcResult(id, { tools: TOOLS });
    }
    if (method === "tools/call") {
      const p = msg.params || {};
      const name = p.name;
      const args = p.arguments || {};
      if (name === "extract") {
        return await toolExtract(id, args);
      }
      return rpcError(id, -32602, `Unknown tool: ${name}`);
    }
    if (method === "resources/list") return rpcResult(id, { resources: [] });
    if (method === "prompts/list") return rpcResult(id, { prompts: [] });
    return rpcError(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    return rpcError(id, -32603, e && e.message ? e.message : "Internal error");
  }
}

async function toolExtract(id, args) {
  const url = String(args.url || "");
  if (!url) return rpcError(id, -32602, "Missing url");
  const format = args.format === "text" ? "text" : "markdown";
  try {
    const r = await extractUrl(url, { format });
    if (args.demo) {
      const capped = String(r.content || "").slice(0, 3000);
      const text =
        `${r.metadata.title ? "# " + r.metadata.title + "\n\n" : ""}${capped}` +
        `\n\n---\n[demo: truncated at 3000 chars. Full extraction (0.001 USDC, x402 USDC on Base) without demo:true]`;
      return rpcResult(id, {
        content: [{ type: "text", text }],
        metadata: { source: r.metadata.source, title: r.metadata.title },
        demo: true,
      });
    }
    // Paid lane: require x402 header inside the MCP request too.
    // The MCP tool call itself is free to LIST; paid extract is enforced by the gateway:
    // clients should call the HTTP API for paid extracts. Here we return the demo cap
    // unless a valid payment header was relayed (handled by index.js pre-check).
    const capped = String(r.content || "").slice(0, 3000);
    return rpcResult(id, {
      content: [
        {
          type: "text",
          text:
            `${r.metadata.title ? "# " + r.metadata.title + "\n\n" : ""}${capped}` +
            `\n\n---\n[free tier: capped at 3000 chars. For full extraction call the REST API POST ${BASE_URL}/extract with x402 payment (0.001 USDC on Base)]`,
        },
      ],
      metadata: { source: r.metadata.source, title: r.metadata.title, truncated: (r.content || "").length > 3000 },
    });
  } catch (e) {
    return rpcError(id, -32603, e && e.message ? e.message : "Extraction failed");
  }
}