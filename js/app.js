/* =========================================================================
 * APP - wiring, UI state and the conversion pipelines
 * ========================================================================= */

import { ADAPTERS, adapterForUrl } from './adapters.js';
import { toCccCharacter, toCccBackup } from './convert.js';
import { blobToWebpDataUrl } from './media.js';
import {
  checkProxy, getProxyKind, needsProxy, isProxyBlocked, BLOCKED_MESSAGE,
} from './transport.js';
import {
  saveCard, getCard, deleteCard, clearCards, countCards,
  listCardsLight, getSetting, setSetting,
} from './db.js';
import { maybeStartTour } from './tour.js';

const $ = id => document.getElementById(id);

const state = {
  tokens: {},          // adapterId -> token
  bulk: {
    adapter: null,
    url: '',
    page: 1,
    totalPages: 1,
    items: [],
    selected: new Set(),   // keys selected on the current page
    urlList: null,         // set when the user pasted individual card URLs
  },
  cancelBulk: false,
};

/* ---------------- small helpers ---------------- */

function setStatus(el, message, kind = '') {
  el.textContent = message;
  el.className = `status ${kind}`;
}

// A card the site refuses looks identical to one that does not exist, and the
// most common cause - the site serving this connection a filtered library - is
// the one nobody can guess from the message. Only added when the site actually
// answered and said no; a mistyped URL gets no such excuse.
const REGION_HINT =
  ' If you can open it on the site itself, your connection is being shown a filtered library here - ' +
  'see "Missing characters?" below.';

function describeError(err) {
  const msg = err?.message || String(err);
  return err?.name === 'HttpError' ? msg + REGION_HINT : msg;
}

