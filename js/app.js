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

// The picker holds a feed rather than one library page. The site's page size is
// whatever the site says - 24 on chub, 34 on JanitorAI - and none of them is the
// number of tiles four rows of this grid can hold, so pages are pulled in and
// handed out in windows of that size instead. See emptyBulk.
function emptyBulk() {
  return {
    adapter: null,
    url: '',
    feed: [],              // every item pulled from the source so far, in order
    keys: new Set(),       // what is already in the feed, so a page that repeats
                           // an item (trending re-orders between calls) cannot
                           // put it in the grid twice
    startPage: 1,          // the source page the feed began at
    sourcePage: 0,         // the last source page pulled in
    sourcePages: 1,        // how many the source says it has
    sourcePageSize: 0,     // items in its first page, for the page-count estimate
    sourceTotal: 0,        // cards the search has in all, 0 until the site says
    offset: 0,             // index in the feed of the first tile on screen
    items: [],             // the window on screen
    selected: new Set(),   // keys selected in that window
    urlList: null,         // set when the user pasted individual card URLs
  };
}

const state = {
  tokens: {},          // adapterId -> token
  bulk: emptyBulk(),
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
  'a VPN set to the USA is the usual fix.';

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
// description - either a stub its author never filled in, or a definition the
// platform withheld. Badged in the results list so a half-empty card is not
// mistaken for a good one.
function isPartial(character) {
  const hasGreeting = character.scenarios.length > 0;
  const body = character.description.replace(/---[^-]*---/g, '').trim();
  return !hasGreeting || body.length < 40;
}

/* ---------------- the JanitorAI notices ---------------- */

// Both notices that offer a way out of a logged-out JanitorAI say the same two
// things, so the words live in one <template> and are stamped into each of them
// here rather than being kept in step by hand.
document.querySelectorAll('.jai-fix').forEach(slot => {
  slot.appendChild($('jai-fix-tpl').content.cloneNode(true));
});

// JanitorAI only, because the notice's two remedies are JanitorAI's. A stub
// card off chub.ai is partial in exactly the same way and still gets its badge,
// but nobody's login would fill it in - its author never wrote the thing.
function isPartialJanitorCard(adapter, character) {
  return adapter.id === 'janitorai' && isPartial(character);
}

// A partial card is not an error - nothing failed, the definition simply was
// not handed over - so without this it just looks like a disappointing card
// and there is no way to tell that anything can be done about it.
//
// It speaks about the run that just finished, so a later run that comes back
// whole takes it away again rather than leaving a stale warning over cards it
// does not describe.
function notePartialCards(count) {
  const notice = $('partial-notice');
  if (!count) {
    notice.classList.add('hidden');
    return;
  }
  $('partial-notice-title').textContent = count > 1
    ? 'Those cards came through partial'
    : 'That card came through partial';
  notice.classList.remove('hidden');
}

$('partial-notice-close').addEventListener('click', () => {
  $('partial-notice').classList.add('hidden');
});

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

  // One of the two things the notices ask for. Leaving them up after that has
  // been acted on would read as "that did not work".
  if (state.tokens.janitorai) $('partial-notice').classList.add('hidden');
  updateJaiInfo();
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
    notePartialCards(isPartialJanitorCard(adapter, character) ? 1 : 0);

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

// Pulls source pages into the feed until it holds `need` items or the source
// runs out. One press of Next can therefore cost a request, two, or none at
// all, depending on how the site's page size happens to divide.
async function fillFeed(need) {
  const b = state.bulk;

  while (b.feed.length < need && b.sourcePage < b.sourcePages) {
    const next = b.sourcePage + 1;
    const result = await b.adapter.listLibrary(b.url, next, {
      token: state.tokens[b.adapter.id] || null,
    });

    // Something else took the grid over while this was in flight - a pasted
    // link, a cleared page. Whatever it was, it is now what the person asked
    // for, and this reply belongs to a question they have moved on from.
    if (state.bulk !== b) return;

    const items = result.items || [];
    b.sourcePage = next;
    b.sourcePages = Math.max(result.totalPages || 1, next);
    if (!b.sourcePageSize) b.sourcePageSize = items.length;
    if (!b.sourceTotal && result.total) b.sourceTotal = result.total;

    const fresh = items.filter(i => !b.keys.has(i.key));
    fresh.forEach(i => b.keys.add(i.key));
    b.feed.push(...fresh);

    if (!items.length) {
      b.sourcePages = next;      // an empty page is the end, whatever it claimed
      break;
    }
  }
}

// Paging walks the feed rather than re-running the search, so editing the text
// without pressing Convert cannot send you to a page of something else, and
// stepping back costs nothing - those items are already here.
$('bulk-prev').addEventListener('click', () => stepBulkPage(-1));
$('bulk-next').addEventListener('click', () => stepBulkPage(1));

async function stepBulkPage(dir) {
  const b = state.bulk;
  if (b.urlList || !b.adapter) return;

  const per = tilesPerPage();
  const at = Math.max(0, b.offset + dir * per);
  const status = $('bulk-status');

  // Both buttons go dead for the duration. A second press while a page is on
  // its way would leave two fills racing for the same place in the feed, and
  // the loser's cards would simply not be there.
  $('bulk-prev').disabled = true;
  $('bulk-next').disabled = true;

  try {
    if (dir > 0 && b.feed.length < at + per && b.sourcePage < b.sourcePages) {
      setStatus(status, `Mirroring more of ${b.adapter.label}...`, 'busy');
      await fillFeed(at + per);
      if (state.bulk !== b) return;
    }
    if (at >= b.feed.length) return setStatus(status, 'That was the last page.', '');

    b.offset = at;
    b.selected.clear();          // a tick belongs to the page it was made on
    setStatus(status, bulkFoundMessage(Math.min(per, b.feed.length - at)), 'ok');
  } catch (err) {
    setStatus(status, describeError(err), 'error');
  } finally {
    if (state.bulk === b) renderBulkGrid();
  }
}

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

    avatarGeneration++;          // a mirrored page carries its own thumbnails

    // The feed has to be in place before it can be filled, so a search that
    // then fails would leave the grid showing one library and the tool holding
    // another - tiles that tick but convert nothing. On failure the previous
    // one goes back, and the tiles on screen are its own again.
    const previous = state.bulk;
    const mine = { ...emptyBulk(),
      adapter, url: raw,
      startPage: page,
      sourcePage: page - 1,      // nothing pulled in yet; the fill starts here
      sourcePages: page,         // raised to the real figure by the first reply
    };
    state.bulk = mine;

    try {
      await fillFeed(tilesPerPage());
    } catch (err) {
      if (state.bulk === mine) state.bulk = previous;
      throw err;
    }
    if (state.bulk !== mine) return;

    if (!state.bulk.feed.length) {
      setStatus(status, 'That library page returned no cards.', 'error');
      renderBulkGrid();
      return;
    }
    renderBulkGrid();
    setStatus(status, bulkFoundMessage(state.bulk.items.length), 'ok');
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
    ...emptyBulk(),
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

/* ---------------- the shape of the grid ---------------- */

// Four complete rows, always. A last row with three tiles in it looks like the
// end of the collection, which - with pages still to come - is the one thing it
// must not say. Everything else here follows from that: the window handed to
// the grid is sized to fill it, and the feed above buffers whatever page size
// the site happens to use.
const GRID_ROWS = 4;

// A wide screen fits seven tracks, and seven would put every chub page - 24
// cards - one row short of four, so each page would cost a second request to
// finish the grid. Six divides it exactly, and the tiles are larger for it.
const GRID_MAX_COLS = 6;

// Asked of the stylesheet rather than worked out from the width, so the two
// cannot disagree: the media queries fix the count on phones, and this reads
// back whatever they settled on.
function gridColumns() {
  const grid = $('bulk-grid');
  grid.style.gridTemplateColumns = '';
  const laid = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
  const cols = Math.max(1, Math.min(laid, GRID_MAX_COLS));
  if (cols < laid) grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  return cols;
}

function tilesPerPage() {
  return gridColumns() * GRID_ROWS;
}

// A window narrowed from six columns to four holds fewer tiles, so the page on
// screen has to be re-cut - and may need more of the feed than has been fetched.
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(async () => {
    const b = state.bulk;
    if (b.urlList || !b.feed.length) return;
    try { await fillFeed(b.offset + tilesPerPage()); } catch { /* keep what is here */ }
    if (state.bulk === b) renderBulkGrid();
  }, 200);
});

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
  renderSkeletons(tilesPerPage());
  setStatus(status, 'Loading trending characters from chub.ai...', 'busy');

  try {
    const { adapter } = adapterForUrl(DISCOVER_URL);

    state.bulk = { ...emptyBulk(), adapter, url: DISCOVER_URL };
    const mine = state.bulk;
    await fillFeed(tilesPerPage());
    if (discoverSuperseded || state.bulk !== mine) return;

    if (!state.bulk.feed.length) throw new Error('no cards returned');
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
  state.bulk = emptyBulk();
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
    : 'Select any characters &rarr; Convert & Download &rarr; Import to Casual Character Chat';
}

