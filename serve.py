#!/usr/bin/env python3
"""
serve.py — the Pure Focus local server (reference implementation for v2-calendar.md §4).

Replaces `python3 -m http.server 8765`. Python standard library only; runs on
macOS /usr/bin/python3 (3.9, LibreSSL) and python.org 3.10+.

  python3 serve.py              -> http://localhost:8765/  (binds 127.0.0.1 only)
  python3 serve.py --port 8792  -> another port (agents: never use 8765)
  python3 serve.py --open       -> also opens the browser

What it does
  1. Serves the site folder (the folder this file lives in, or --root). Dot-paths
     (.git, .DS_Store, .pf-local/…) are never served.
  2. GET  /__pf/health                     -> {"app":"purefocus","v":1,"proxy":true,"canvasHosts":[…]}
  3. GET  /__pf/proxy?url=<https ics>      -> the calendar text (safety limits below)
  4. POST /__pf/canvas/link {host,token}   -> validates a Canvas personal token, stores it in
                                              <root>/.pf-local/canvas.json (0600). The browser never stores it.
     DELETE /__pf/canvas/link?host=<host>
     GET  /__pf/canvas?host=<host>&path=/api/v1/…&<query>  -> merged JSON (allow-listed paths, GET only)

Safety limits on every upstream fetch
  * https only (webcal://, webcals://, http:// are upgraded to https://); port 443 only; no user:pass@.
  * The host must resolve ONLY to public unicast addresses (no loopback, private, link-local,
    CGNAT, multicast, reserved, unspecified, IPv4-mapped/6to4/Teredo-embedded private).
    The connection is pinned to the checked IP (no DNS-rebinding window); TLS verifies the host name.
  * Redirects are followed manually (max 3) and every hop is re-validated.
  * Timeouts: 6 s connect, 20 s total. Size cap: 10 MB (ICS), 4 MB per Canvas page, 10 pages.
  * ICS bodies must start with BEGIN:VCALENDAR (after BOM/whitespace); HTML is rejected.
  * Local-only callers: Host must be localhost/127.0.0.1/[::1]:<port>, the X-PF-Proxy: 1 header is
    required (forces a CORS preflight that this server refuses), Origin/Sec-Fetch-Site must be same-origin.
  * Query strings (they contain secret feed tokens) are never logged.
"""

import argparse
import http.client
import http.server
import ipaddress
import json
import os
import re
import socket
import ssl
import sys
import threading
import time
import urllib.parse
from pathlib import Path

VERSION = 1
ICS_MAX_BYTES = 10 * 1024 * 1024
JSON_PAGE_MAX_BYTES = 4 * 1024 * 1024
CANVAS_MAX_PAGES = 10
CONNECT_TIMEOUT = 6.0
TOTAL_TIMEOUT = 20.0
MAX_REDIRECTS = 3
MAX_URL_LEN = 2048
RATE_PER_MINUTE = 60
USER_AGENT = "PureFocus/1 (calendar import; local)"

BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp")
BLOCKED_NAMES = {"localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback", "metadata", "metadata.google.internal"}

# Canvas REST paths the proxy will call (GET only). Everything else is refused.
CANVAS_PATHS = [
    re.compile(r"^/api/v1/users/self$"),
    re.compile(r"^/api/v1/users/self/todo$"),
    re.compile(r"^/api/v1/users/self/upcoming_events$"),
    re.compile(r"^/api/v1/planner/items$"),
    re.compile(r"^/api/v1/courses$"),
    re.compile(r"^/api/v1/courses/\d{1,15}$"),
    re.compile(r"^/api/v1/courses/\d{1,15}/assignments$"),
    re.compile(r"^/api/v1/courses/\d{1,15}/assignment_groups$"),
]
CANVAS_HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")


class ProxyError(Exception):
    """code is the stable error id the web client maps to copy (v2-calendar.md §4.4)."""

    def __init__(self, http_status, code, message, upstream=None):
        super().__init__(message)
        self.http_status = http_status
        self.code = code
        self.message = message
        self.upstream = upstream


# ───────────────────────────── URL + address validation (pure) ─────────────────────────────