function fileSafe(name) {
  return (name || 'character').replace(/[^a-z0-9_\- ]/gi, '').replace(/\s+/g, '_').slice(0, 60) || 'character';
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function confirmDialog(title, text, confirmLabel = 'Delete') {
  return new Promise(resolve => {
    const modal = $('confirm-modal');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-yes').textContent = confirmLabel;
    modal.classList.remove('hidden');

    const done = answer => {
      modal.classList.add('hidden');
      $('confirm-yes').removeEventListener('click', yes);
      $('confirm-no').removeEventListener('click', no);
      resolve(answer);
    };
    const yes = () => done(true);
    const no = () => done(false);
    $('confirm-yes').addEventListener('click', yes);
    $('confirm-no').addEventListener('click', no);
  });
}

// A converted card counts as partial when it has no greeting or almost no
// description - usually a stub card whose author never filled it in. Flagged
// in the results list so a half-empty card is not mistaken for a good one.
function isPartial(character) {
  const hasGreeting = character.scenarios.length > 0;
  const body = character.description.replace(/---[^-]*---/g, '').trim();
  return !hasGreeting || body.length < 40;
}

/* ---------------- the JanitorAI token helper ---------------- */

/**
 * A bookmarklet that copies your JanitorAI token, run from janitorai.com.
 *
 * This page cannot fetch the token itself, and not for want of trying: cookies
 * are origin-scoped, so `document.cookie` here cannot see janitorai.com's;
 * `credentials: 'include'` is refused because JanitorAI answers every request
 * with `Access-Control-Allow-Origin: *`, which browsers reject outright for a
 * credentialed request; and a janitorai.com iframe hands back a null
 * contentDocument. All three were tried and all three are walls, by design.
 *
 * What is possible is code running *on* janitorai.com, which is what a
 * bookmarklet is. It matters most on phones, where there is no DevTools panel
 * to read a cookie out of and this is the only route that exists at all.
 *
 * Only the access token is copied, never the whole cookie. The cookie also
 * carries a refresh token, which could mint fresh sessions long after this one
 * expires; the access token simply dies in a few hours.
 *
 * Written as a function and serialised, rather than kept as one long string,
 * so it stays readable and gets syntax-checked like the rest of the file. It
 * therefore has no `//` comments and no multi-line strings - the newlines are
 * flattened below so the result survives being pasted into a bookmark field.
 */
function jaiTokenGrabber() {
  var chunks = {}, cookies = document.cookie ? document.cookie.split('; ') : [], i;
  for (i = 0; i < cookies.length; i++) {
    var eq = cookies[i].indexOf('=');
    if (eq < 0) continue;
    var hit = cookies[i].slice(0, eq).match(/^sb-.*auth-token(?:\.(\d+))?$/);
    if (hit) chunks[hit[1] === undefined ? 0 : Number(hit[1])] = decodeURIComponent(cookies[i].slice(eq + 1));
  }
  var order = Object.keys(chunks).sort(function (a, b) { return a - b; }), raw = '';
  for (i = 0; i < order.length; i++) raw += chunks[order[i]];
  if (!raw) {
    alert('No JanitorAI login found on this page.\n\nOpen janitorai.com, log in, and tap this bookmark again while you are on that site.');
    return;
  }
  var body = raw.replace(/^base64-/, '').replace(/-/g, '+').replace(/_/g, '/'), decoded = '';
  try { decoded = atob(body.slice(0, body.length - (body.length % 4))); } catch (e) { decoded = ''; }
  var jwt = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
  var token = (decoded.match(jwt) || raw.match(jwt) || [])[0];
  if (!token) {
    alert('Found a JanitorAI cookie, but no token inside it.\n\nLog out of JanitorAI and back in, then tap this again.');
    return;
  }
  var ask = function () { window.prompt('Copy this, then paste it into the Card Converter’s Settings:', token); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(token).then(
      function () { alert('JanitorAI token copied.\n\nGo back to the Card Converter, open Settings, and paste it into the JanitorAI box.'); },
      ask
    );
  } else {
    ask();
  }
}

// Newlines are flattened because several browsers' bookmark editors keep only
// the first line of a pasted URL, which would silently save a broken snippet.
const JAI_BOOKMARKLET =
  'javascript:(' + jaiTokenGrabber.toString().replace(/\s*\n\s*/g, ' ') + ')();';

/* ---------------- the JanitorAI "empty card" notice ---------------- */

// Signed out, JanitorAI returns null for every definition field, so its cards
// convert into a name, an avatar and a blurb - no greeting, no personality.
// Nothing errors, which is exactly the problem: without this the cards simply
// look disappointing and there is no way to tell that one setting fixes it.
//
// Only raised when there is no token to begin with. With one, a card that is
// still empty is one whose author hid the definition, and no amount of
// pointing at Settings would change that.
function noteEmptyJanitorCards(count) {
  if (!count || state.tokens.janitorai) return;
  const notice = $('jai-token-notice');
  if (notice) notice.classList.remove('hidden');
}

$('jai-token-notice-close').addEventListener('click', () => {
  $('jai-token-notice').classList.add('hidden');
});

// Set from script rather than written into the HTML: the snippet is long and
// full of quotes and angle brackets, and hand-escaping it into an attribute is
// the kind of thing that breaks silently on the next edit.
//
// Dragging it to a bookmarks bar is the desktop route; clicking it here does
// nothing useful, but it fails politely - it finds no JanitorAI cookie on this
// origin and says exactly that.
$('jai-bookmarklet').href = JAI_BOOKMARKLET;

$('jai-copy-bookmarklet').addEventListener('click', async () => {
  const btn = $('jai-copy-bookmarklet');
  const said = ok => { btn.textContent = ok ? 'Copied' : 'Press Ctrl+C'; setTimeout(() => { btn.textContent = 'Copy the code'; }, 2500); };
  try {
    await navigator.clipboard.writeText(JAI_BOOKMARKLET);
    said(true);
  } catch {
    // Clipboard access needs a secure context, which a copy opened straight
    // off the filesystem is not. Selecting it still lets Ctrl+C do the job.
    const ta = document.createElement('textarea');
    ta.value = JAI_BOOKMARKLET;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    said(document.execCommand?.('copy') === true);
    ta.remove();
  }
});

// A card converted from JanitorAI that arrived without its definition.
function isEmptyJanitorCard(card, character) {
  return card.sourcePlatform === 'JanitorAI' && !character.scenarios.length;
}

async function storeCharacter(character, meta) {
  const thumbnail = character.avatar
    ? await shrinkThumb(character.avatar)
    : '';
  return saveCard({
    id: character.id,
    name: character.name,
    platform: meta.platform || 'Unknown',
    sourceUrl: meta.sourceUrl || '',
    thumbnail,
    partial: isPartial(character),
    character,
  });
}

// The results list only ever shows a 60px-tall row, so keeping a full avatar
// per row would make the list load cost scale with the collection.
async function shrinkThumb(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    return await blobToWebpDataUrl(blob, 120, 0.7);
  } catch {
    return '';
  }
}

/* ---------------- proxy status ---------------- */

// The pill is only ever about one feature - mirroring a Character Tavern
// library - so every wording here says which, rather than leaving someone to
// wonder what is broken. Nothing else in the tool cares whether it is green.
const PROXY_STATES = {
  online: {
    cls: 'pill-on',
    local: ['Proxy running', 'Local server detected. Character Tavern library mirroring is available.'],
    hosted: ['Proxy ready', 'Cloud proxy is awake. Character Tavern library mirroring is available.'],
  },
  waking: {
    cls: 'pill-wake',
    hosted: ['Waking proxy...', 'The cloud proxy sleeps when idle and takes up to a minute to wake. ' +
      'You can start a mirror now - it will simply take a moment. Everything else is unaffected.'],
  },
  offline: {
    cls: 'pill-off',
    local: ['Proxy off', 'No local server. Everything works except mirroring a Character Tavern library.'],
    hosted: ['Proxy unreachable', 'The proxy did not answer. It may be waking up - click the pill to ' +
      'retry. An AD BLOCKER is the other likely cause; disable it for this site.'],
  },
  // Its own state rather than a flavour of offline: the cause is on this
  // machine, retrying cannot fix it, and the fix is one the person can act on.
  blocked: {
    cls: 'pill-blocked',
    hosted: ['Proxy blocked', BLOCKED_MESSAGE],
  },
  none: {
    cls: 'pill-off',
    none: ['No proxy', 'This copy has no proxy configured, so mirroring a Character Tavern library is ' +
      'unavailable. Everything else - all of chub.ai, single cards, images - works normally.'],
  },
};

