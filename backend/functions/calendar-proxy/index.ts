/**
 * Supabase Edge Function: calendar-proxy
 *
 * Fetches an iCal/ICS feed for the signed-in web app so calendar links work
 * without the local `serve.py` helper. The browser cannot fetch most calendar
 * hosts directly because they do not send CORS headers.
 *
 * Contract used by js/feeds.js:
 *   GET  ?ping=1                 -> { ok: true, calendarProxy: true }
 *   GET  ?url=<encoded https>    -> text/calendar (X-PF-ETag when supplied)
 *   POST { url, etag? }          -> text/calendar (preferred: keeps the URL
 *                                   out of the request line and platform logs)
 *
 * Safety:
 *   - requires a valid Supabase user token;
 *   - https only, port 443 only, no user:pass;
 *   - blocks localhost, private, link-local and other non-public addresses;
 *   - revalidates every redirect (max 3);
 *   - 20 s total timeout, 10 MB cap;
 *   - only BEGIN:VCALENDAR bodies are returned;
 *   - never logs the calendar URL.
 *
 * Deploy once in Supabase Dashboard -> Edge Functions -> Via Editor, name it
 * `calendar-proxy`, and leave "Verify JWT" off (the function verifies the
 * caller itself so it can return the app's JSON error codes).
 */

const MAX_URL_LEN = 2048;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TOTAL_TIMEOUT_MS = 20_000;
const RATE_PER_MINUTE = 60;

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];
const BLOCKED_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback', 'metadata', 'metadata.google.internal']);