def normalize_url(raw):
    """Returns a urllib SplitResult for an https URL on port 443, or raises ProxyError(bad_url)."""
    s = (raw or "").strip()
    if not s or len(s) > MAX_URL_LEN or any(c in s for c in "\r\n\t\x00 "):
        raise ProxyError(400, "bad_url", "That doesn't look like a calendar link.")
    low = s.lower()
    for prefix in ("webcals://", "webcal://", "http://"):
        if low.startswith(prefix):
            s = "https://" + s[len(prefix):]
            break
    try:
        parts = urllib.parse.urlsplit(s)
    except ValueError:
        raise ProxyError(400, "bad_url", "That doesn't look like a calendar link.")
    if parts.scheme.lower() != "https":
        raise ProxyError(400, "bad_url", "Calendar links must start with https://, http:// or webcal://.")
    if "@" in parts.netloc:
        raise ProxyError(400, "bad_url", "Links with a user name or password aren't supported.")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise ProxyError(400, "bad_url", "That link has no host name.")
    try:
        port = parts.port
    except ValueError:
        raise ProxyError(400, "bad_url", "That link has an invalid port.")
    if port not in (None, 443):
        raise ProxyError(400, "bad_url", "Only standard https links (port 443) are supported.")
    path = parts.path or "/"
    return urllib.parse.SplitResult("https", host, path, parts.query, "")


def is_public_ip(text):
    try:
        ip = ipaddress.ip_address(text.split("%", 1)[0])
    except ValueError:
        return False
    if ip.version == 6:
        for embedded in (ip.ipv4_mapped, ip.sixtofour, (ip.teredo[1] if ip.teredo else None)):
            if embedded is not None and not is_public_ip(str(embedded)):
                return False
    if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved
            or ip.is_unspecified or not ip.is_global):
        return False
    return True


def resolve_public(host, resolver=None):
    """All addresses for host, each verified public. Raises ProxyError(blocked_host)."""
    resolver = resolver or socket.getaddrinfo
    if host in BLOCKED_NAMES or host.endswith(BLOCKED_SUFFIXES) or "." not in host.strip("[]"):
        raise ProxyError(403, "blocked_host", "Links to this computer or a private network aren't allowed.")
    try:
        infos = resolver(host, 443, 0, socket.SOCK_STREAM)
    except socket.gaierror:
        raise ProxyError(502, "dns_failed", "Couldn't find that calendar's server. Check the link.")
    addrs = []
    for info in infos:
        addr = info[4][0]
        if addr not in addrs:
            addrs.append(addr)
    if not addrs:
        raise ProxyError(502, "dns_failed", "Couldn't find that calendar's server. Check the link.")
    if not all(is_public_ip(a) for a in addrs):
        raise ProxyError(403, "blocked_host", "Links to this computer or a private network aren't allowed.")
    return addrs


def looks_like_calendar(body):
    head = body[:2048].lstrip(b"\xef\xbb\xbf \t\r\n")
    return head[:15].upper() == b"BEGIN:VCALENDAR"


def mask_url(url):
    """Display form for a secret link: host + last path segment shortened. Never log the full URL."""
    try:
        p = urllib.parse.urlsplit(url)
        last = (p.path.rsplit("/", 1)[-1] or "")
        tail = ("…" + last[-8:]) if len(last) > 8 else last
        return "%s/…/%s" % (p.hostname or "?", tail)
    except Exception:
        return "(link)"


# ───────────────────────────── TLS + pinned connections ─────────────────────────────