function paintProxyStatus(status) {
  const spec = PROXY_STATES[status] || PROXY_STATES.offline;
  const kind = getProxyKind();
  const [label, detailText] = spec[kind] || spec.local || spec.hosted || spec.none;

  const pill = $('proxy-status');
  pill.className = `pill ${spec.cls}`;
  $('proxy-status-text').textContent = label;

  // The longer explanation used to sit in a Settings panel. It hangs off the
  // pill instead: the pill is the only place the proxy is ever mentioned now,
  // so the detail belongs on the thing it describes rather than behind a
  // heading someone has to go looking for.
  pill.title = detailText;
}

async function refreshProxyStatus() {
  $('proxy-status').className = 'pill pill-unknown';
  $('proxy-status-text').textContent = 'Checking proxy...';

  // A hosted proxy may still be booting when this returns 'waking'; the second
  // argument is called later with the real answer, so the pill settles itself
  // instead of the page hanging on a cold start.
  const status = await checkProxy(paintProxyStatus);
  paintProxyStatus(status);
  return status;
}

$('proxy-status').addEventListener('click', refreshProxyStatus);

/* ---------------- settings ---------------- */

// An adapter with no tokenHint has no token to give, so it gets no field.
// Character Tavern is the case: it wants nothing, and a box labelled "not
// needed" is one more thing to read and wonder about.
function buildTokenFields() {
  const wrap = $('token-fields');
  wrap.innerHTML = '';
  ADAPTERS.filter(a => a.tokenHint).forEach(a => {
    const div = document.createElement('div');
    div.className = 'token-field';
    div.innerHTML = `
      <label for="token-${a.id}">${a.label} <span class="chip">${a.tokenLabel || 'optional'}</span></label>
      <p class="hint">${a.tokenHint}</p>
      <input type="password" id="token-${a.id}" placeholder="Paste token" autocomplete="off" spellcheck="false" />`;
    wrap.appendChild(div);
    div.querySelector('input').value = state.tokens[a.id] || '';
  });
}

$('settings-btn').addEventListener('click', () => {
  buildTokenFields();
  $('settings-modal').classList.remove('hidden');
});

$('settings-close').addEventListener('click', () => $('settings-modal').classList.add('hidden'));

$('settings-save').addEventListener('click', async () => {
  ADAPTERS.forEach(a => {
    const input = $(`token-${a.id}`);
    if (input) state.tokens[a.id] = input.value.trim();
  });
  await setSetting('tokens', state.tokens);
  $('settings-modal').classList.add('hidden');

  // The notice exists to ask for exactly this. Leaving it up after it has been
  // acted on would read as "that did not work".
  if (state.tokens.janitorai) $('jai-token-notice').classList.add('hidden');
});

/* =========================================================================
 * ONE INPUT
 * -------------------------------------------------------------------------
 * A card link and a search link were separate tabs, which made the person
 * classify their own URL before pasting it - and get it wrong, because the
 * difference is not obvious from looking at one. The adapters already know
 * which is which, so the box takes anything and routes it here instead.
 * ========================================================================= */

// Enter deliberately does nothing but start a new line. The box accepts a list,
// so a key that submits it would cut one short mid-paste - and pressing Convert
// is no harder than reaching for Enter.
$('convert-btn').addEventListener('click', handleInput);

async function handleInput() {
  const status = $('bulk-status');
  const lines = $('url-input').value.split('\n').map(l => l.trim()).filter(Boolean);

  if (!lines.length) return setStatus(status, 'Paste a link first.', 'error');

  // From here on this is the person's own request, so a slow suggestion load
  // that finishes later must not overwrite it.
  discoverSuperseded = true;
  if (lines.length > 1) return loadUrlList(lines, status);

  const raw = lines[0];
  let adapter, url;
  try {
    ({ adapter, url } = adapterForUrl(raw));
  } catch (err) {
    return setStatus(status, err.message || String(err), 'error');
  }

  if (adapter.isLibraryUrl(url)) return startMirror(pageFromUrl(raw));
  return convertSingle(raw, adapter);
}

