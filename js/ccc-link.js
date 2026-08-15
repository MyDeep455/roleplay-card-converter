/* =========================================================================
 * CCC LINK - handing converted cards straight to Casual Character Chat
 * =========================================================================
 * The old route out of this tool was a file: download a backup, find it in
 * your downloads folder, open the app, press "Import Data", pick it. Five
 * steps across two programs to move data between two browser tabs.
 *
 * This is the short way. The app and this tool talk over `postMessage`, so a
 * converted card goes from here into the app's own IndexedDB without ever
 * becoming a file. Downloads are still offered beside it - the same backup,
 * for anyone who wants one to keep - but nothing needs one any more.
 *
 * WHY postMessage AND NOT THE URL
 * A card carries its avatar and often a whole gallery as WebP data URLs, so a
 * fully loaded one runs to several megabytes. That will not fit in a URL -
 * browsers cut those off somewhere near 2 MB, and proxies far sooner.
 * postMessage hands over a structured clone instead, which has no such ceiling
 * and never touches the address bar, a server log or the session history.
 *
 * WHO OPENS WHOM
 * Both directions work, and they are not symmetrical:
 *
 *   app -> tool   The normal way. The app opens this tool with its own origin
 *                 in the link's hash, so we know exactly who to answer and
 *                 the user lands back in the tab they started from. Works for
 *                 any copy of the app anywhere - a self-hosted one, a local
 *                 one - because nothing about its address is assumed here.
 *
 *   tool -> app   The fallback, for when the tool was opened on its own from
 *                 a bookmark and there is no launcher to answer to. Then we
 *                 open CCC_APP_URL from config.js ourselves.
 *
 * TRUST
 * Cards only ever travel one way, and nothing is ever read back out of the
 * app - the reply is a count. The card data itself is what the platforms
 * publish to anyone, so the risk here is not disclosure but injection: some
 * other page pushing characters into someone's collection. That is settled on
 * the receiving side, which names the sender and asks, rather than by an
 * allowlist of origins here that would only break self-hosted copies.
 * ========================================================================= */

import { CCC_APP_URL } from './config.js';

/* ---------------- the protocol ---------------- */

// Both halves check this tag before looking at a message at all. Every page
// shares the `message` event with every embed on it, and a YouTube player or
// an ad frame chattering to its own script must not be mistaken for an answer.
export const PROTOCOL = 'ccc-card-import';
export const PROTOCOL_VERSION = 1;

// The app puts its origin here when it opens the tool, so the tool knows both
// that it was launched (rather than opened cold) and who to post back to.
export const LAUNCH_PARAM = 'ccc-import-from';

// Named so a second Import press reuses the tab the first one opened instead
// of stacking up windows.
const WINDOW_NAME = 'ccc-import-target';

const HELLO_EVERY_MS = 300;

// The app ships an 18 MB starter pack and opens a database before it can
// answer, and this may be the first time the browser has ever fetched it.
// A slow connection is not a failure, so the wait is generous; the ping loop
// means a fast one still connects the moment the app is up.
const READY_TIMEOUT_MS = 90_000;

// Once connected, the only thing between a card and its answer is a database
// write plus however long the user takes over the app's confirm dialog.
const IMPORT_TIMEOUT_MS = 300_000;

/* ---------------- who launched us ---------------- */

// Read once, at load. The hash is cleaned off the address bar immediately and
// the origin is kept in sessionStorage instead - there is no reason to leave
// the app's address sitting in a URL the user might copy and paste somewhere,
// and a URL is the wrong place to hold it anyway: refreshing the page, or
// following a link and coming back, would wipe it and quietly cost the user
// their connection to the app for the rest of the session.
//
// sessionStorage is exactly the right lifetime for this. It is per tab, so a
// second copy of the tool opened cold does not inherit the link; it survives
// reloads, which a URL hash we deliberately erased cannot; and it is gone when
// the tab is, which is when the opener is gone too.
const STORAGE_KEY = 'ccc-import-launcher';

const launcher = readLaunchOrigin();

