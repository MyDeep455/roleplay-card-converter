/* =========================================================================
 * TRANSPORT - fetching, with one exception for one endpoint
 * =========================================================================
 * Almost everything this tool touches is readable straight from the browser:
 * chub.ai's API and Character Tavern's card CDN both send
 * Access-Control-Allow-Origin: *, so single cards, avatars and galleries need
 * nothing special.
 *
 * The one exception is Character Tavern's search API, used to mirror a card
 * library. It sends no CORS header at all and answers a preflight with 405,
 * so a page served from Live Server cannot read it no matter how the request
 * is written. Those calls go through the local proxy instead.
 *
 * That is the whole rule: one host, proxied; everything else direct.
 * ========================================================================= */

import { HOSTED_PROXY } from './config.js';

// Where the proxy lives. Three ways the tool gets opened, and the right answer
// differs for each:
//
//   served by proxy.js itself  -> the proxy is this very origin, whatever port
//                                 it happens to be on
//   opened from localhost      -> Live Server or similar, so a separate origin.
//                                 Try the default local port, then fall back to
//                                 the deployed proxy if nothing is running.
//   opened from a real domain  -> someone's hosted copy. There is no local
//                                 server to find, so use the deployed one from
//                                 config.js, or none at all if it is unset.
//
// The localhost fallback exists because otherwise opening the folder to work on
// it reports "proxy off" while a perfectly good deployed one sits unused. It
// costs one refused request in the console when no local server is running,
// which is cosmetic; being unusable locally is not.
//
// The reverse - a hosted page hunting for a local proxy - is deliberately not
// done. Browsers gate requests from a public page into your own network behind
// a permission prompt, so it would trade a scary dialog for a case that barely
// happens: someone running the server locally would open it locally.
const LOCAL_PROXY = 'http://127.0.0.1:8787';
let proxyBase = LOCAL_PROXY;

// 'local'  a server on this machine, expected to answer instantly
// 'hosted' a deployed server, may be asleep and need a minute to wake
// 'none'   no proxy exists; library mirroring is simply unavailable
let proxyKind = 'local';

// Character Tavern's own domain hosts the search API. Its card CDN
// (ct-cards.storage.character-tavern.com) is a different host and is CORS-open,
// so it deliberately does not appear here and keeps going direct.
const PROXIED_HOSTS = new Set([
  'character-tavern.com',
  'www.character-tavern.com',
]);

let proxyOnline = null;   // null = not yet known (unchecked, or still waking)
let proxyEnabled = true;