async function convertSingle(raw, adapter) {
  const status = $('bulk-status');
  const btn = $('convert-btn');
  btn.disabled = true;
  try {
    setStatus(status, `Fetching from ${adapter.label}...`, 'busy');

    // A single card replaces whatever a previous search left on screen, so the
    // grid is not still offering picks that have nothing to do with the result.
    clearBulkGrid();

    const card = await adapter.fetchCard(raw, {
      token: state.tokens[adapter.id] || null,
      progress: msg => setStatus(status, `${adapter.label}: ${msg}...`, 'busy'),
    });

    const character = toCccCharacter(card);
    await storeCharacter(character, { platform: card.sourcePlatform || adapter.label, sourceUrl: raw });
    await renderResults();
    noteEmptyJanitorCards(isEmptyJanitorCard(card, character) ? 1 : 0);

    const extras = [];
    if (character.gallery.length) extras.push(`${character.gallery.length} gallery image(s)`);
    if (character.scenarios.length) extras.push(`${character.scenarios.length} greeting(s)`);
    if (character.loreEntries.length) extras.push(`${character.loreEntries.length} lore entries`);

    setStatus(status,
      `Converted "${character.name}"${extras.length ? ' - ' + extras.join(', ') : ''}. See below.`,
      'ok');
    $('url-input').value = '';

    // Only the name here. The counts of greetings and gallery images are worth
    // reading, but not in something that is gone in under three seconds - they
    // stay in the status line for as long as anyone wants them.
    showToast(`Converted "${character.name}"`);
    scrollToResults();
  } catch (err) {
    setStatus(status, describeError(err), 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- bulk mirror ---------------- */

// Mirroring starts on the page the pasted URL asks for. Copying a URL while on
// page 4 of a library and landing back on page 1 is the same class of surprise
// as a dropped filter.
function pageFromUrl(raw) {
  try {
    const n = Number(new URL(raw.trim()).searchParams.get('page'));
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  } catch {
    return 1;
  }
}

// Paging re-runs the search that is already loaded rather than re-reading the
// box, so editing the text without pressing Convert cannot send you to a page
// of something else.
$('bulk-prev').addEventListener('click', () => startMirror(Math.max(1, state.bulk.page - 1), state.bulk.url));
$('bulk-next').addEventListener('click', () => startMirror(state.bulk.page + 1, state.bulk.url));

async function startMirror(page, sourceUrl = null) {
  const status = $('bulk-status');
  const raw = (sourceUrl || $('url-input').value).trim();
  if (!raw) return setStatus(status, 'Paste a link first.', 'error');

  try {
    const { adapter } = adapterForUrl(raw);

    // Say so up front when the wait is going to be a cold start rather than a
    // slow site, otherwise a minute of nothing reads as a hang.
    const coldStart = needsProxy(raw) && getProxyKind() === 'hosted' && !isProxyBlocked();
    setStatus(
      status,
      coldStart
        ? `Mirroring page ${page} of ${adapter.label}... (waking the cloud proxy, this can take up to a minute the first time)`
        : `Mirroring page ${page} of ${adapter.label}...`,
      'busy'
    );
    $('convert-btn').disabled = true;

    const result = await adapter.listLibrary(raw, page, { token: state.tokens[adapter.id] || null });

    avatarGeneration++;          // a mirrored page carries its own thumbnails
    state.bulk = {
      adapter, url: raw, page,
      totalPages: result.totalPages || 1,
      items: result.items || [],
      selected: new Set(),
      urlList: null,
    };

    if (!state.bulk.items.length) {
      setStatus(status, 'That library page returned no cards.', 'error');
      renderBulkGrid();
      return;
    }
    setStatus(status, `${state.bulk.items.length} cards on page ${page}. Tick the ones you want.`, 'ok');
    renderBulkGrid();
  } catch (err) {
    setStatus(status, describeError(err), 'error');
  } finally {
    $('convert-btn').disabled = false;
  }
}

// Only the URL is known before a card is fetched, so the picker shows what can
// be read from it. Both sites end their card paths with a slug, and chub hangs
// a hex id off the end of its own - which is noise beside a real thumbnail, so
// it goes.
function nameFromCardUrl(line) {
  const slug = decodeURIComponent(line.split('?')[0].split('/').filter(Boolean).pop() || line);
  const words = slug.replace(/-[0-9a-f]{6,}$/i, '').replace(/[-_]+/g, ' ').trim();
  return words ? words.replace(/\b[a-z]/g, c => c.toUpperCase()) : slug;
}

// Both sites use .../<author>/<slug>, so the segment before the slug is who
// made it - the same thing the grid shows for a mirrored search.
function creatorFromCardUrl(line) {
  const parts = line.split('?')[0].split('/').filter(Boolean);
  return parts.length >= 2 ? decodeURIComponent(parts[parts.length - 2]) : '';
}

// Several links at once land in the same grid a search does, so a hand-collected
// batch is reviewed and ticked exactly like a set of search results.
function loadUrlList(lines, status) {
  const items = [];
  const bad = [];
  const searches = [];

  lines.forEach(line => {
    try {
      const { adapter, url } = adapterForUrl(line);

      // A search among a list of cards has no sensible meaning - it would be
      // one entry standing for hundreds - so it is called out rather than
      // quietly converted into a single broken row.
      if (adapter.isLibraryUrl(url)) return searches.push(line);

      items.push({
        key: line,
        name: nameFromCardUrl(line),
        tagline: adapter.label,
        // Both sites put the card image at a path derived from the card's own
        // URL, so the picker can show real thumbnails here without fetching
        // each card first. A URL that turns out wrong falls back to the same
        // "no image" placeholder as before.
        avatarUrl: adapter.avatarFromCardUrl?.(url) || '',
        cardUrl: line,
        creator: creatorFromCardUrl(line),
      });
    } catch {
      bad.push(line);
    }
  });

  if (!items.length) {
    return setStatus(status,
      searches.length
        ? 'Those are search links. Paste one on its own to browse what it finds.'
        : 'None of those are chub.ai or Character Tavern card links.',
      'error');
  }

  state.bulk = {
    adapter: null, url: '', page: 1, totalPages: 1,
    items, selected: new Set(items.map(i => i.key)), urlList: true,
  };
  renderBulkGrid();
  hydrateListAvatars(items);

  const notes = [];
  if (searches.length) notes.push(`${searches.length} search link(s) skipped - paste those one at a time`);
  if (bad.length) notes.push(`${bad.length} unsupported and skipped`);

  setStatus(status,
    `${items.length} card link(s) loaded and selected.${notes.length ? ' ' + notes.join('; ') + '.' : ''}`,
    notes.length ? 'error' : 'ok');
}

// A pasted link usually becomes a thumbnail for free, because chub and
// Character Tavern both derive the card image from the card's own URL. On
// JanitorAI it cannot: the avatar's filename appears nowhere in the URL, so it
// has to be asked for. Adapters that need that expose `hydrateAvatars`, and
// this lets them fill the tiles in after the grid is already up rather than
// holding a blank page while a list of links is looked up one by one.
//
// Whatever it was working on stops mattering the moment the grid is replaced,
// which `generation` is for - a slow reply for a previous paste must not
// redraw tiles that are no longer on screen.
let avatarGeneration = 0;

function hydrateListAvatars(items) {
  const mine = ++avatarGeneration;
  const byAdapter = new Map();

  items.forEach(item => {
    let adapter;
    try { ({ adapter } = adapterForUrl(item.cardUrl)); } catch { return; }
    if (typeof adapter.hydrateAvatars !== 'function') return;
    if (!byAdapter.has(adapter)) byAdapter.set(adapter, []);
    byAdapter.get(adapter).push(item);
  });

  byAdapter.forEach((group, adapter) => {
    adapter.hydrateAvatars(group, {
      token: state.tokens[adapter.id] || null,
      cancelled: () => avatarGeneration !== mine,
      onItem: (item, patch) => {
        if (avatarGeneration !== mine) return;
        Object.assign(item, patch);
        renderBulkGrid();
      },
    }).catch(() => { /* thumbnails are decoration; the links still convert */ });
  });
}

/* =========================================================================
 * OPENING SUGGESTIONS
 * -------------------------------------------------------------------------
 * An empty page with one text box does not say what the tool is for, and gives
 * someone nothing to try without leaving to find a link first. So a page of
 * chub's trending cards loads on its own - chub needs no proxy, so this works
 * even when the proxy is asleep, blocked or absent.
 *
 * Nothing is preselected and nothing is fetched beyond the listing itself:
 * these are suggestions, not work already started on someone's behalf.
 * ========================================================================= */

const DISCOVER_URL = 'https://chub.ai/characters?sort=trending';

// The moment someone pastes their own link, whatever this was loading stops
// mattering - a late reply must not replace what they actually asked for.
let discoverSuperseded = false;

function renderSkeletons(n) {
  const grid = $('bulk-grid');
  grid.innerHTML = '';

  // Nothing has arrived yet, so naming a source - or asking for a choice
  // between tiles that are still placeholders - would be premature.
  $('bulk-source').classList.add('hidden');
  $('bulk-hint').classList.add('hidden');
  $('bulk-toolbar').classList.add('hidden');
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = 'bulk-card skeleton';
    el.innerHTML = '<figure></figure><div class="bulk-card-body"><p></p><p class="short"></p></div>';
    grid.appendChild(el);
  }
}

async function loadDiscover() {
  const status = $('bulk-status');

  // Skeleton tiles rather than a line of text: the shape of what is coming is
  // the part worth showing, so the wait reads as a collection loading rather
  // than as an empty page that might stay empty.
  renderSkeletons(12);
  setStatus(status, 'Loading trending characters from chub.ai...', 'busy');

  try {
    const { adapter } = adapterForUrl(DISCOVER_URL);
    const result = await adapter.listLibrary(DISCOVER_URL, 1, {});
    if (discoverSuperseded) return;

    const items = result.items || [];
    if (!items.length) throw new Error('no cards returned');

    state.bulk = {
      adapter, url: DISCOVER_URL, page: 1,
      totalPages: result.totalPages || 1,
      items, selected: new Set(), urlList: null,
    };
    renderBulkGrid();

    // The source line under the box already names what these are and links to
    // it, so a second sentence saying the same thing is just noise.
    setStatus(status, '', '');
  } catch {
    if (discoverSuperseded) return;

    // Suggestions are a convenience, so a failure here is not the user's
    // problem to solve and must not greet them as an error.
    clearBulkGrid();
    setStatus(status, '', '');
  }
}

function clearBulkGrid() {
  avatarGeneration++;            // abandon any thumbnails still being looked up
  state.bulk = {
    adapter: null, url: '', page: 1, totalPages: 1,
    items: [], selected: new Set(), urlList: null,
  };
  renderBulkGrid();
}

// What is on screen came from somewhere - a search, a suggestion, or a paste -
// and after a few conversions it is easy to lose track of which. This names it,
// and links back so the same page can be reopened on the site itself.
function renderBulkSource() {
  const el = $('bulk-source');
  const hint = $('bulk-hint');
  const { url, urlList, items } = state.bulk;

  if (!items.length || (!url && !urlList)) {
    el.classList.add('hidden');
    el.innerHTML = '';
    hint.classList.add('hidden');
    hint.innerHTML = '';
    return;
  }

  el.classList.remove('hidden');
  el.innerHTML = urlList
    ? `Currently showing <strong>${items.length}</strong> pasted link(s)`
    : `Currently showing card(s) from: <a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;

  // A page of search results is a shelf, not an order - nothing below it is
  // converted until it is picked. Pasted links arrive already ticked, so the
  // step being asked for is the opposite one.
  hint.classList.remove('hidden');
  hint.innerHTML = urlList
    ? 'All selected &rarr; untick any you don\'t want &rarr; click "Convert selected"'
    : 'Select characters &rarr; Convert & Download &rarr; Import to Casual Character Chat';
}

function renderBulkGrid() {
  const grid = $('bulk-grid');
  const toolbar = $('bulk-toolbar');
  grid.innerHTML = '';
  renderBulkSource();

  if (!state.bulk.items.length) {
    toolbar.classList.add('hidden');
    return;
  }
  toolbar.classList.remove('hidden');

  $('bulk-page').textContent = state.bulk.urlList
    ? `${state.bulk.items.length} URLs`
    : `Page ${state.bulk.page} / ${state.bulk.totalPages}`;
  $('bulk-prev').disabled = state.bulk.urlList || state.bulk.page <= 1;
  $('bulk-next').disabled = state.bulk.urlList || state.bulk.page >= state.bulk.totalPages;

  state.bulk.items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'bulk-card' + (state.bulk.selected.has(item.key) ? ' selected' : '');

    const img = item.avatarUrl
      ? `<img src="${item.avatarUrl}" alt="" loading="lazy" referrerpolicy="no-referrer"
              onerror="this.parentNode.innerHTML='<div class=\\'noimg\\'>no image</div>'" />`
      : `<div class="noimg">no image</div>`;

    card.innerHTML = `
      <input type="checkbox" class="bulk-check" ${state.bulk.selected.has(item.key) ? 'checked' : ''} />
      <figure>${img}</figure>
      <div class="bulk-card-body">
        <p class="bulk-card-name" title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</p>
        <p class="bulk-card-tag">${escapeHtml(item.tagline || '')}</p>
        ${item.creator ? `<p class="bulk-card-creator">by ${escapeHtml(item.creator)}</p>` : ''}
      </div>`;

    const toggle = () => {
      if (state.bulk.selected.has(item.key)) state.bulk.selected.delete(item.key);
      else state.bulk.selected.add(item.key);
      card.classList.toggle('selected');
      card.querySelector('.bulk-check').checked = state.bulk.selected.has(item.key);
      updateBulkCount();
    };

    card.addEventListener('click', e => {
      if (e.target.classList.contains('bulk-check')) return;   // the checkbox fires its own change

      // A long tagline scrolls inside the tile, and clicking its scrollbar
      // still lands as a click on the card - so reaching for the bar would tick
      // the box instead.
      //
      // Measured as a band inside the right edge rather than "past the content
      // width", because an overlay scrollbar - which is what Chrome draws here -
      // takes no layout space at all: clientWidth and offsetWidth are equal, so
      // that comparison silently never fires. The band costs the last few pixels
      // of a line, and only on blurbs actually long enough to scroll.
      const tag = e.target;
      if (tag.classList.contains('bulk-card-tag') &&
          tag.scrollHeight > tag.clientHeight &&
          e.offsetX > tag.clientWidth - 12) return;

      toggle();
    });
    card.querySelector('.bulk-check').addEventListener('change', toggle);

    grid.appendChild(card);
  });

  updateBulkCount();
}

function updateBulkCount() {
  $('bulk-count').textContent = `${state.bulk.selected.size} selected`;
  $('bulk-convert').disabled = state.bulk.selected.size === 0;
}

$('bulk-select-all').addEventListener('click', () => {
  state.bulk.items.forEach(i => state.bulk.selected.add(i.key));
  renderBulkGrid();
});
$('bulk-select-none').addEventListener('click', () => {
  state.bulk.selected.clear();
  renderBulkGrid();
});

$('bulk-cancel').addEventListener('click', () => { state.cancelBulk = true; });

$('bulk-convert').addEventListener('click', async () => {
  const chosen = state.bulk.items.filter(i => state.bulk.selected.has(i.key));
  if (!chosen.length) return;

  const status = $('bulk-status');
  const progress = $('bulk-progress');
  const fill = $('bulk-progress-fill');
  const text = $('bulk-progress-text');

  state.cancelBulk = false;
  progress.classList.remove('hidden');
  $('bulk-convert').disabled = true;

  let done = 0, failed = 0, emptyJanitor = 0;
  const failures = [];

  // Whether the sites actually refused anything, as opposed to the run hitting
  // network trouble. Worth saying once at the end rather than on every line.
  let anyRefused = false;

  for (const item of chosen) {
    if (state.cancelBulk) break;

    const pct = Math.round((done + failed) / chosen.length * 100);
    fill.style.width = `${pct}%`;
    text.textContent = `${done + failed} / ${chosen.length} - ${item.name}`;

    try {
      // A mirrored library entry knows its own platform; a pasted URL is
      // resolved per line, so a mixed list converts in one run.
      const adapter = state.bulk.adapter || adapterForUrl(item.cardUrl).adapter;
      const card = await adapter.fetchCard(item.cardUrl, {
        token: state.tokens[adapter.id] || null,
        progress: msg => { text.textContent = `${done + failed} / ${chosen.length} - ${item.name}: ${msg}`; },
      });
      const character = toCccCharacter(card);
      await storeCharacter(character, {
        platform: card.sourcePlatform || adapter.label,
        sourceUrl: item.cardUrl,
      });
      if (isEmptyJanitorCard(card, character)) emptyJanitor++;
      done++;
    } catch (err) {
      failed++;
      if (err?.name === 'HttpError') anyRefused = true;
      failures.push(`${item.name}: ${err.message || err}`);
    }

    // Courtesy gap so a 50-card run does not arrive as one burst.
    await new Promise(r => setTimeout(r, 250));
  }

  fill.style.width = '100%';
  progress.classList.add('hidden');
  $('bulk-convert').disabled = false;
  await renderResults();
  noteEmptyJanitorCards(emptyJanitor);

  const cancelled = state.cancelBulk ? ' (cancelled early)' : '';
  setStatus(status,
    `Converted ${done} card(s)${failed ? `, ${failed} failed` : ''}${cancelled}.` +
    (failures.length ? `\n\nFailures:\n- ${failures.slice(0, 12).join('\n- ')}` : '') +
    (anyRefused ? `\n${REGION_HINT.trim()}` : ''),
    failed ? 'error' : 'ok');

  // Something has to have arrived for there to be anything to scroll to. A run
  // where every card failed leaves the person where they are, next to the grid
  // they picked from and the red status line explaining it.
  //   A partial run still counts as a landing, but it says so twice over: amber
  // rather than green, and the figure rather than a bare "done". The failures
  // stay above in the status line where they can be read at leisure.
  if (done) {
    if (failed) showToast(`${done} of ${chosen.length} cards converted`, 'warn');
    else        showToast(`${done} card${done > 1 ? 's' : ''} converted`);
    scrollToResults();
  }
});

/* ---------------- conversion feedback ---------------- */

// A conversion is started at the top of the page and lands at the bottom of it,
// and on a phone those are a screen or more apart - the old behaviour left the
// person looking at an unchanged paste box, with the only sign of success a
// line of text below it saying "see below". So the page goes there itself.
//   The toast exists because the scroll on its own is ambiguous: the screen
// moves, but nothing says whether that was a success, a failure, or a page
// jumping around. It is deliberately not put in the status line, which is up at
// the top and is exactly the thing being scrolled away from.
let toastTimer = null;

// kind is 'ok' for a clean run or 'warn' for one that lost cards along the way.
function showToast(message, kind = 'ok') {
  const toast = $('success-toast');

  // Cancel the previous run first - two conversions in quick succession would
  // otherwise leave the older timer to hide the newer message early.
  clearTimeout(toastTimer);

  // Rebuilt rather than toggled, so a green run following an amber one cannot
  // inherit the colour of the one before it.
  toast.className = `toast show${kind === 'warn' ? ' warn' : ''}`;

  // The text is written after the class, which looks backwards but is not: a
  // live region that changes while it is still visibility:hidden goes
  // unannounced by several screen readers. Nothing is painted between these two
  // lines - the browser renders once the function has returned - so there is no
  // flash of the previous message.
  toast.textContent = message;
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function scrollToResults() {
  // Chrome does not apply the reduced-motion setting to a programmatic smooth
  // scroll the way it does to the CSS property, so it is checked here rather
  // than assumed. A long glide is the part of this someone with that setting
  // turned on is asking not to be given.
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('results').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

/* ---------------- results ---------------- */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

async function renderResults() {
  const list = $('results-list');
  const empty = $('results-empty');
  const rows = await listCardsLight();

  $('results-count').textContent = String(rows.length);
  list.innerHTML = '';

  if (!rows.length) {
    empty.classList.remove('hidden');
    $('download-all').disabled = true;
    $('clear-all').disabled = true;
    return;
  }
  empty.classList.add('hidden');
  $('download-all').disabled = false;
  $('clear-all').disabled = false;

  rows.forEach(r => {
    const row = document.createElement('div');
    row.className = 'result-row';

    const badges = [];
    if (r.scenarioCount)   badges.push(`<span class="badge">${r.scenarioCount} greeting${r.scenarioCount > 1 ? 's' : ''}</span>`);
    if (r.galleryCount)    badges.push(`<span class="badge">${r.galleryCount} gallery</span>`);
    if (r.loreEntryCount)  badges.push(`<span class="badge">${r.loreEntryCount} lore</span>`);
    if (r.partial)         badges.push(`<span class="badge muted" title="No greeting or almost no description - the platform withheld the definition">partial</span>`);

    row.innerHTML = `
      ${r.thumbnail ? `<img class="result-thumb" src="${r.thumbnail}" alt="" />` : `<div class="result-thumb"></div>`}
      <div class="result-info">
        <p class="result-name">${escapeHtml(r.name)}</p>
        <p class="result-meta">${escapeHtml(r.platform)}${r.sourceUrl ? ' &middot; ' + escapeHtml(r.sourceUrl) : ''}</p>
        <div class="result-badges">${badges.join('')}</div>
      </div>
      <div class="result-actions">
        <button class="btn btn-small" data-act="download">Download</button>
        <button class="btn btn-small btn-danger" data-act="delete">Delete</button>
      </div>`;

    row.querySelector('[data-act="download"]').addEventListener('click', async () => {
      const full = await getCard(r.id);
      if (!full) return;
      downloadJson(toCccBackup([full.character]), `ccc_${fileSafe(full.name)}.json`);
    });

    row.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      const yes = await confirmDialog('Delete this card?', `"${r.name}" will be removed from this tool's storage.`);
      if (!yes) return;
      await deleteCard(r.id);
      await renderResults();
    });

    list.appendChild(row);
  });
}