function readLaunchOrigin() {
  // An opener is not optional. Whatever a stored or pasted origin says, the
  // cards go to a *window*, and without one there is nothing to answer.
  if (!window.opener || window.opener.closed) return '';

  let origin = '';
  try {
    const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    const value = new URLSearchParams(hash).get(LAUNCH_PARAM);
    if (value) origin = decodeURIComponent(value);
  } catch {
    origin = '';
  }

  if (origin) {
    try { sessionStorage.setItem(STORAGE_KEY, origin); } catch { /* private mode; fall through */ }
    history.replaceState(null, '', location.pathname + location.search);
    return origin;
  }

  // No hash: either a reload of a launched tab, or a tab opened by something
  // that is not the app. The stored origin tells the two apart.
  try {
    return sessionStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

// postMessage has no way to name a file:// page as a target: such a page's
// origin is the opaque string "null", which it will not accept. A standalone
// copy of the app run straight off the disk is a real case, so those get '*'.
// Nothing is lost by it - see TRUST above, this direction only ever sends the
// card, which came off a public website in the first place.
function targetOriginFor(origin) {
  return !origin || origin === 'null' ? '*' : origin;
}

/* ---------------- the connection ---------------- */

// One live connection, reused. Reconnecting per card would reopen the app -
// and reload 18 MB - once per press.
let session = null;

/**
 * Get a window to import into, opening one if there is none.
 *
 * MUST be called straight from a click handler, before anything is awaited:
 * it may need `window.open`, and a browser only allows that while it can still
 * see the click that led to it. Awaiting a card out of IndexedDB first is
 * enough to have the popup blocked instead.
 *
 * Returns synchronously. The waiting is in `.ready`, so the caller can load
 * its card while the app boots in the other tab.
 *
 * @returns {{win: Window, origin: string, ready: Promise<void>, opened: boolean}}
 */
export function connect() {
  if (session && !session.win.closed) return session;

  // The launcher is preferred while it is still there. Someone who came from
  // the app and then closed that tab falls through to opening a fresh one.
  if (launcher && window.opener && !window.opener.closed) {
    session = makeSession(window.opener, launcher, false);
    return session;
  }

  const url = new URL(CCC_APP_URL);
  const win = window.open(url.href, WINDOW_NAME);
  if (!win) throw new Error(
    'Your browser blocked the Casual Character Chat tab. Allow pop-ups for this site, or use Download instead.'
  );

  session = makeSession(win, url.origin, true);
  return session;
}

function makeSession(win, origin, opened) {
  const s = { win, origin, opened, ready: null };
  s.ready = handshake(s);
  return s;
}

// Ping until it answers rather than waiting for it to announce itself. An app
// tab that was already open and idle has nothing to announce - it loaded long
// ago - so listening alone would hang on exactly the case that should be
// fastest. The app answers `hello` whenever it is asked, however old it is.
function handshake(s) {
  return new Promise((resolve, reject) => {
    const target = targetOriginFor(s.origin);
    let timer = null;
    let deadline = null;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      clearInterval(timer);
      clearTimeout(deadline);
    };

    const onMessage = event => {
      const d = event.data;
      if (!d || d.protocol !== PROTOCOL || d.type !== 'ready') return;
      if (event.source !== s.win) return;

      // The app's real origin, which for a window we opened ourselves is the
      // one it redirected to - CCC_APP_URL may well be a bare domain that
      // resolves to www, or an app that moved. Answering the origin that
      // spoke, rather than the one we guessed, survives all of that.
      if (event.origin && event.origin !== 'null') s.origin = event.origin;
      cleanup();
      resolve();
    };

    window.addEventListener('message', onMessage);

    const ping = () => {
      if (s.win.closed) {
        cleanup();
        reject(new Error('The Casual Character Chat tab was closed before the import could start.'));
        return;
      }
      s.win.postMessage({ protocol: PROTOCOL, v: PROTOCOL_VERSION, type: 'hello' }, target);
    };

    ping();
    timer = setInterval(ping, HELLO_EVERY_MS);

    deadline = setTimeout(() => {
      cleanup();
      reject(new Error(
        'Casual Character Chat did not answer. Make sure it finished loading in the other tab, then try again - or use Download.'
      ));
    }, READY_TIMEOUT_MS);
  });
}

/* ---------------- sending ---------------- */

let nextRequestId = 1;

/**
 * Hand a backup envelope to the connected app and wait for it to say what it
 * did with it.
 *
 * @param {{win: Window, origin: string, ready: Promise<void>}} s from connect()
 * @param {Object} backup a v3 backup object, as toCccBackup builds
 * @returns {Promise<{added: number, skipped: number, cancelled: boolean}>}
 */
export async function sendBackup(s, backup) {
  await s.ready;
  if (s.win.closed) throw new Error('The Casual Character Chat tab was closed before the import finished.');

  const id = nextRequestId++;
  const target = targetOriginFor(s.origin);

  return new Promise((resolve, reject) => {
    let deadline = null;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(deadline);
    };

    const onMessage = event => {
      const d = event.data;
      if (!d || d.protocol !== PROTOCOL || d.type !== 'result' || d.id !== id) return;
      if (event.source !== s.win) return;

      cleanup();
      if (d.ok) {
        resolve({
          added: d.added || 0,
          skipped: d.skipped || 0,
          cancelled: Boolean(d.cancelled),
        });
      } else {
        reject(new Error(d.error || 'Casual Character Chat could not save the import.'));
      }
    };

    window.addEventListener('message', onMessage);

    deadline = setTimeout(() => {
      cleanup();
      reject(new Error('Casual Character Chat did not confirm the import. Check the other tab.'));
    }, IMPORT_TIMEOUT_MS);

    try {
      s.win.postMessage({ protocol: PROTOCOL, v: PROTOCOL_VERSION, type: 'import', id, backup }, target);
    } catch (err) {
      cleanup();
      // Structured clone only refuses things a converted card never holds
      // (functions, DOM nodes), so this is a bug rather than a user problem -
      // but it should still say so out loud instead of hanging until timeout.
      reject(new Error('That card could not be sent to Casual Character Chat: ' + (err?.message || err)));
    }
  });
}

/** Bring the app's tab forward. Used once an import run is finished with. */
export function focusApp() {
  try {
    if (session && !session.win.closed) session.win.focus();
  } catch {
    // Cross-origin focus is refused by some browsers outside a user gesture.
    // Nothing to do about it and nothing worth saying - the import landed.
  }
}