def make_ssl_context():
    ctx = ssl.create_default_context()
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    if ctx.cert_store_stats().get("x509_ca", 0) == 0:
        # python.org builds ship an empty CA folder until "Install Certificates.command" runs.
        loaded = False
        try:
            import certifi  # optional, user site-packages
            ctx.load_verify_locations(cafile=certifi.where())
            loaded = True
        except Exception:
            pass
        if not loaded:
            for cafile in ("/etc/ssl/cert.pem", "/private/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
                if os.path.exists(cafile):
                    try:
                        ctx.load_verify_locations(cafile=cafile)
                        break
                    except Exception:
                        continue
    return ctx


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Connects to a pre-validated IP while verifying TLS for the original host name."""

    def __init__(self, host, ip, context, timeout):
        super().__init__(host, 443, timeout=timeout, context=context)
        self._pf_ip = ip
        self._pf_ctx = context

    def connect(self):
        sock = socket.create_connection((self._pf_ip, 443), timeout=CONNECT_TIMEOUT)
        sock.settimeout(self.timeout)
        self.sock = self._pf_ctx.wrap_socket(sock, server_hostname=self.host)


def default_open(parts, ip, headers, ctx, timeout):
    conn = PinnedHTTPSConnection(parts.hostname, ip, ctx, timeout)
    target = parts.path + ("?" + parts.query if parts.query else "")
    # a link pasted with accents or spaces: http.client only sends plain ASCII
    target = urllib.parse.quote(target, safe="/?&=%:@!$'()*+,;~-._")
    conn.request("GET", target, headers=headers)
    return conn, conn.getresponse()


def fetch(url, *, accept, max_bytes, etag=None, auth=None, same_host=None,
          resolver=None, opener=None, ctx=None, clock=time.monotonic):
    """GET with every safety check. Returns (status, body_bytes, headers_dict, final_host).
    status is 200 or 304. Raises ProxyError for anything else."""
    opener = opener or default_open
    deadline = clock() + TOTAL_TIMEOUT
    parts = normalize_url(url)
    for _hop in range(MAX_REDIRECTS + 1):
        if same_host and parts.hostname != same_host:
            raise ProxyError(403, "blocked_host", "Canvas tried to send us to another site.")
        ips = resolve_public(parts.hostname, resolver)
        headers = {"Host": parts.hostname, "User-Agent": USER_AGENT, "Accept": accept,
                   "Accept-Encoding": "identity", "Connection": "close"}
        if etag:
            headers["If-None-Match"] = etag
        if auth:
            headers["Authorization"] = auth
        remaining = deadline - clock()
        if remaining <= 0:
            raise ProxyError(504, "timeout", "The calendar server took too long to answer.")
        try:
            conn, resp = opener(parts, ips[0], headers, ctx, min(remaining, TOTAL_TIMEOUT))
        except ssl.SSLError:
            raise ProxyError(502, "tls_error", "Couldn't make a secure connection to that server.")
        except (socket.timeout, TimeoutError):
            raise ProxyError(504, "timeout", "The calendar server took too long to answer.")
        except (OSError, UnicodeError, http.client.HTTPException):
            raise ProxyError(502, "connect_failed", "Couldn't reach that calendar's server.")
        try:
            status = resp.status
            if status in (301, 302, 303, 307, 308):
                loc = resp.getheader("Location")
                if not loc:
                    raise ProxyError(502, "upstream_status", "The calendar server sent a broken redirect.", status)
                try:
                    parts = normalize_url(urllib.parse.urljoin(urllib.parse.urlunsplit(parts), loc))
                except ValueError:
                    raise ProxyError(502, "upstream_status", "The calendar server sent a broken redirect.", status)
                continue
            if status == 304:
                return 304, b"", {"etag": resp.getheader("ETag")}, parts.hostname
            if status != 200:
                raise ProxyError(502, "upstream_status", "The calendar server said no (HTTP %d)." % status, status)
            length = resp.getheader("Content-Length")
            if length and length.isdigit() and int(length) > max_bytes:
                raise ProxyError(413, "too_large", "That calendar is too large to import.")
            chunks, total = [], 0
            while True:
                if clock() > deadline:
                    raise ProxyError(504, "timeout", "The calendar server took too long to answer.")
                try:
                    chunk = resp.read(65536)
                except (socket.timeout, TimeoutError):
                    raise ProxyError(504, "timeout", "The calendar server took too long to answer.")
                except (OSError, http.client.HTTPException):
                    raise ProxyError(502, "connect_failed", "Couldn't reach that calendar's server.")
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise ProxyError(413, "too_large", "That calendar is too large to import.")
                chunks.append(chunk)
            hdrs = {"etag": resp.getheader("ETag"), "link": resp.getheader("Link"),
                    "content-type": (resp.getheader("Content-Type") or "").lower()}
            return 200, b"".join(chunks), hdrs, parts.hostname
        finally:
            try:
                conn.close()
            except Exception:
                pass
    raise ProxyError(502, "too_many_redirects", "That link redirects too many times.")


# ───────────────────────────── Canvas helpers ─────────────────────────────

def next_link(link_header):
    """rel="next" from a Link header (case-insensitive, URLs opaque)."""
    if not link_header:
        return None
    for part in link_header.split(","):
        m = re.match(r'\s*<([^>]+)>\s*;(.*)$', part)
        if m and re.search(r'rel\s*=\s*"?next"?', m.group(2), re.I):
            return m.group(1)
    return None


def canvas_path_allowed(path):
    return any(rx.match(path) for rx in CANVAS_PATHS)


class SecretStore:
    """<root>/.pf-local/canvas.json, mode 0600 ({host: token}). Never served, never logged."""

    def __init__(self, root):
        self.dir = Path(root) / ".pf-local"
        self.file = self.dir / "canvas.json"
        self.lock = threading.Lock()

    def _read(self):
        try:
            return json.loads(self.file.read_text("utf-8"))
        except Exception:
            return {}

    def hosts(self):
        with self.lock:
            return sorted(self._read().keys())

    def get(self, host):
        with self.lock:
            return self._read().get(host)

    def put(self, host, token):
        with self.lock:
            data = self._read()
            data[host] = token
            self.dir.mkdir(mode=0o700, exist_ok=True)
            tmp = self.file.with_suffix(".tmp")
            fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f)
            os.replace(str(tmp), str(self.file))

    def delete(self, host):
        with self.lock:
            data = self._read()
            if data.pop(host, None) is not None and self.file.exists():
                fd = os.open(str(self.file), os.O_WRONLY | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(data, f)


class RateLimiter:
    def __init__(self, per_minute):
        self.capacity = float(per_minute)
        self.tokens = float(per_minute)
        self.rate = per_minute / 60.0
        self.stamp = time.monotonic()
        self.lock = threading.Lock()

    def allow(self):
        with self.lock:
            now = time.monotonic()
            self.tokens = min(self.capacity, self.tokens + (now - self.stamp) * self.rate)
            self.stamp = now
            if self.tokens >= 1:
                self.tokens -= 1
                return True
            return False


# ───────────────────────────── HTTP handler ─────────────────────────────

class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = "PureFocus/%d" % VERSION
    sys_version = ""
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map, **{
        ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
        ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
        ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "video/mp4",
    })

    # -- plumbing --
    def log_message(self, fmt, *args):  # never log query strings (feed secrets)
        sys.stderr.write("%s %s %s\n" % (self.command, self.path.split("?", 1)[0], args[1] if len(args) > 1 else ""))

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if not self.path.startswith("/__pf/"):
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def _send_range(self):
        """Serve a byte range of a static file (206). Safari needs this to play <audio>/<video>.
        Returns True when the request was handled here."""
        rng = self.headers.get("Range")
        if not rng or not rng.startswith("bytes=") or "," in rng:
            return False
        fpath = self.translate_path(self.path)
        if not os.path.isfile(fpath):
            return False
        size = os.path.getsize(fpath)
        a, _, b = rng[6:].strip().partition("-")
        try:
            if a == "":
                n = int(b)
                if n <= 0:
                    raise ValueError
                start, end = max(0, size - n), size - 1
            else:
                start = int(a)
                end = int(b) if b else size - 1
                end = min(end, size - 1)
        except ValueError:
            return False
        if size == 0 or start > end or start >= size:
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return True
        length = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(fpath))
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(length))
        self.send_header("Last-Modified", self.date_time_string(int(os.path.getmtime(fpath))))
        self.end_headers()
        if self.command == "HEAD":
            return True
        with open(fpath, "rb") as f:
            f.seek(start)
            left = length
            try:
                while left > 0:
                    chunk = f.read(min(65536, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
        return True

    def _json(self, status, obj, extra=None):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            if v:
                self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, err):
        payload = {"error": err.code, "message": err.message}
        if err.upstream:
            payload["upstreamStatus"] = err.upstream
        self._json(err.http_status, payload)

    def _guard(self):
        """Only same-origin pages served by this process may call /__pf/*."""
        port = self.server.server_address[1]
        allowed_hosts = {"localhost:%d" % port, "127.0.0.1:%d" % port, "[::1]:%d" % port}
        allowed_origins = {"http://" + h for h in allowed_hosts}
        if (self.headers.get("Host") or "").lower() not in allowed_hosts:
            raise ProxyError(403, "forbidden", "Open Pure Focus at http://localhost:%d/." % port)
        if self.headers.get("X-PF-Proxy") != "1":
            raise ProxyError(403, "forbidden", "Missing X-PF-Proxy header.")
        origin = self.headers.get("Origin")
        if origin and origin.lower() not in allowed_origins:
            raise ProxyError(403, "forbidden", "Cross-site requests aren't allowed.")
        site = self.headers.get("Sec-Fetch-Site")
        if site and site not in ("same-origin", "none"):
            raise ProxyError(403, "forbidden", "Cross-site requests aren't allowed.")
        if not self.server.rate.allow():
            raise ProxyError(429, "rate_limited", "Too many calendar requests. Try again in a minute.")

    def _query(self):
        return urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query, keep_blank_values=True)

    def _static_ok(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        return not any(seg.startswith(".") for seg in path.split("/") if seg)

    # -- verbs --
    def do_OPTIONS(self):  # no CORS, ever
        self._json(403, {"error": "forbidden", "message": "Cross-site requests aren't allowed."})

    def do_HEAD(self):
        if self.path.startswith("/__pf/") or not self._static_ok():
            self.send_error(404)
            return
        if not self._send_range():
            super().do_HEAD()

    def do_GET(self):
        if not self.path.startswith("/__pf/"):
            if not self._static_ok():
                self.send_error(404)
                return
            if not self._send_range():
                super().do_GET()
            return
        route = urllib.parse.urlsplit(self.path).path
        try:
            self._guard()
            if route == "/__pf/health":
                self._json(200, {"app": "purefocus", "v": VERSION, "proxy": True,
                                 "tls": self.server.tls_ok, "canvasHosts": self.server.secrets.hosts()})
            elif route == "/__pf/proxy":
                self._proxy_ics()
            elif route == "/__pf/canvas":
                self._canvas_get()
            else:
                raise ProxyError(404, "not_found", "Unknown endpoint.")
        except ProxyError as e:
            self._error(e)

    def do_POST(self):
        try:
            self._guard()
            if urllib.parse.urlsplit(self.path).path != "/__pf/canvas/link":
                raise ProxyError(404, "not_found", "Unknown endpoint.")
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 4096:
                raise ProxyError(400, "bad_request", "Bad request.")
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception:
                raise ProxyError(400, "bad_request", "Bad request.")
            host = canvas_host(body.get("host"))
            token = str(body.get("token") or "").strip()
            if not re.match(r"^[A-Za-z0-9~_.\-]{20,200}$", token):
                raise ProxyError(400, "bad_token", "That doesn't look like a Canvas access token.")
            status, raw, _h, _host = self._fetch(
                urllib.parse.urlunsplit(("https", host, "/api/v1/users/self", "", "")),
                accept="application/json", max_bytes=JSON_PAGE_MAX_BYTES,
                auth="Bearer " + token, same_host=host)
            user = parse_json(raw)
            self.server.secrets.put(host, token)
            self._json(200, {"host": host, "user": {"id": user.get("id"), "name": user.get("name")}})
        except ProxyError as e:
            if e.code == "upstream_status" and e.upstream in (401, 403):
                e = ProxyError(401, "canvas_unauthorized", "Canvas didn't accept that token.")
            self._error(e)

    def do_DELETE(self):
        try:
            self._guard()
            if urllib.parse.urlsplit(self.path).path != "/__pf/canvas/link":
                raise ProxyError(404, "not_found", "Unknown endpoint.")
            host = canvas_host((self._query().get("host") or [""])[0])
            self.server.secrets.delete(host)
            self._json(200, {"ok": True})
        except ProxyError as e:
            self._error(e)

    # -- routes --
    def _fetch(self, url, **kw):
        with self.server.upstream_slots:
            return fetch(url, ctx=self.server.ssl_ctx, resolver=self.server.resolver,
                         opener=self.server.opener, **kw)

    def _proxy_ics(self):
        q = self._query()
        url = (q.get("url") or [""])[0]
        etag = self.headers.get("X-PF-If-None-Match") or None
        status, body, hdrs, final_host = self._fetch(
            url, accept="text/calendar, text/plain;q=0.9, */*;q=0.5", max_bytes=ICS_MAX_BYTES, etag=etag)
        if status == 304:
            self.send_response(304)
            self.send_header("Cache-Control", "no-store")
            if hdrs.get("etag"):
                self.send_header("X-PF-ETag", hdrs["etag"])
            self.end_headers()
            return
        if not looks_like_calendar(body):
            raise ProxyError(422, "not_calendar", "That link didn't return a calendar. Copy the iCal/ICS link, not the web page.")
        self.send_response(200)
        self.send_header("Content-Type", "text/calendar; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        if hdrs.get("etag"):
            self.send_header("X-PF-ETag", hdrs["etag"])
        self.send_header("X-PF-Final-Host", final_host)
        self.end_headers()
        self.wfile.write(body)

    def _canvas_get(self):
        q = self._query()
        host = canvas_host((q.pop("host", [""]))[0])
        path = (q.pop("path", [""]))[0]
        if not canvas_path_allowed(path):
            raise ProxyError(403, "path_not_allowed", "That Canvas request isn't allowed.")
        token = self.server.secrets.get(host)
        if not token:
            raise ProxyError(401, "canvas_not_linked", "Link Canvas in Settings first.")
        query = urllib.parse.urlencode([(k, v) for k, vs in q.items() for v in vs])
        url = urllib.parse.urlunsplit(("https", host, path, query, ""))
        merged, single = [], None
        for _page in range(CANVAS_MAX_PAGES):
            try:
                status, raw, hdrs, _h = self._fetch(url, accept="application/json", max_bytes=JSON_PAGE_MAX_BYTES,
                                                    auth="Bearer " + token, same_host=host)
            except ProxyError as e:
                if e.code == "upstream_status" and e.upstream in (401, 403):
                    raise ProxyError(401, "canvas_unauthorized", "Canvas no longer accepts the saved token. Link Canvas again.")
                raise
            data = parse_json(raw)
            if isinstance(data, list):
                merged.extend(data)
            else:
                single = data
                break
            nxt = next_link(hdrs.get("link"))
            if not nxt:
                break
            url = nxt
        self._json(200, single if single is not None else merged)


def canvas_host(raw):
    host = (raw or "").strip().lower()
    host = re.sub(r"^https?://", "", host).split("/", 1)[0].rstrip(".")
    if not CANVAS_HOST_RE.match(host):
        raise ProxyError(400, "bad_host", "Enter your school's Canvas address, like school.instructure.com.")
    return host


def parse_json(raw):
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        raise ProxyError(502, "bad_upstream", "Canvas sent something unexpected.")


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    # The app loads about 56 files in one burst. The default queue of 5 waiting connections overflowed
    # on reloads and the browser got ERR_CONNECTION_RESET, silently losing whichever files those were.
    request_queue_size = 128
    allow_reuse_address = True

    def __init__(self, addr, root, resolver=None, opener=None):
        handler = lambda *a, **kw: Handler(*a, directory=str(root), **kw)  # noqa: E731
        super().__init__(addr, handler)
        self.root = Path(root)
        self.ssl_ctx = make_ssl_context()
        self.tls_ok = self.ssl_ctx.cert_store_stats().get("x509_ca", 0) > 0
        self.resolver = resolver
        self.opener = opener
        self.secrets = SecretStore(root)
        self.rate = RateLimiter(RATE_PER_MINUTE)
        self.upstream_slots = threading.BoundedSemaphore(4)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Serve Pure Focus locally with a safe calendar proxy.")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PF_PORT", "8765")))
    ap.add_argument("--root", default=str(Path(__file__).resolve().parent))
    ap.add_argument("--open", action="store_true", help="open the app in the default browser")
    args = ap.parse_args(argv)
    srv = Server(("127.0.0.1", args.port), args.root)
    url = "http://localhost:%d/" % args.port
    print("Pure Focus is running at %s  (app: %sapp.html)  ·  Ctrl-C to stop" % (url, url))
    if not srv.tls_ok:
        print("Warning: no HTTPS root certificates found, so calendar links can't load.\n"
              "Run /Applications/Python 3.x/Install Certificates.command, or start with /usr/bin/python3 serve.py")
    if args.open:
        import webbrowser
        webbrowser.open(url + "app.html")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