/* ---------------- region notice ---------------- */

// Kept behind a button rather than shown on arrival: it only matters to people
// in the affected regions, and a standing warning about content nobody has
// asked for yet would be noise for everyone else.
function toggleRegionInfo(show) {
  const panel = $('region-info');
  const open = show ?? panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  $('region-info-btn').setAttribute('aria-expanded', String(open));
  if (open) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

$('region-info-btn').addEventListener('click', () => toggleRegionInfo());
$('region-info-close').addEventListener('click', () => toggleRegionInfo(false));

$('download-all').addEventListener('click', async () => {
  const rows = await listCardsLight();
  if (!rows.length) return;

  // Re-read one at a time rather than getAll: a large collection with
  // galleries would otherwise be fully resident before serialisation starts.
  const characters = [];
  for (const r of rows) {
    const full = await getCard(r.id);
    if (full?.character) characters.push(full.character);
  }
  const date = new Date().toISOString().split('T')[0];
  downloadJson(toCccBackup(characters), `ccc_converted_${characters.length}_cards_${date}.json`);
});

$('clear-all').addEventListener('click', async () => {
  const n = await countCards();
  if (!n) return;
  const yes = await confirmDialog(
    'Clear all converted cards?',
    `This permanently deletes all ${n} converted card(s) from this tool's interface and its IndexedDB storage. ` +
    `Anything you already downloaded and imported into Casual Character Chat is not affected. This cannot be undone.`,
    'Delete all'
  );
  if (!yes) return;
  await clearCards();
  await renderResults();
});

/* ---------------- boot ---------------- */

(async function init() {
  state.tokens = (await getSetting('tokens', {})) || {};
  await renderResults();

  // Not awaited: the suggestions go direct to chub and have nothing to do with
  // the proxy, so neither should wait on the other. The proxy check in
  // particular can sit for a minute against a sleeping service.
  loadDiscover();

  // After loadDiscover, which lays out its placeholder tiles before its first
  // await - so the step about the grid has a grid to point at even though
  // nothing has arrived in it yet. Not awaited either: a first-time visitor
  // should meet the tour while the proxy is still waking up, not after.
  maybeStartTour();

  await refreshProxyStatus();
})();
