#!/usr/bin/env node
/**
 * Roleplay Card Converter - server
 * =========================================================================
 * Does two jobs, and runs in two places.
 *
 * 1. Serves the tool itself (index.html, style.css, js/). That means this one
 *    process is the whole thing - no Live Server needed, and because the page
 *    is then same-origin with the proxy below, there is nothing to configure.
 *
 * 2. Proxies the one request the browser cannot make itself.
 *    character-tavern.com/api/search/cards sends no Access-Control-Allow-Origin
 *    header and answers a CORS preflight with 405, so a page can never read it
 *    directly. This repeats that request server-side and hands it back with
 *    permissive CORS headers.
 *
 * Everything else - all of chub.ai, and Character Tavern's card files and
 * avatars - is served with ACAO: * and goes straight from the browser, so with
 * this server stopped the tool still works apart from library mirroring.
 *
 * Run it on your own machine:
 *
 *   npm start               serve at http://127.0.0.1:8787
 *   npm run start:open      serve and open the tool in your browser
 *   PORT=8788 npm start     use a different port
 *
 * Or deploy it, so a hosted copy of the tool can mirror libraries without
 * anyone installing anything - see README. On a host it binds 0.0.0.0 and
 * takes the port from the environment, which is what those platforms expect.
 *
 * Deliberately dependency-free so it works with a bare Node install and needs
 * no build step or lockfile anywhere.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 8787;

// Locally, bind loopback so the server is not exposed to the rest of the
// network. On a hosting platform the opposite is required: the load balancer
// reaches the process over the container's network, so loopback would look
// like a service that never starts.
const IS_HOSTED = Boolean(process.env.RENDER || process.env.FLY_APP_NAME || process.env.DYNO);
const HOST = process.env.HOST || (IS_HOSTED ? '0.0.0.0' : '127.0.0.1');

const ROOT = __dirname;
const OPEN_BROWSER = process.argv.includes('--open');

/* ---------------- static file serving ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

function serveStatic(pathname, res) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);

  // Resolve first, then confirm the result is still inside the tool folder -
  // without this, a request for /../../secrets would escape ROOT.
  const full = path.resolve(ROOT, '.' + rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }

    // Tell the page it was served by us. Without this it would have to guess
    // where the proxy lives by probing, and a probe that misses logs a console
    // error nothing can catch. This makes it a fact instead of a guess, so the
    // page finds the proxy on its own origin whatever port it is on.
    if (path.basename(full).toLowerCase() === 'index.html') {
      data = Buffer.from(
        data.toString('utf8').replace('</head>', '<script>window.__rccServedByProxy = true;</script>\n</head>')
      );
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ---------------- the proxy hop ---------------- */

// Without this the script would be an open relay that any page in your browser
// could aim at your local network.
const ALLOWED_HOSTS = [
  'character-tavern.com',
  'ct-cards.storage.character-tavern.com',
  'chub.ai',
  'api.chub.ai',
  'avatars.charhub.io',
];

function hostAllowed(hostname) {
  const h = hostname.toLowerCase();
  return ALLOWED_HOSTS.some(a => h === a || h.endsWith('.' + a));
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function jsonError(res, code, body) {
  setCors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/* ---------------- rate limit ---------------- */

// The host allow-list already stops this being an open relay, but a deployed
// instance is still a URL anyone can hammer, and on a free tier that is someone
// else's bill. A plain fixed window per IP is enough: real use is a handful of
// search requests per library page, nowhere near this.
//
// Skipped entirely when bound to loopback - rate limiting yourself is pointless
// and would only get in the way of a big local mirror.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 90;
const hits = new Map();

function rateLimited(req) {
  if (!IS_HOSTED && HOST === '127.0.0.1') return false;

  // Behind a platform proxy the socket address is the load balancer, so the
  // real client is only in the forwarded header.
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  const seen = hits.get(ip);
  if (!seen || now - seen.start > RATE_WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });

    // Old entries would otherwise accumulate for every IP ever seen. Cheap to
    // sweep here because it only runs when a window rolls over.
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now - v.start > RATE_WINDOW_MS) hits.delete(k);
    }
    return false;
  }

  seen.count++;
  return seen.count > RATE_MAX;
}