export function needsProxy(url) {
  try {
    return PROXIED_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function setProxyEnabled(on) {
  proxyEnabled = !!on;
}

export function getProxyKind() {
  return proxyKind;
}

export function proxyUrl(url) {
  return `${proxyBase}/proxy?url=${encodeURIComponent(url)}`;
}

function isLocalHostname(h) {
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '';
}

// proxy.js marks the page it serves, so the same-origin case is a fact rather
// than a guess - one candidate, one request, no probing at all.
//
// Returned in priority order; the first that answers wins.
function resolveProxies() {
  if (window.__rccServedByProxy) return [{ base: location.origin, kind: 'local' }];

  const hosted = (HOSTED_PROXY || '').trim().replace(/\/+$/, '');

  if (isLocalHostname(location.hostname)) {
    const local = { base: LOCAL_PROXY, kind: 'local' };
    return hosted ? [local, { base: hosted, kind: 'hosted' }] : [local];
  }

  return hosted ? [{ base: hosted, kind: 'hosted' }] : [{ base: LOCAL_PROXY, kind: 'none' }];
}

// A request an extension cancels and a server that never answers both surface
// as the same bare "failed to fetch", so the two are told apart by how long the
// failure took. An extension kills the request before it leaves the browser, in
// single-digit milliseconds; anything that genuinely goes out - a refused
// connection, a sleeping host, a DNS miss - costs a network round trip or more.
// The gap is large enough that a generous threshold still separates them.
const BLOCKED_MS = 400;
let proxyBlocked = false;

async function isOurProxy(base, timeoutMs, watchBlocked = false) {
  const started = Date.now();
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = await res.json();
    return body && body.service === 'roleplay-card-converter-proxy';
  } catch (err) {
    // A timeout is the opposite signal - it waited the whole budget - so it is
    // never a block, however long or short that budget was.
    if (watchBlocked && err.name !== 'TimeoutError' && Date.now() - started < BLOCKED_MS) {
      proxyBlocked = true;
    }
    return false;
  }
}

export function isProxyBlocked() {
  return proxyBlocked;
}

/**
 * Returns 'online' | 'offline' | 'waking' | 'none' quickly, without ever
 * blocking the UI for the length of a cold start.
 *
 * Free hosting tiers put a service to sleep when it is idle and take up to a
 * minute to bring it back, which is far too long to hold a status pill on.
 * So the check is two-stage: a short probe that a running server always wins,
 * and - only for a hosted proxy - a long one left running in the background
 * that reports back through onSettled once the thing is actually up.
 */
export async function checkProxy(onSettled) {
  const candidates = resolveProxies();
  proxyBlocked = false;

  // Settle on the last candidate up front so a total miss still reports against
  // something sensible, then let any candidate that actually answers win.
  const last = candidates[candidates.length - 1];
  proxyBase = last.base;
  proxyKind = last.kind;

  if (last.kind === 'none' && candidates.length === 1) {
    proxyOnline = false;
    return 'none';
  }

  for (const c of candidates) {
    // Only a hosted proxy is worth watching for this. A local one refuses
    // instantly whenever the server simply is not running, which is the normal
    // case rather than a sign of anything.
    if (await isOurProxy(c.base, c.kind === 'hosted' ? 6000 : 2500, c.kind === 'hosted')) {
      proxyBase = c.base;
      proxyKind = c.kind;
      proxyOnline = true;
      return 'online';
    }
  }

  const { base, kind } = last;

  if (kind === 'local') {
    proxyOnline = false;
    return 'offline';
  }

  // Nothing will change by waiting when the request never left the browser, so
  // say so now rather than showing a minute of "waking" that cannot succeed.
  if (proxyBlocked) {
    proxyOnline = false;
    return 'blocked';
  }

  // Hosted and not answering yet. Treat it as waking rather than dead: a
  // request sent now would wake it anyway, so refusing to try would be wrong.
  proxyOnline = null;
  isOurProxy(base, 75000).then(ok => {
    // A real request may have gone through while this was still waiting, which
    // is better evidence than the probe. Never talk that back down to offline.
    if (proxyOnline === true) return;
    proxyOnline = ok;
    onSettled?.(ok ? 'online' : 'offline');
  });
  return 'waking';
}

// Named extensions rather than "an ad blocker", because someone running uBlock
// Origin does not necessarily think of it as one, and the fix is per-extension.
export const BLOCKED_MESSAGE =
  'A browser extension blocked the connection to the proxy, so mirroring a Character Tavern library ' +
  'cannot work until it is allowed. This is almost always an ad blocker - uBlock Origin, Adblock ' +
  'Plus, Ghostery, Privacy Badger or similar - because blocking lists cover the shared domains free ' +
  'hosting platforms use. Click your blocker\'s toolbar icon and allow this site, then click the ' +
  'proxy pill to retry. (Opening the page in a private window, where extensions are usually off, ' +
  'confirms it in seconds.)';

const NO_PROXY_TAIL =
  ' (Only Character Tavern library mirroring needs a proxy - single cards, ' +
  'images and all of chub.ai work without one.)';

function unavailableMessage() {
  if (!proxyEnabled) {
    return 'The proxy is switched off in Settings, and mirroring a Character Tavern library needs it.' +
      NO_PROXY_TAIL;
  }
  if (proxyKind === 'none') {
    return 'Mirroring a Character Tavern library needs a proxy, and this copy of the tool has none ' +
      'configured. Download the tool and run it locally to use this feature.' + NO_PROXY_TAIL;
  }
  if (proxyBlocked) {
    return BLOCKED_MESSAGE + NO_PROXY_TAIL;
  }

  if (proxyKind === 'hosted') {
    return 'The cloud proxy did not answer, so mirroring a Character Tavern library is unavailable ' +
      'right now. It may still be waking up - click the proxy pill in the header to retry. If that ' +
      'keeps failing, an ad blocker may be the cause; see the console for ERR_BLOCKED_BY_CLIENT.' +
      NO_PROXY_TAIL;
  }
  return 'This needs the local server, which is not running. Start it with "npm start" in the tool ' +
    'folder, then click the proxy pill in the header to re-check.' + NO_PROXY_TAIL;
}

export async function httpGet(url, { token = null, accept = null } = {}) {
  const viaProxy = needsProxy(url);

  if (viaProxy && (!proxyEnabled || proxyOnline === false || proxyKind === 'none')) {
    throw new Error(unavailableMessage());
  }

  const headers = {};
  if (accept) headers['Accept'] = accept;
  if (token) headers[viaProxy ? 'X-Proxy-Auth' : 'Authorization'] = token;

  // A sleeping hosted proxy has to boot before it can even start the upstream
  // request, and that alone can eat most of a normal timeout.
  const timeout = viaProxy && proxyKind === 'hosted' ? 100000 : 45000;

  let res;
  try {
    res = await fetch(viaProxy ? proxyUrl(url) : url, {
      headers,
      signal: AbortSignal.timeout(timeout),
    });
    if (viaProxy) proxyOnline = true;   // it answered, so it is definitely up
  } catch (err) {
    const host = hostOf(url);
    if (err.name === 'TimeoutError') throw new Error(`${host} took too long to respond. Try again.`);
    throw new Error(
      `Could not reach ${host}. Check your connection, or the site may be down. (${err.message})`
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(describeStatus(res.status, hostOf(url)), res.status, body.slice(0, 300), url);
  }
  return res;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function describeStatus(status, host) {
  if (status === 404) return `${host} returned 404 - that card or page does not exist. Check the URL.`;
  if (status === 401 || status === 403) {
    return `${host} returned ${status} - access denied. If this is a private card, add your Chub token in Settings.`;
  }
  if (status === 429) return `${host} returned 429 (too many requests). Wait a minute, then try again.`;
  if (status >= 500) return `${host} returned ${status} - the site is having trouble. Try again later.`;
  return `${host} returned HTTP ${status}.`;
}

export class HttpError extends Error {
  constructor(message, status, detail, url) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
    this.url = url;
  }
}

export async function getJson(url, opts = {}) {
  const res = await httpGet(url, { accept: 'application/json', ...opts });
  return res.json();
}

export async function getBlob(url, opts = {}) {
  return (await httpGet(url, opts)).blob();
}