// How many cards this search has to offer, not how many are on screen - the
// grid holds four rows of them and the search is usually hundreds deep.
//
// Counted as what the site said, capped at what its own page count can actually
// hold: JanitorAI signed out quotes a library of thousands and then serves one
// page of it, and the number worth showing is the one that can be converted.
// Sites that quote nothing are estimated from their pages instead.
function bulkTotalCards() {
  const b = state.bulk;
  const reach = b.sourcePages * b.sourcePageSize;
  if (b.sourceTotal) return reach ? Math.min(b.sourceTotal, reach) : b.sourceTotal;

  const unseen = Math.max(0, b.sourcePages - b.sourcePage) * b.sourcePageSize;
  return b.feed.length + unseen;
}

// What a search found, not what one screen of it holds: "24 cards" under a grid
// of 24 reads as the whole result, when it is the first four rows of hundreds.
function bulkFoundMessage(shown) {
  const total = bulkTotalCards();
  return total > shown
    ? `${total} cards found - ${shown} on this page. Tick the ones you want.`
    : `${shown} cards. Tick the ones you want.`;
}

// The site counts in its own pages and this grid counts in four rows, so the
// figure is recut here. Never below the page being looked at, so the label
// cannot say "Page 5 / 4" on the way through.
function bulkPageCount(per, page) {
  return Math.max(page, Math.ceil(bulkTotalCards() / per) || 1);
}