class ProxyError extends Error {
  status: number;
  code: string;
  upstreamStatus?: number;
  constructor(status: number, code: string, message: string, upstreamStatus?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}

type FetchResult = { status: 200; text: string; etag: string | null } | { status: 304; etag: string | null };

function normalizeUrl(raw: string): URL {
  let s = String(raw || '').trim();
  if (!s || s.length > MAX_URL_LEN || /[\r\n\t\0 ]/.test(s)) {
    throw new ProxyError(400, 'bad_url', 'That doesn’t look like a calendar link.');
  }
  const low = s.toLowerCase();
  for (const prefix of ['webcals://', 'webcal://', 'http://']) {
    if (low.startsWith(prefix)) { s = 'https://' + s.slice(prefix.length); break; }
  }
  let u: URL;
  try { u = new URL(s); } catch { throw new ProxyError(400, 'bad_url', 'That doesn’t look like a calendar link.'); }
  if (u.protocol !== 'https:') throw new ProxyError(400, 'bad_url', 'Calendar links must start with https://, http:// or webcal://.');
  if (u.username || u.password) throw new ProxyError(400, 'bad_url', 'Links with a user name or password aren’t supported.');
  if (u.port && u.port !== '443') throw new ProxyError(400, 'bad_port', 'Links with a port number can’t be added.');
  if (!u.hostname) throw new ProxyError(400, 'bad_url', 'That link has no host name.');
  u.hash = '';
  return u;
}

function isPublicIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIPv6(ip: string): boolean {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (s === '::' || s === '::1') return false;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIPv4(mapped[1]);
  if (!s.includes(':')) return false;
  const first = s.split(':')[0];
  if (!first) return false; // ::/..., ::ffff:... handled above
  const n = parseInt(first, 16);
  if (!Number.isFinite(n)) return false;
  // Global unicast is 2000::/3. Everything else (ULA fc00::/7, link-local
  // fe80::/10, multicast ff00::/8, loopback, unspecified) is rejected.
  if (n < 0x2000 || n > 0x3fff) return false;
  if (s.startsWith('2001:db8:')) return false;       // documentation
  if (s.startsWith('2001:0:') || s.startsWith('2001:0000:')) return false; // Teredo
  if (s.startsWith('2001:2:') || s.startsWith('2001:10:') || s.startsWith('2001:20:')) return false;
  return true;
}

function isPublicIp(ip: string): boolean {
  return ip.includes(':') ? isPublicIPv6(ip) : isPublicIPv4(ip);
}

/** DNS-over-HTTPS fallback for runtimes where Deno.resolveDns is unavailable. */
async function dohLookup(host: string, type: 'A' | 'AAAA'): Promise<string[]> {
  const want = type === 'A' ? 1 : 28;
  const endpoints = [
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
    `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=${type}`,
  ];
  for (const endpoint of endpoints) {
    try {
      const r = await fetch(endpoint, {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const answers = Array.isArray(j.Answer) ? j.Answer : [];
      const ips = answers.filter((a: { type?: number }) => a.type === want)
        .map((a: { data?: string }) => String(a.data || '').trim())
        .filter(Boolean);
      if (ips.length) return ips;
    } catch { /* try the next resolver */ }
  }
  return [];
}

async function resolvePublic(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes('.')) {
    throw new ProxyError(403, 'blocked_host', 'Links to this computer or a private network can’t be added.');
  }
  // IP literals are checked directly; DNS lookups are checked before fetch.
  const bare = host.replace(/^\[|\]$/g, '');
  if (bare.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(bare)) {
    if (!isPublicIp(bare)) throw new ProxyError(403, 'blocked_host', 'Links to this computer or a private network can’t be added.');
    return;
  }
  let ips: string[] = [];
  try {
    if (typeof Deno.resolveDns === 'function') {
      const [a, aaaa] = await Promise.all([
        Deno.resolveDns(host, 'A').catch(() => [] as string[]),
        Deno.resolveDns(host, 'AAAA').catch(() => [] as string[]),
      ]);
      ips = [...a, ...aaaa];
    }
  } catch { /* fall through to DoH */ }
  if (!ips.length) {
    const [a, aaaa] = await Promise.all([dohLookup(host, 'A'), dohLookup(host, 'AAAA')]);
    ips = [...a, ...aaaa];
  }
  if (!ips.length) throw new ProxyError(502, 'dns_failed', 'Couldn’t find that calendar’s server. Check the link.');
  if (!ips.every(isPublicIp)) throw new ProxyError(403, 'blocked_host', 'Links to this computer or a private network can’t be added.');
}

function looksLikeCalendar(text: string): boolean {
  const head = text.slice(0, 2048).replace(/^\uFEFF/, '').trimStart().toUpperCase();
  return head.startsWith('BEGIN:VCALENDAR');
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const length = res.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    throw new ProxyError(413, 'too_large', 'That calendar is too large (over 10 MB). Export a shorter range.');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ProxyError(413, 'too_large', 'That calendar is too large (over 10 MB). Export a shorter range.');
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/** Fetch one calendar. Exported so the local Deno test can call it directly. */
export async function fetchCalendar(rawUrl: string, etag: string | null = null): Promise<FetchResult> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let url = normalizeUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await resolvePublic(url.hostname);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ProxyError(504, 'timeout', 'The calendar server took too long to answer.');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Accept': 'text/calendar, text/plain, */*;q=0.8',
          'Accept-Encoding': 'identity',
          'User-Agent': 'PureFocus/1 (calendar import; cloud)',
          ...(etag ? { 'If-None-Match': etag } : {}),
        },
      });
    } catch (err) {
      if (controller.signal.aborted) throw new ProxyError(504, 'timeout', 'The calendar server took too long to answer.');
      throw new ProxyError(502, 'connect_failed', 'Couldn’t reach that calendar’s server.');
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new ProxyError(502, 'upstream_status', 'The calendar server sent a broken redirect.', res.status);
      try { url = normalizeUrl(new URL(loc, url).toString()); }
      catch { throw new ProxyError(502, 'upstream_status', 'The calendar server sent a broken redirect.', res.status); }
      continue;
    }
    if (res.status === 304) return { status: 304, etag: res.headers.get('etag') };
    if (!res.ok) {
      throw new ProxyError(502, 'upstream_status', `The calendar server said no (HTTP ${res.status}).`, res.status);
    }

    const text = await readCapped(res, MAX_BYTES);
    if (!looksLikeCalendar(text)) {
      throw new ProxyError(502, 'not_calendar', 'That link opened a web page, not a calendar. Use the iCal/ICS link.');
    }
    return { status: 200, text, etag: res.headers.get('etag') };
  }
  throw new ProxyError(502, 'too_many_redirects', 'That link redirects too many times.');
}

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-pf-proxy, x-pf-if-none-match',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Expose-Headers': 'X-PF-ETag',
    'Vary': 'Origin',
  };
}

function json(body: unknown, status: number, req: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), 'Content-Type': 'application/json; charset=utf-8' },
  });
}

const buckets = new Map<string, { tokens: number; at: number }>();
function rateLimit(userId: string): void {
  const now = Date.now();
  const b = buckets.get(userId) || { tokens: RATE_PER_MINUTE, at: now };
  b.tokens = Math.min(RATE_PER_MINUTE, b.tokens + ((now - b.at) / 60000) * RATE_PER_MINUTE);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(userId, b);
    throw new ProxyError(429, 'rate_limited', 'Too many refreshes. Try again in a minute.');
  }
  b.tokens -= 1;
  buckets.set(userId, b);
}

async function requireUser(req: Request): Promise<{ id: string }> {
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) throw new ProxyError(401, 'not_signed_in', 'Sign in to add a calendar.');
  const base = Deno.env.get('SUPABASE_URL') || '';
  const key = Deno.env.get('SUPABASE_ANON_KEY') || req.headers.get('apikey') || '';
  if (!base || !key) throw new ProxyError(500, 'config', 'Calendar proxy is not configured.');
  let res: Response;
  try {
    res = await fetch(`${base}/auth/v1/user`, { headers: { Authorization: auth, apikey: key } });
  } catch {
    throw new ProxyError(502, 'auth_unreachable', 'Couldn’t check your session. Try again.');
  }
  if (!res.ok) throw new ProxyError(401, 'not_signed_in', 'Sign in to add a calendar.');
  const user = await res.json().catch(() => null);
  if (!user || !user.id) throw new ProxyError(401, 'not_signed_in', 'Sign in to add a calendar.');
  return { id: String(user.id) };
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json({ error: 'method_not_allowed', message: 'Use GET or POST.' }, 405, req);
  }
  try {
    const user = await requireUser(req);
    rateLimit(user.id);

    if (new URL(req.url).searchParams.get('ping') === '1') {
      return json({ ok: true, calendarProxy: true }, 200, req);
    }

    let url = '';
    let etag: string | null = req.headers.get('x-pf-if-none-match');
    if (req.method === 'POST') {
      const body = await req.json().catch(() => null);
      url = body && typeof body.url === 'string' ? body.url : '';
      if (body && typeof body.etag === 'string') etag = body.etag;
    } else {
      url = new URL(req.url).searchParams.get('url') || '';
    }
    if (!url) throw new ProxyError(400, 'bad_url', 'No calendar link was supplied.');

    const result = await fetchCalendar(url, etag);
    if (result.status === 304) {
      return new Response(null, { status: 304, headers: { ...cors(req), ...(result.etag ? { 'X-PF-ETag': result.etag } : {}) } });
    }
    return new Response(result.text, {
      status: 200,
      headers: {
        ...cors(req),
        'Content-Type': 'text/calendar; charset=utf-8',
        'Cache-Control': 'no-store',
        ...(result.etag ? { 'X-PF-ETag': result.etag } : {}),
      },
    });
  } catch (err) {
    if (err instanceof ProxyError) {
      return json({ error: err.code, message: err.message, upstreamStatus: err.upstreamStatus }, err.status, req);
    }
    return json({ error: 'proxy_error', message: 'Something went wrong. Try again.' }, 500, req);
  }
}

// Supabase imports the function module rather than running it as `main`, so
// start the server when either condition holds. The Deno tests import the
// helpers without SUPABASE_URL set and therefore don't start a listener.
if (import.meta.main || Deno.env.get('SUPABASE_URL')) Deno.serve(handleRequest);
