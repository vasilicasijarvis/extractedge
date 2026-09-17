// rl.js — durable-object-free fallback; Workers local limiter.
// Simple in-isolate token bucket; good-enough abuse control for v1.
const BUCKETS = new Map();

export class RateLimiter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    return handleRlRequest(request, BUCKETS);
  }
}

export async function handleRlRequest(request, buckets) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "global";
  const now = Date.now();
  const win = 60000;
  const limit = 30;
  let b = buckets.get(key);
  if (!b || now - b.start > win) {
    b = { start: now, count: 0 };
    buckets.set(key, b);
  }
  b.count++;
  const ok = b.count <= limit;
  return new Response(JSON.stringify({ ok, count: b.count, limit }), {
    headers: { "content-type": "application/json" },
  });
}

export async function checkRate(bucketMap, key, limit = 30, winMs = 60000) {
  const now = Date.now();
  let b = bucketMap.get(key);
  if (!b || now - b.start > winMs) {
    b = { start: now, count: 0 };
    bucketMap.set(key, b);
  }
  b.count++;
  return b.count <= limit;
}