// Redirects are followed here rather than handed back: the browser cannot see
// a cross-host 3xx through a proxy hop.
function passThrough(targetUrl, req, res, depth = 0) {
  if (depth > 5) return jsonError(res, 508, { error: 'Too many redirects' });

  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return jsonError(res, 400, { error: 'Malformed url parameter' });
  }

  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return jsonError(res, 400, { error: 'Only http(s) URLs are allowed' });
  }
  if (!hostAllowed(target.hostname)) {
    return jsonError(res, 403, {
      error: 'Host not allowed: ' + target.hostname,
      hint: 'Add it to ALLOWED_HOSTS in proxy.js if you trust it.',
    });
  }

  // No Origin header: this is a plain server-side GET, and dressing it up as a
  // cross-site browser request only makes it look like something to block.
  const headers = {
    'User-Agent': UA,
    'Accept': req.headers['accept'] || '*/*',
    'Referer': `https://${target.hostname}/`,
  };
  if (req.headers['x-proxy-auth']) headers['Authorization'] = req.headers['x-proxy-auth'];

  const lib = target.protocol === 'https:' ? https : http;
  const upstream = lib.request(target, { method: 'GET', headers, timeout: 45000 }, up => {
    const loc = up.headers.location;
    if (loc && up.statusCode >= 300 && up.statusCode < 400) {
      up.resume();
      return passThrough(new URL(loc, target).href, req, res, depth + 1);
    }
    setCors(res);
    for (const h of ['content-type', 'content-length', 'content-encoding']) {
      if (up.headers[h]) res.setHeader(h, up.headers[h]);
    }
    res.writeHead(up.statusCode || 502);
    up.pipe(res);
  });

  upstream.on('timeout', () => upstream.destroy(new Error('Upstream timeout')));
  upstream.on('error', err => {
    if (res.headersSent) return res.end();
    jsonError(res, 502, { error: 'Upstream request failed', detail: String(err.message || err) });
  });

  upstream.end();
}

/* ---------------- routing ---------------- */

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    return res.end();
  }

  const here = new URL(req.url, `http://${HOST}:${PORT}`);

  if (here.pathname === '/health') {
    return jsonError(res, 200, { ok: true, service: 'roleplay-card-converter-proxy', port: PORT });
  }

  if (here.pathname === '/proxy') {
    if (rateLimited(req)) {
      res.setHeader('Retry-After', '60');
      return jsonError(res, 429, { error: 'Too many requests. Wait a minute and try again.' });
    }
    const target = here.searchParams.get('url');
    if (!target) return jsonError(res, 400, { error: 'Missing ?url=' });
    return passThrough(target, req, res);
  }

  if (req.method !== 'GET') return jsonError(res, 405, { error: 'Method not allowed' });
  return serveStatic(here.pathname, res);
});

const toolUrl = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`;

// Every platform has its own way to hand a URL to the default browser, and
// none of them is the others'. Detached so closing this process later does not
// take the browser with it.
function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {
    console.log(`  Could not open a browser automatically. Open ${url} yourself.`);
  }
}

server.listen(PORT, HOST, () => {
  if (IS_HOSTED) {
    console.log(`Roleplay Card Converter proxy listening on ${HOST}:${PORT}`);
    return;
  }
  console.log('');
  console.log('  Roleplay Card Converter');
  console.log('  -----------------------');
  console.log(`  Open:  ${toolUrl}`);
  console.log('');
  console.log('  Serving the tool and proxying Character Tavern library search.');
  console.log('  Leave this running. Press Ctrl+C to stop.');
  console.log('');
  if (OPEN_BROWSER) openBrowser(toolUrl);
});

server.on('error', async err => {
  if (err.code !== 'EADDRINUSE') {
    console.error('  Failed to start:', err);
    process.exit(1);
  }

  // Several things may try to start this - the VS Code task, the desktop
  // shortcut, a Windows login entry. Whichever gets there first wins and the
  // rest should bow out quietly rather than spraying errors, so check whether
  // the port is already us before treating this as a failure.
  let mine = false;
  try {
    const res = await fetch(`${toolUrl}health`, { signal: AbortSignal.timeout(2000) });
    const body = await res.json();
    mine = body && body.service === 'roleplay-card-converter-proxy';
  } catch { /* not us, or nothing answering */ }

  if (mine) {
    console.log(`\n  Already running at ${toolUrl}\n`);
    if (OPEN_BROWSER) openBrowser(toolUrl);
    process.exit(0);
  }

  console.error(`\n  Port ${PORT} is in use by something else.`);
  console.error('  Pick another port:');
  console.error('    Windows:      set PORT=8788 && npm start');
  console.error('    macOS/Linux:  PORT=8788 npm start\n');
  process.exit(1);
});