function renderBulkGrid() {
  const grid = $('bulk-grid');
  const toolbar = $('bulk-toolbar');
  const b = state.bulk;

  // Pasted links are a list, not a library: there is no page after them, so all
  // of them are shown - windowing that would hide links someone chose by hand.
  const per = tilesPerPage();
  if (!b.urlList) b.items = b.feed.slice(b.offset, b.offset + per);

  grid.innerHTML = '';
  renderBulkSource();
  updateJaiInfo();

  if (!b.items.length) {
    toolbar.classList.add('hidden');
    return;
  }
  toolbar.classList.remove('hidden');

  const page = Math.floor(b.offset / per) + 1;
  $('bulk-page').textContent = b.urlList ? `${b.items.length} URLs` : `Page ${page} / ${bulkPageCount(per, page)}`;
  $('bulk-prev').disabled = b.urlList || b.offset === 0;
  $('bulk-next').disabled = b.urlList ||
    (b.offset + per >= b.feed.length && b.sourcePage >= b.sourcePages);

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

  let done = 0, failed = 0, partial = 0;
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
      if (isPartialJanitorCard(adapter, character)) partial++;
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
  notePartialCards(partial);

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
    if (r.partial)         badges.push(`<span class="badge muted" title="No greeting or almost no description - the platform withheld the definition">partial card</span>`);

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

/* ---------------- the "Missing characters?" notice ---------------- */

// Kept behind a button rather than shown on arrival: the grid is still useful
// as it stands, and an explanation nobody asked for above every result would be
// noise. The button itself is only there when the sentence behind it is true -
// JanitorAI results, no token - so it never sends anyone looking for a problem
// they do not have.
function updateJaiInfo() {
  const b = state.bulk;
  const show = !state.tokens.janitorai && !b.urlList &&
    b.adapter?.id === 'janitorai' && b.items.length > 0;

  $('jai-info-wrap').classList.toggle('hidden', !show);
  if (!show) toggleJaiInfo(false);
}

function toggleJaiInfo(show) {
  const panel = $('jai-info');
  const open = show ?? panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  $('jai-info-btn').setAttribute('aria-expanded', String(open));
  if (open) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

$('jai-info-btn').addEventListener('click', () => toggleJaiInfo());
$('jai-info-close').addEventListener('click', () => toggleJaiInfo(false));

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
