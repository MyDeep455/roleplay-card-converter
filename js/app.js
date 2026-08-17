/* =========================================================================
 * APP - wiring, UI state and the conversion pipelines
 * ========================================================================= */

import { ADAPTERS, adapterForUrl, emptyCriteria } from './adapters.js';
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
import { connect, ready, sendBackup, focusApp } from './ccc-link.js';

const $ = id => document.getElementById(id);

// The picker toolbar is on the page twice - once above the grid and once below
// it - so that a page of four rows can be paged, selected and converted from
// whichever end of it you happen to be at. Neither copy is the original: these
// four reach every control carrying the class, so the pair is labelled, enabled
// and listened to as one thing and cannot show two different answers.
const $$ = sel => [...document.querySelectorAll(sel)];
const setText = (sel, text) => $$(sel).forEach(el => { el.textContent = text; });
const setDisabled = (sel, off) => $$(sel).forEach(el => { el.disabled = off; });
const setBusyAll = (sel, busy) => $$(sel).forEach(el => setBusy(el, busy));
const onAll = (sel, event, fn) => $$(sel).forEach(el => el.addEventListener(event, fn));

// Both toolbars appear and disappear with the grid they belong to.
const showToolbars = show =>
  $$('.bulk-toolbar').forEach(el => el.classList.toggle('hidden', !show));

// Six figures is normal for a chub search and "364720" is not a number anyone
// reads at a glance, so counts are grouped in the reader's own locale.
const fmt = n => Number(n).toLocaleString();

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
    sourcePage: 0,         // the last source page pulled in
    sourcePages: 1,        // how many the source says it has
    sourcePageSize: 0,     // items in its first page, for the page-count estimate
    sourceTotal: 0,        // cards the search has in all, 0 until the site says
    sourceTotalIsFloor: false,   // and that figure is the most the site will
                           // admit to rather than the size of the library
    offset: 0,             // index in the feed of the first tile on screen
    items: [],             // the window on screen
    selected: new Set(),   // keys selected in that window
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

  // A busy line gets the ring in front of it. These messages are written the
  // moment a request goes out and left there until it lands, so on their own
  // they cannot say whether the tool is still asking or gave up quietly a
  // minute ago - which is the whole question anybody staring at one has.
  if (kind === 'busy' && message) el.prepend(busyRing());
}

function busyRing() {
  const ring = document.createElement('span');
  ring.className = 'spinner';
  ring.setAttribute('aria-hidden', 'true');   // the status text is the message
  return ring;
}

/**
 * Mark the control that started something as still waiting on it.
 *
 * Disabled at the same time, and deliberately in the same call: a control that
 * is visibly working and still pressable invites the second press that starts a
 * second copy of the work.
 */
function setBusy(el, busy) {
  if (!el) return;
  el.classList.toggle('is-busy', busy);
  el.disabled = busy;
}

/**
 * A mirror is in flight.
 *
 * Search is the only thing that starts one, so the button that started it is
 * also the one that has to go out of service: a second press would throw away
 * the page already on its way.
 */
function setMirrorBusy(busy) {
  setBusy($('search-btn'), busy);
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

/* ---------------- importing straight into the app ---------------- */

// Both Import buttons do the same three things in the same order, and the
// order is the whole trick: the app tab has to be asked for *before* the cards
// are read out of IndexedDB. `connect()` may need window.open, and a browser
// only grants that while the click is still on the stack - one await first and
// the popup is blocked instead. So the tab is claimed first and the cards are
// loaded into it while it boots.
//
// `load` is therefore a function, not an array: it is called after the tab is
// already opening.
//
// The button is passed in rather than read off the event inside, because
// `event.currentTarget` is only set while the event is being dispatched and is
// null by the time any handler that awaited something looks at it.
//
// @param load      () => Promise<character[]>
// @param describe  (added: number) => string, for the toast: '"Alice"', '3 cards'.
//                  Given what the app actually took, not what was sent, so a
//                  batch that was half duplicates does not claim all of it.
async function importToCcc(button, load, describe) {
  const label = button.textContent;
  let session;
  let hint = null;

  try {
    session = connect();               // synchronous on purpose - see above
  } catch (err) {
    showToast(describeError(err), 'warn');
    return false;
  }

  // The label already says what is happening; the ring says it is still
  // happening, which matters here because the wait is on another tab answering
  // and there is nothing else on this page to watch.
  setBusy(button, true);
  button.textContent = 'Importing…';

  try {
    const characters = await load();
    if (!characters.length) return false;

    // Waited for here rather than left to sendBackup, which asks again a line
    // later: until the app has answered there is nothing over there to be
    // confirmed, and a cold tab still pulling down its starter pack - or one in
    // the middle of a refresh - would otherwise be pointed at while it loads.
    await ready(session);
    hint = confirmHint(button, session.opened);

    const result = await sendBackup(session, toCccBackup(characters));

    if (result.cancelled) {
      showToast('Import cancelled in Casual Character Chat.', 'warn');
      return false;
    }

    // The app skips a character whose id it already holds, which is what
    // makes importing the same card twice harmless - and worth saying, so a
    // second press that appears to do nothing is explained rather than
    // looking broken.
    if (!result.added && result.skipped) {
      showToast(`Already in Casual Character Chat - nothing to add.`, 'warn');
      return true;
    }

    const skipped = result.skipped ? `, ${result.skipped} already there` : '';
    showToast(`Imported ${describe(result.added)} into Casual Character Chat${skipped}.`);
    return true;
  } catch (err) {
    showToast(describeError(err), 'warn');
    return false;
  } finally {
    // Before the toast is painted, not after: `finally` runs while the return
    // value is still on its way out, so both changes land in the same frame and
    // the hint does not flash underneath the answer it was waiting for.
    hint?.end();
    setBusy(button, false);
    button.textContent = label;
  }
}

/* ---------------- "confirm it over there" ---------------- *
 *
 * The app asks before letting cards in from a page it did not open itself, and
 * it asks on its own tab - which is never the tab anyone is looking at, because
 * the press that started the import was here. Left alone, an import that is
 * really only waiting on a person looks exactly like one that has hung: a
 * disabled button with a ring on it, and the reason sitting one tab away.
 *
 * Nothing in the protocol says the question was asked - the app speaks once
 * more, and only to say what it did - so it is inferred, and the two cases are
 * not equally certain:
 *
 *   we opened the app    It never opened this tool, so it has no window to
 *                        recognise and always asks. Said at once, plainly.
 *
 *   the app opened us    It knows this tab and lets the cards straight in -
 *                        unless it was reloaded since, which quietly costs it
 *                        that memory and brings the question back. Too rare to
 *                        say up front and too confusing to leave unsaid, so it
 *                        is left to a timer: if the app has still not answered
 *                        after a few seconds, its dialog is the likeliest
 *                        thing holding it up.
 */

// Comfortably past a merge of its own: a batch of cards carrying galleries is a
// real write and not instant, and an import that is simply busy should finish
// without ever having claimed somebody was being asked something.
const CONFIRM_HINT_AFTER_MS = 3000;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

const HINT_GAP = 10;    // between the hint and the button it belongs to
const HINT_EDGE = 12;   // and between the hint and the edge of the window

// There is one hint and there can be two imports - a row's Import press is not
// blocked while "Import all" is still waiting - so it is owned rather than
// merely shown. A later import takes it over; the earlier one then leaves it
// alone on its way out instead of pulling it out from under the newer one.
let hintOwner = null;
let hintAnchor = null;

/**
 * Say that the other tab is waiting on an answer, near the button that started
 * it. Returns a handle; call `.end()` when the import lands, however it lands.
 *
 * @param button   the Import control that was pressed, and what this points at
 * @param certain  true when the app is one we opened and will therefore ask
 */
function confirmHint(button, certain) {
  const owner = {};

  owner.timer = setTimeout(() => {
    hintOwner = owner;
    hintAnchor = button;

    const hint = $('confirm-hint');

    // Unhidden before it is written, which looks backwards and is not: several
    // screen readers ignore a live region that changes while it is still
    // display:none. Nothing is painted between these lines, so there is no
    // flash of the previous import's wording.
    hint.classList.remove('hidden');
    $('confirm-hint-title').textContent = certain
      ? 'Confirm this in Casual Character Chat'
      : 'Still waiting on Casual Character Chat';
    $('confirm-hint-text').textContent = certain
      ? 'That tab is asking whether to let these cards in. Say yes there and the import finishes.'
      : 'If that tab is asking whether to let these cards in, say yes there and the import finishes.';

    placeConfirmHint();
    addEventListener('scroll', placeConfirmHint, { capture: true, passive: true });
    addEventListener('resize', placeConfirmHint, { passive: true });
  }, certain ? 0 : CONFIRM_HINT_AFTER_MS);

  owner.end = () => {
    clearTimeout(owner.timer);
    if (hintOwner && hintOwner !== owner) return;

    hintOwner = null;
    hintAnchor = null;
    $('confirm-hint').classList.add('hidden');
    removeEventListener('scroll', placeConfirmHint, { capture: true });
    removeEventListener('resize', placeConfirmHint);
  };

  return owner;
}

function placeConfirmHint() {
  const hint = $('confirm-hint');
  if (!hintAnchor || hint.classList.contains('hidden')) return;

  const r = hintAnchor.getBoundingClientRect();
  const w = hint.offsetWidth, h = hint.offsetHeight;
  const vw = innerWidth, vh = innerHeight;
  const arrow = $('confirm-hint-arrow');

  // Scrolled away from its button, the hint has nothing left to point at. It
  // stays - it is still the answer to why nothing is happening - but it goes to
  // the foot of the window with its pointer off, rather than pressing itself
  // against an edge and aiming at whatever happens to be behind it.
  if (r.bottom < HINT_EDGE || r.top > vh - HINT_EDGE) {
    arrow.hidden = true;
    hint.classList.remove('is-above');
    hint.style.transform =
      `translate(${Math.round((vw - w) / 2)}px, ${Math.round(vh - h - HINT_EDGE)}px)`;
    return;
  }

  // Below by preference. Both Import buttons sit above what they act on, so
  // downwards is the direction with page to spare, and upwards would cover the
  // results the hint is talking about.
  const above = r.bottom + HINT_GAP + h > vh - HINT_EDGE;
  const top = above ? r.top - HINT_GAP - h : r.bottom + HINT_GAP;
  const left = clamp(r.left + r.width / 2 - w / 2, HINT_EDGE, Math.max(HINT_EDGE, vw - w - HINT_EDGE));

  arrow.hidden = false;
  hint.classList.toggle('is-above', above);
  hint.style.transform =
    `translate(${Math.round(left)}px, ${Math.round(clamp(top, HINT_EDGE, Math.max(HINT_EDGE, vh - h - HINT_EDGE)))}px)`;

  // Follows the button when the card itself has been pushed off its centre by
  // the edge of the window, so it still points at the button and not at the
  // middle of nowhere. Kept clear of the rounded corners at either end.
  arrow.style.left = `${Math.round(clamp(r.left + r.width / 2 - left, 16, Math.max(16, w - 16)))}px`;
}

// The whole point is to get someone over there, so the hint offers the trip
// rather than only describing it. Cross-origin focus needs a gesture to be
// allowed, and a click is one - which is why this is a button and not something
// the hint does by itself on the way up.
$('confirm-hint-go').addEventListener('click', focusApp);

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

  // The panel's note asks for exactly this token, so it has to stop asking the
  // moment one is saved.
  updateSearchNote(searchAdapter());
});

/* =========================================================================
 * THE SEARCH PANEL
 * -------------------------------------------------------------------------
 * Browsing used to mean leaving: set a search up on chub, copy the address
 * bar, come back, paste. The panel closes that loop, and it is now the only
 * way in - it builds the site's own search URL and hands it to the mirror. So
 * there is one code path from here down, and a search made here can still be
 * opened on the site, because it is that site's URL.
 *
 * What the panel can offer differs per platform and is never guessed: each
 * adapter's `search` descriptor names its sort orders and says which filters
 * it can actually honour. A control the chosen site would ignore is hidden
 * rather than shown dead, because a tag box that silently changes nothing is
 * worse than no tag box at all.
 * ========================================================================= */

// Kept in sync with loadDiscover below: the opening grid and the panel above
// it must agree on the first paint, or the tool appears to be showing the
// results of a search nobody ran. chub is the choice for both because it needs
// neither the proxy nor a token - see loadDiscover.
const DEFAULT_PLATFORM = 'chub';

const searchable = () => ADAPTERS.filter(a => a.search);

function searchAdapter() {
  return searchable().find(a => a.id === $('search-platform').value) || searchable()[0];
}

/** What is in the boxes right now. */
function readCriteria() {
  const splitList = s => s.split(',').map(t => t.trim()).filter(Boolean);
  return {
    term: $('search-term').value.trim(),
    sort: $('search-sort').value,
    tags: splitList($('search-tags').value),
    excludeTags: splitList($('search-exclude').value),
    nsfw: $('search-nsfw').value,
  };
}

/** Put criteria back into the boxes - used by Reset filters. */
function writeCriteria(c) {
  $('search-term').value = c.term || '';
  $('search-tags').value = (c.tags || []).join(', ');
  $('search-exclude').value = (c.excludeTags || []).join(', ');
  $('search-nsfw').value = c.nsfw || 'include';
  updateFilterCount();

  // Only if this platform actually has the sort that was asked for; the
  // vocabularies do not overlap, so a stale value would silently select the
  // first entry in the menu instead.
  //
  // Tested against the options rather than for truthiness, because "" is a
  // real choice on Character Tavern - its relevance ordering is the absence of
  // a sort parameter - and skipping it would leave the menu showing whatever
  // the last platform was on.
  const sort = $('search-sort');
  if ([...sort.options].some(o => o.value === c.sort)) sort.value = c.sort;
}

/**
 * Redraw the sort menu for the chosen platform.
 *
 * The three sites share almost no sort values - chub says `created_at` where
 * JanitorAI says `created` and Character Tavern says `newest` - so switching
 * platform cannot simply keep the string. It keeps the *label* instead, so
 * someone reading "Newest" who switches sites is still reading Newest
 * afterwards, and only falls back to the platform default when the ordering
 * they were on does not exist there at all.
 *
 * An ordering the adapter has flagged as `narrows` is never arrived at this
 * way, only chosen. "Trending" on both chub and Character Tavern turns out to
 * be a shelf of a few hundred cards rather than an ordering of the library, and
 * a search term intersected with a shelf that size is reliably nothing at all -
 * so carrying the word across would hand someone an empty grid for a search
 * that works. Picking it deliberately still works; drifting into it does not.
 *
 * All three platforms open on Relevance, so the ordinary move - change site,
 * search again - keeps the ordering someone never touched.
 */
function populateSortMenu(adapter, keepLabel = '') {
  const sel = $('search-sort');
  sel.innerHTML = '';
  adapter.search.sorts.forEach(o => sel.add(new Option(o.label, o.value)));

  const match = adapter.search.sorts.find(o => o.label === keepLabel && !o.narrows);
  sel.value = match ? match.value : adapter.search.defaultSort;
}

/** Hide the controls this platform would ignore, and say why where it helps. */
function applyPlatformSupport(adapter) {
  const s = adapter.search.supports;
  $('search-tags-field').classList.toggle('hidden', !s.tags);
  $('search-exclude-field').classList.toggle('hidden', !s.excludeTags);
  $('search-nsfw-field').classList.toggle('hidden', !s.nsfw);

  const hint = adapter.search.tagHint || '';
  if (s.tags) $('search-tags').placeholder = hint.replace(/^e\.g\. /, '');

  // A control that has just been hidden was possibly the one being counted.
  updateFilterCount();
  updateSearchNote(adapter);
}

/**
 * How many of the folded-away filters are actually narrowing the search.
 *
 * The three of them live behind a shut disclosure, so a tag typed once and
 * forgotten is invisible - and a search that then comes back with four cards
 * reads as a site with nothing to offer rather than as a filter still doing its
 * job. The number on the closed line is what makes hiding them safe.
 *
 * Only the ones this platform honours are counted. The boxes keep their text
 * when the site changes, and JanitorAI's search ignores tags entirely - so
 * counting them there would report two filters at work on a search that is not
 * using either.
 */
function updateFilterCount() {
  const s = searchAdapter().search.supports;
  const c = readCriteria();

  const n = (s.tags && c.tags.length ? 1 : 0)
          + (s.excludeTags && c.excludeTags.length ? 1 : 0)
          + (s.nsfw && c.nsfw !== 'include' ? 1 : 0);

  // A bare numeral in the badge, spelled out for anyone who cannot see it is a
  // badge: "Advanced filters 2" is only a sentence to someone looking at it.
  const el = $('filter-count');
  const words = `${n} filter${n === 1 ? '' : 's'} set`;
  el.textContent = n ? String(n) : '';
  el.title = words;
  el.setAttribute('aria-label', words);
  el.classList.toggle('hidden', !n);
}

/**
 * The line under the panel. Only ever about something that would otherwise
 * fail or come back short without explaining itself.
 */
function updateSearchNote(adapter) {
  const note = $('search-note');
  const notes = [];

  // JanitorAI is the one platform where searching signed out does not return
  // less - it returns 401. Better said before the search than after it.
  if (adapter.search.tokenRequiredFor === 'search' && !state.tokens[adapter.id]) {
    notes.push(
      `${adapter.label} needs your account token to search or to page past the first results. ` +
      `Add one in Settings - without it you can still browse this first page.`
    );
  }
  if (!adapter.search.supports.tags) {
    notes.push(`${adapter.label}'s API ignores tag filters, so there are no tag boxes for it.`);
  }

  note.textContent = notes.join(' ');
  note.classList.toggle('hidden', !notes.length);
}

/**
 * Redraw the panel for whichever platform is now chosen.
 *
 * Deliberately does not search - it is also how the panel is set up at boot,
 * which does not want a fetch. The listener below adds that for the case that
 * does.
 */
function onPlatformChange() {
  const adapter = searchAdapter();
  const keep = $('search-sort').selectedOptions[0]?.textContent || '';
  populateSortMenu(adapter, keep);
  applyPlatformSupport(adapter);
}

/**
 * What to suggest letting go of when a search comes back with nothing.
 *
 * "That library page returned no cards" is true and useless: with four
 * controls set, the one that emptied it could be any of them. This names what
 * is actually narrowing, worst offender first - a sort the adapter has warned
 * about goes to the front, because that is the one nobody would suspect.
 */
function narrowingHint(adapter, criteria) {
  const sortOption = adapter.search.sorts.find(o => o.value === criteria.sort);
  const bits = [];

  if (criteria.term) bits.push('the search term');
  if (criteria.tags.length) bits.push('the tags');
  if (criteria.excludeTags.length) bits.push('the excluded tags');
  if (criteria.nsfw !== 'include') bits.push('the content filter');

  if (!bits.length && !sortOption?.narrows) return '';

  const loosen = bits.length ? ` Try loosening ${bits.join(', ')}.` : '';
  return `${sortOption?.narrows ? ` ${sortOption.narrows}` : ''}${loosen}`;
}

/** Build the platform's own search URL from the panel and mirror it. */
function runSearch() {
  const adapter = searchAdapter();

  // This is the person's own request, so a suggestion load still in flight must
  // not land on top of it.
  discoverSuperseded = true;

  const criteria = { ...emptyCriteria(), ...readCriteria() };
  const url = adapter.search.build(criteria);

  return startMirror(url, narrowingHint(adapter, criteria));
}

function initSearchPanel() {
  const sel = $('search-platform');
  searchable().forEach(a => sel.add(new Option(a.label, a.id)));
  sel.value = DEFAULT_PLATFORM;
  onPlatformChange();
}

// Switching site searches straight away, for the same reason the sort menu
// does: the panel is a description of the grid beneath it. Leaving the old
// site's results sitting under a panel that now names a different one is the
// tool contradicting itself, and the first thing anyone would do to resolve
// that is press Search - so it is pressed for them.
$('search-platform').addEventListener('change', () => {
  onPlatformChange();
  runSearch();
});

$('search-btn').addEventListener('click', runSearch);

// A one-line search field that ignores Enter feels broken, so all three submit.
['search-term', 'search-tags', 'search-exclude'].forEach(id => {
  $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
  });
});

// The badge on the shut section counts what is typed, not what was last
// searched for - it is there to be read on the way to pressing Search.
['search-tags', 'search-exclude'].forEach(id => {
  $(id).addEventListener('input', updateFilterCount);
});

// Changing the ordering or the safety filter is a new search every time, so it
// runs itself rather than leaving a stale grid under a changed menu.
$('search-sort').addEventListener('change', runSearch);
$('search-nsfw').addEventListener('change', () => {
  updateFilterCount();
  runSearch();
});

$('search-reset').addEventListener('click', () => {
  const adapter = searchAdapter();
  writeCriteria({ ...emptyCriteria(), sort: adapter.search.defaultSort });
  runSearch();
});

/* ---------------- bulk mirror ---------------- */

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

    // Something else took the grid over while this was in flight - another
    // search, a cleared page. Whatever it was, it is now what the person asked
    // for, and this reply belongs to a question they have moved on from.
    if (state.bulk !== b) return;

    const items = result.items || [];
    b.sourcePage = next;
    b.sourcePages = Math.max(result.totalPages || 1, next);

    // What a full page of this site holds. The site's own figure first, because
    // the page that arrived is not evidence of it: the last page of any search
    // is a short one, so a search that lands on its end used to teach this that
    // pages were 16 cards long and report a 36,472-card search as 24,320. Falls
    // back to the largest page actually seen, which can then only correct the
    // figure upwards.
    b.sourcePageSize = Math.max(b.sourcePageSize, result.pageSize || 0, items.length);

    if (!b.sourceTotal && result.total) {
      b.sourceTotal = result.total;
      b.sourceTotalIsFloor = !!result.totalIsFloor;
    }

    const fresh = items.filter(i => !b.keys.has(i.key));
    fresh.forEach(i => b.keys.add(i.key));
    b.feed.push(...fresh);

    if (!items.length) {
      b.sourcePages = next;      // an empty page is the end, whatever it claimed
      break;
    }
  }
}

// Paging walks the feed rather than re-running the search, so editing the panel
// without pressing Search cannot send you to a page of something else, and
// stepping back costs nothing - those items are already here.
onAll('.js-bulk-prev', 'click', () => stepBulkPage(-1));
onAll('.js-bulk-next', 'click', () => stepBulkPage(1));

async function stepBulkPage(dir) {
  const b = state.bulk;
  if (!b.adapter) return;

  const per = tilesPerPage();
  const at = Math.max(0, b.offset + dir * per);
  const status = $('bulk-status');

  // Both buttons go dead for the duration - in both toolbars, or the copy that
  // was left live would be the second press. A second press while a page is on
  // its way would leave two fills racing for the same place in the feed, and
  // the loser's cards would simply not be there.
  setDisabled('.js-bulk-prev', true);
  setDisabled('.js-bulk-next', true);

  try {
    if (dir > 0 && b.feed.length < at + per && b.sourcePage < b.sourcePages) {
      setStatus(status, `Mirroring more of ${b.adapter.label}...`, 'busy');

      // The page being left is cleared away for placeholders while the next one
      // is fetched. Leaving it up was the quieter option and the wrong one:
      // pressing Next and being shown the same twenty-four cards for four
      // seconds reads as a button that did nothing, and the second press is
      // then the one thing that actually costs a page.
      //   Toolbars stay - they are the controls being waited on, and pulling
      // them out from under the cursor would move everything below them.
      renderSkeletons(per, { keepToolbars: true });
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

// `sourceUrl` is the site's own search URL, built by the panel above from what
// is in its boxes - so what gets mirrored is that site's own search, addressed
// the way that site addresses it.
//
// Always from the beginning of it. This only ever runs on a search someone has
// just asked for, and page 4 of the last one is no part of that; `stepBulkPage`
// is what walks onwards from here.
//
// `emptyHint` is only ever read when the search comes back with nothing, and
// names which of the panel's controls is the likely culprit.
async function startMirror(sourceUrl, emptyHint = '') {
  const status = $('bulk-status');
  const raw = (sourceUrl || '').trim();

  try {
    const { adapter } = adapterForUrl(raw);

    // Say so up front when the wait is going to be a cold start rather than a
    // slow site, otherwise a minute of nothing reads as a hang.
    const coldStart = needsProxy(raw) && getProxyKind() === 'hosted' && !isProxyBlocked();
    setStatus(
      status,
      coldStart
        ? `Mirroring ${adapter.label}... (waking the cloud proxy, this can take up to a minute the first time)`
        : `Mirroring ${adapter.label}...`,
      'busy'
    );
    setMirrorBusy(true);

    // Placeholder tiles for the same reason the opening grid uses them: a
    // search that replaces the grid has to look like it is being answered from
    // the moment it is asked, and the shape of what is coming says that better
    // than a line of text under the old results.
    renderSkeletons(tilesPerPage());

    avatarGeneration++;          // a mirrored page carries its own thumbnails

    // The feed has to be in place before it can be filled, so a search that
    // then fails would leave the grid showing one library and the tool holding
    // another - tiles that tick but convert nothing. On failure the previous
    // one goes back, and the tiles on screen are its own again.
    const previous = state.bulk;
    const mine = { ...emptyBulk(), adapter, url: raw };
    state.bulk = mine;

    try {
      await fillFeed(tilesPerPage());
    } catch (err) {
      if (state.bulk === mine) state.bulk = previous;
      throw err;
    }
    if (state.bulk !== mine) return;

    if (!state.bulk.feed.length) {
      setStatus(status, `Nothing matched that search.${emptyHint}`, 'error');
      renderBulkGrid();
      return;
    }
    renderBulkGrid();
    setStatus(status, bulkFoundMessage(state.bulk.items.length), 'ok');
  } catch (err) {
    setStatus(status, describeError(err), 'error');

    // The placeholders above are standing where the previous grid was, and the
    // previous grid is what state has just been rolled back to - so it is put
    // back on screen rather than left as tiles that will never fill in.
    renderBulkGrid();
  } finally {
    setMirrorBusy(false);
  }
}

// Bumped whenever the grid is replaced, so a thumbnail that was still being
// looked up for the page before it cannot draw itself over the page that took
// its place.
let avatarGeneration = 0;

/* =========================================================================
 * OPENING SUGGESTIONS
 * -------------------------------------------------------------------------
 * An empty page with one text box does not say what the tool is for, and gives
 * someone nothing to try without leaving to find a link first. So a page of
 * chub's library loads on its own - chub needs no proxy, so this works even
 * when the proxy is asleep, blocked or absent.
 *
 * Nothing is preselected and nothing is fetched beyond the listing itself:
 * these are suggestions, not work already started on someone's behalf.
 * ========================================================================= */

// Built from the adapter rather than written out, so the opening grid is
// literally the search the panel above it is showing - press Search without
// touching anything and you get the same page back, which is what makes the
// panel readable as a description of the grid rather than as an empty form.
const DISCOVER_URL = (() => {
  const a = ADAPTERS.find(x => x.id === DEFAULT_PLATFORM);
  return a.search.build({ ...emptyCriteria(), sort: a.search.defaultSort });
})();

// The moment someone runs a search of their own, whatever this was loading
// stops mattering - a late reply must not replace what they actually asked for.
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
    if (!b.feed.length) return;
    try { await fillFeed(b.offset + tilesPerPage()); } catch { /* keep what is here */ }
    if (state.bulk === b) renderBulkGrid();
  }, 200);
});

// `keepToolbars` is for paging, which is the one case where what is on screen
// is still the thing being worked on: the page controls go on describing it
// truthfully while the next page arrives, and taking them away would collapse
// the page around the button that was just pressed.
function renderSkeletons(n, { keepToolbars = false } = {}) {
  const grid = $('bulk-grid');
  grid.innerHTML = '';

  // Nothing has arrived yet, so asking for a choice between tiles that are
  // still placeholders would be premature.
  if (!keepToolbars) {
    $('bulk-hint').classList.add('hidden');
    showToolbars(false);
  }
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
  setStatus(status, 'Loading characters from chub.ai...', 'busy');

  try {
    const { adapter } = adapterForUrl(DISCOVER_URL);

    state.bulk = { ...emptyBulk(), adapter, url: DISCOVER_URL };
    const mine = state.bulk;
    await fillFeed(tilesPerPage());
    if (discoverSuperseded || state.bulk !== mine) return;

    if (!state.bulk.feed.length) throw new Error('no cards returned');
    renderBulkGrid();

    // The search panel above is already set to what these are, so a sentence
    // under it saying the same thing again is just noise.
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

// A page of search results is a shelf, not an order - nothing below it is
// converted until it is picked, so this line says which step is being asked for
// rather than leaving the grid looking like something already underway.
//
// Where the cards came from is not repeated here. The search panel above is
// still set to the platform and the terms that fetched them, which says it
// already, and there is no longer any other way for a grid to arrive.
function renderBulkHint() {
  const hint = $('bulk-hint');
  const { url, items } = state.bulk;

  if (!items.length || !url) {
    hint.classList.add('hidden');
    hint.innerHTML = '';
    return;
  }

  hint.classList.remove('hidden');
  hint.innerHTML = 'Select any characters, then convert & import:';
}

// How many cards this search has to offer, not how many are on screen - the
// grid holds four rows of them and the search is usually hundreds deep.
//
// Whatever the site said, full stop. There is no ceiling of any kind here, and
// there used to be one: the figure was held down to the site's page count times
// its page size, on the theory that a library it will not page through is not
// really on offer. That is true of exactly one site - JanitorAI signed out - and
// that case is answered where it belongs, in the adapter, which reports the one
// page it will actually serve rather than the library behind it. Everywhere else
// the two numbers are quoted independently and either can round short, so a site
// with a real 36,472-card search and a page count that only reaches 24,320 was
// having 12,000 cards taken off its total by arithmetic. Sites that quote no
// total at all are still estimated from their pages, because there is nothing
// else to go on.
function bulkTotalCards() {
  const b = state.bulk;
  if (b.sourceTotal) return b.sourceTotal;

  const unseen = Math.max(0, b.sourcePages - b.sourcePage) * b.sourcePageSize;
  return b.feed.length + unseen;
}

// What a search found, not what one screen of it holds: "24 cards" under a grid
// of 24 reads as the whole result, when it is the first four rows of hundreds.
//
// The "+" is only ever on a figure the site itself has stopped counting at, and
// it is there because the alternative is worse: a flat "100,000 cards found" is
// a suspiciously round number that reads as a limit this tool imposed, when it
// is the point past which chub will not answer.
function bulkFoundMessage(shown) {
  const total = bulkTotalCards();
  const more = state.bulk.sourceTotalIsFloor && total >= state.bulk.sourceTotal ? '+' : '';
  return total > shown
    ? `${fmt(total)}${more} cards found - ${fmt(shown)} on this page.`
    : `${fmt(shown)} cards.`;
}

// The site counts in its own pages and this grid counts in four rows, so the
// figure is recut here. Never below the page being looked at, so the label
// cannot say "Page 5 / 4" on the way through. Unbounded above: a six-figure
// search really is tens of thousands of pages at twenty-four to a page.
function bulkPageCount(per, page) {
  return Math.max(page, Math.ceil(bulkTotalCards() / per) || 1);
}

/* =========================================================================
 * CARD DETAILS
 * -------------------------------------------------------------------------
 * The tile shows the tagline in full, which is the one line a site puts under
 * a card in its own grid. Everything else it knows - how many tokens the card
 * runs to, what the author said about it, what it is tagged with, whether a
 * lorebook came with it - arrives in the same listing reply, so the only thing
 * between all of that and the screen is somewhere to put it.
 *
 * Not the tile itself: a row is as tall as its tallest card, so a paragraph
 * added to one tile is empty space added to the five beside it. It is a panel
 * over the grid instead, in the two shapes the two kinds of screen want -
 * pinned beside the tile where there is a pointer to hover with, and a sheet
 * across the bottom of the window where there is not.
 *
 * Nothing here is fetched. A panel that costs a request per tile would be a
 * request per tile someone hovers past, so a site that does not put a fact in
 * its search results simply does not show that line.
 * ========================================================================= */

// How long the pointer has to settle on the badge before the panel opens, and
// how long it has to be gone before it closes. Both are deliberate. A page is
// twenty-four tiles, and a panel that opened the instant a cursor crossed one
// would flash open and shut the whole way down the grid; the closing delay is
// the longer of the two because it covers the travel from badge to panel, and
// notes long enough to scroll are no use if they vanish on the way there.
const NOTES_OPEN_MS = 200;
const NOTES_CLOSE_MS = 260;

const NOTES_GAP = 10;    // from the tile
const NOTES_EDGE = 12;   // from the edge of the window

const notesClamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

const notesPop = {
  card: null,        // the tile the open panel belongs to
  badge: null,       // the button on it, which carries the open/closed state
  sheet: false,      // sheet across the bottom rather than pinned beside a tile
  pinned: false,     // opened by a click, so a wandering pointer cannot close it
  openTimer: 0,
  closeTimer: 0,
};

// A sheet wherever there is no pointer to hover with, and on any window narrow
// enough that a panel beside a tile would be most of it. Asked at each open
// rather than once at startup: a laptop with a touchscreen answers this
// differently from one minute to the next, and a phone turned on its side
// crosses the width test on its own.
const notesWantSheet = () =>
  matchMedia('(hover: none), (pointer: coarse), (max-width: 720px)').matches;

/**
 * What this card has to say for itself beyond its tile, or null when that is
 * nothing and the badge should not be drawn at all.
 *
 * The notes are the part that needs judging rather than copying. Both sites
 * that have the field let it be filled with anything, and what they most often
 * get is the tagline over again - so what counts as notes here is what the tile
 * is not showing already. The rest are facts: the greetings, the art, a size, a
 * tag list, a lorebook or not, each present only where the site's listing said
 * so, and none of them fetched. No site answers all of it - Character Tavern is
 * the one that hands over greetings for free, JanitorAI the one whose art comes
 * with the blurb - so the panel is assembled from what arrived rather than laid
 * out to a fixed shape with gaps in it.
 */
const notesFlat = s => (s || '').replace(/\s+/g, ' ').trim();

function cardDetails(item) {
  const flat = notesFlat(item.notes);
  const notes = flat && !notesFlat(item.tagline).includes(flat) ? item.notes.trim() : '';
  // Trimmed rather than flattened: a greeting is prose with the author's own
  // paragraphs in it, and the panel keeps them the way it keeps the notes'.
  const greetings = Array.isArray(item.greetings)
    ? item.greetings.map(g => (typeof g === 'string' ? g.trim() : '')).filter(Boolean)
    : [];
  const gallery = Array.isArray(item.gallery)
    ? item.gallery.filter(u => typeof u === 'string' && u)
    : [];
  const tags = Array.isArray(item.tags) ? item.tags.map(t => notesFlat(t)).filter(Boolean) : [];
  const tokens = Number(item.tokens) > 0 ? Number(item.tokens) : 0;
  const lorebook = !!item.lorebook;

  return notes || greetings.length || gallery.length || tags.length || tokens || lorebook
    ? { notes, greetings, gallery, tags, tokens, lorebook }
    : null;
}

function openNotes(card, badge, item, details, { pinned = false } = {}) {
  clearTimeout(notesPop.openTimer);
  clearTimeout(notesPop.closeTimer);

  // Moving from one tile to another reuses the one panel, so the badge being
  // left has to be told it is no longer the open one.
  if (notesPop.badge && notesPop.badge !== badge) {
    notesPop.badge.setAttribute('aria-expanded', 'false');
  }

  const wrap = $('card-notes');
  const pop = $('card-notes-pop');
  const by = $('card-notes-by');

  $('card-notes-title').textContent = item.name || 'Card details';
  by.textContent = item.creator ? `by ${item.creator}` : '';
  by.classList.toggle('hidden', !item.creator);

  // Both scrollable pieces back to the top - the panel is reused tile by tile,
  // and a card opened after a long one would otherwise start halfway down
  // somebody else's notes.
  fillNotesDetails(details);
  ['card-notes-scroll', 'card-notes-tags'].forEach(id => { $(id).scrollTop = 0; });

  notesPop.card = card;
  notesPop.badge = badge;
  notesPop.pinned = pinned;
  notesPop.sheet = notesWantSheet();

  wrap.classList.toggle('notes-sheet', notesPop.sheet);
  wrap.classList.toggle('notes-anchored', !notesPop.sheet);
  wrap.classList.remove('hidden');
  badge.setAttribute('aria-expanded', 'true');

  if (notesPop.sheet) {
    // A sheet covers the page and takes every tap that is not on the grid, so
    // it is a modal dialog and says so. The popover is not one - the grid
    // behind it stays live and a click on it is how it gets put away.
    pop.setAttribute('aria-modal', 'true');
    pop.style.left = '';
    pop.style.top = '';
    $('card-notes-close').focus({ preventScroll: true });
  } else {
    pop.removeAttribute('aria-modal');
    placeNotes();
  }
}

/**
 * Writes the six parts, and hides the ones this site did not answer.
 *
 * Hidden rather than shown empty, and never replaced by "unknown": a panel that
 * lists what it does not know is longer, slower to read, and says nothing. A
 * chub card simply has no lorebook line, because chub's search does not say.
 */
function fillNotesDetails({ notes, greetings, gallery, tags, tokens, lorebook }) {
  const tokenLine = $('card-notes-tokens');
  const body = $('card-notes-body');
  const tagList = $('card-notes-tags');
  const lore = $('card-notes-lore');

  tokenLine.textContent = tokens ? `${fmt(tokens)} tokens` : '';
  tokenLine.classList.toggle('hidden', !tokens);

  // textContent rather than markup: this is text somebody typed into a box on
  // another site, and the panel renders it as the text it is. The line breaks
  // in it are kept by the stylesheet.
  body.textContent = notes;
  body.classList.toggle('hidden', !notes);

  fillNotesGreetings(greetings);
  fillNotesGallery(gallery);

  // Rebuilt rather than patched - it is at most a couple of dozen short chips,
  // and the alternative is reconciling two lists on every hover.
  tagList.replaceChildren(...tags.map(tag => {
    const li = document.createElement('li');
    li.textContent = tag;
    return li;
  }));
  tagList.classList.toggle('hidden', !tags.length);

  lore.textContent = lorebook ? 'Includes a lorebook' : '';
  lore.classList.toggle('hidden', !lorebook);
}

/**
 * The card's opening messages, in the author's order.
 *
 * Numbered only when there is more than one. A lone greeting under a heading
 * reading "Greeting 1" implies a second one somewhere that the panel is not
 * showing, which is the opposite of what a details panel is for.
 */
function fillNotesGreetings(greetings) {
  const wrap = $('card-notes-greetings');
  wrap.classList.toggle('hidden', !greetings.length);
  if (!greetings.length) return;

  $('card-notes-greetings-head').textContent =
    greetings.length > 1 ? `Greetings (${greetings.length})` : 'Greeting';

  $('card-notes-greetings-list').replaceChildren(...greetings.flatMap((text, i) => {
    const out = [];
    if (greetings.length > 1) {
      const label = document.createElement('p');
      label.className = 'notes-greeting-n';
      label.textContent = `${i + 1}`;
      out.push(label);
    }
    const p = document.createElement('p');
    p.className = 'notes-greeting';
    p.textContent = text;
    out.push(p);
    return out;
  }));
}

/**
 * The art that came with the listing, as pictures rather than a count.
 *
 * Straight <img> off the platform's own CDN, the way the tiles draw an avatar -
 * these are URLs the search already handed over, so a panel of them costs no
 * request that the grid behind it has not already made. `lazy` matters here:
 * the panel is built on every open, including the hover-opens someone skims
 * past, and a card with two dozen images should not pull them all down for a
 * glance that never reaches the bottom of the column.
 *
 * A dead link removes its own figure. Authors embed art from wherever they
 * like and some of those hosts have since gone, and a broken-image icon in a
 * grid of pictures reads as this tool having failed to load something.
 *
 * Each one opens full size in the same viewer the tiles use. The panel caps
 * them at 260px so a card with a dozen is still a panel rather than a scroll,
 * which makes these thumbnails too - and the file behind one is already the
 * original, so opening it costs nothing beyond what has been downloaded.
 */
function fillNotesGallery(gallery) {
  const wrap = $('card-notes-gallery');
  wrap.classList.toggle('hidden', !gallery.length);
  if (!gallery.length) return;

  $('card-notes-gallery-list').replaceChildren(...gallery.map(url => {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.alt = '';

    // A picture that opens is a control, whatever element it is made of, so it
    // is reachable and operable from a keyboard like the rest of them.
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', 'View this image full size');
    const open = () => openViewer({ full: url, opener: img });
    img.addEventListener('click', open);
    img.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();      // Space would scroll the panel behind it
      open();
    });
    // A picture is the one thing in this panel with no height until it arrives,
    // and a popover is placed from the height it had when it opened. Both ways
    // out of that - the picture landing, or the link turning out to be dead -
    // change how tall the panel is after it has been put somewhere.
    img.addEventListener('load', reflowNotes, { once: true });
    img.addEventListener('error', () => { img.remove(); reflowNotes(); }, { once: true });
    img.src = url;
    return img;
  }));
}

/**
 * Put the popover back where it belongs after its contents changed size.
 *
 * Only the pinned shape needs this - a sheet is fixed to the bottom of the
 * window and does not care how tall it is. Coalesced to a frame because a card
 * with a dozen pictures would otherwise re-measure the panel a dozen times as
 * they land, and each measurement forces a layout.
 */
let notesReflowFrame = 0;
function reflowNotes() {
  if (!notesPop.card || notesPop.sheet || notesReflowFrame) return;
  notesReflowFrame = requestAnimationFrame(() => {
    notesReflowFrame = 0;
    if (notesPop.card && !notesPop.sheet) placeNotes();
  });
}

// Beside the tile, on whichever side has room. Beside rather than over, so the
// picture and the name the notes belong to are still there to read them
// against; centred on the tile only when neither side will take it.
function placeNotes() {
  const pop = $('card-notes-pop');
  const r = notesPop.card.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const vw = innerWidth, vh = innerHeight;

  let left = r.right + NOTES_GAP;
  if (left + w > vw - NOTES_EDGE) left = r.left - NOTES_GAP - w;
  if (left < NOTES_EDGE) left = r.left + r.width / 2 - w / 2;

  pop.style.left = `${Math.round(notesClamp(left, NOTES_EDGE, Math.max(NOTES_EDGE, vw - w - NOTES_EDGE)))}px`;
  pop.style.top = `${Math.round(notesClamp(r.top, NOTES_EDGE, Math.max(NOTES_EDGE, vh - h - NOTES_EDGE)))}px`;
}

// `restoreFocus` is for the ways out the keyboard takes - Escape, the close
// button. A click elsewhere has already decided where focus belongs, and
// dragging it back to a badge would undo that.
function closeNotes({ restoreFocus = false } = {}) {
  clearTimeout(notesPop.openTimer);
  clearTimeout(notesPop.closeTimer);

  const badge = notesPop.badge;
  $('card-notes').classList.add('hidden');

  if (badge) {
    badge.setAttribute('aria-expanded', 'false');
    if (restoreFocus && badge.isConnected) badge.focus();
  }
  notesPop.card = null;
  notesPop.badge = null;
  notesPop.pinned = false;
}

function scheduleNotesClose() {
  // A pointer that left the panel because it went to the full-size picture
  // opened from the panel has not left the panel.
  if (notesPop.pinned || viewerOpen()) return;
  clearTimeout(notesPop.closeTimer);
  notesPop.closeTimer = setTimeout(() => closeNotes(), NOTES_CLOSE_MS);
}

// Did this focus come from the keyboard? A browser too old to know throws on
// the selector rather than answering, and the honest answer there is no: the
// badge is still a button, so Enter and Space open it either way.
function keyboardFocus(el) {
  try { return el.matches(':focus-visible'); } catch { return false; }
}

// Event targets are not all elements - a scroll can be reported against the
// document itself - and one thrown TypeError in a listener would leave a panel
// that no longer closes.
const within = (target, selector) => !!target?.closest?.(selector);

function attachNotes(badge, card, item, details) {
  const isOpen = () => notesPop.badge === badge;

  badge.addEventListener('click', e => {
    // The whole tile is a checkbox. This button is the one part of it that is
    // not, so the click stops here instead of ticking the card behind it.
    e.stopPropagation();
    if (isOpen()) closeNotes();
    else openNotes(card, badge, item, details, { pinned: true });
  });

  // Hovering is an offer on top of that button, never the only way in - which
  // is why everything below is skipped for anything that is not a mouse. A
  // touch screen has no way to stop hovering: the tap that opened a panel would
  // leave a hover behind on the badge it landed on.
  badge.addEventListener('pointerenter', e => {
    if (e.pointerType !== 'mouse' || isOpen()) return;
    clearTimeout(notesPop.closeTimer);
    clearTimeout(notesPop.openTimer);
    notesPop.openTimer = setTimeout(() => openNotes(card, badge, item, details), NOTES_OPEN_MS);
  });

  badge.addEventListener('pointerleave', e => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(notesPop.openTimer);
    if (isOpen()) scheduleNotesClose();
  });

  // Tab reaches the badge, and a keyboard has no hover to offer, so arriving is
  // the whole gesture. Only for a focus the browser itself judges to be a
  // keyboard's - a click focuses the button too, and the handler above is
  // already deciding what that means.
  badge.addEventListener('focus', () => {
    if (!isOpen() && keyboardFocus(badge)) openNotes(card, badge, item, details, { pinned: true });
  });
}

/* ---------------- the panel's own wiring, done once ---------------- */

// The pointer moving off a badge and onto the panel is arriving, not leaving.
$('card-notes-pop').addEventListener('pointerenter', () => clearTimeout(notesPop.closeTimer));
$('card-notes-pop').addEventListener('pointerleave', e => {
  if (e.pointerType === 'mouse') scheduleNotesClose();
});

$('card-notes-close').addEventListener('click', () => closeNotes({ restoreFocus: true }));
$('card-notes-scrim').addEventListener('click', () => closeNotes());

// On pointerdown rather than click, so the panel is out of the way before
// whatever was pressed underneath it acts.
//
// The full-size viewer is the exception to all three rules below, and for the
// same reason each time: it is opened from the gallery inside this panel and
// sits on top of it, so a press on it, focus moving into it, or an Escape meant
// for it must not take away the panel it will be dropped back onto.
document.addEventListener('pointerdown', e => {
  if (!notesPop.badge || viewerOpen()) return;
  if (within(e.target, '#card-notes-pop') || within(e.target, '.bulk-card-info')) return;
  closeNotes();
});

// The same rule for the keyboard: focus landing anywhere but the badge and its
// panel means this is over.
document.addEventListener('focusin', e => {
  if (!notesPop.badge || viewerOpen()) return;
  if (e.target === notesPop.badge || within(e.target, '#card-notes-pop')) return;
  closeNotes();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && notesPop.badge && !viewerOpen()) closeNotes({ restoreFocus: true });
});

// A pinned panel travels with its tile rather than hanging in the air where the
// tile used to be, and gives up once the tile has left the window entirely.
// Capture phase, because a scroll inside the notes themselves does not bubble -
// and it is skipped, since scrolling the text moves nothing on the page.
let notesFrame = 0;
addEventListener('scroll', e => {
  if (!notesPop.card || notesPop.sheet || notesFrame) return;
  if (within(e.target, '#card-notes-pop')) return;

  notesFrame = requestAnimationFrame(() => {
    notesFrame = 0;
    if (!notesPop.card || notesPop.sheet) return;
    const r = notesPop.card.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) closeNotes();
    else placeNotes();
  });
}, true);

// A resize re-cuts the whole grid a moment later anyway, and can turn a
// popover's screen into a sheet's. Nothing is worth re-anchoring through that.
addEventListener('resize', () => {
  if (notesPop.card && !notesPop.sheet) closeNotes();
});

/* =========================================================================
 * FULL-SIZE IMAGE
 * -------------------------------------------------------------------------
 * A tile is 178px wide and the file behind it is sized to match: Character
 * Tavern's grid URL asks the CDN for 400px at quality 80, and chub publishes a
 * small avatar beside the original. Both are the right thing to draw two dozen
 * of at once and the wrong thing to look at when the question is what a card
 * actually looks like - which is what the corner button on each tile is for.
 *
 * The full file is a megabyte or more, so it is fetched per open and dropped on
 * close: nothing about this costs anything until somebody asks to see one.
 *
 * Two phases, because that download is long enough to notice. The tile's own
 * thumbnail is already decoded in the browser's cache, so it goes up blurred on
 * the frame the button was pressed and the original replaces it when it lands.
 * The alternative - an empty dimmed screen for a second and a half - is the
 * same wait with nothing to look at, and reads as a control that did not work.
 *
 * Blurred rather than merely upscaled because the stand-in is not always the
 * same picture: Character Tavern's thumbnail is an honest 400px resize, but
 * chub's is a 200px square crop of a portrait image, so the shape settles when
 * the original arrives. Out of focus that reads as the picture resolving; sharp
 * it would read as the popup jumping.
 * ========================================================================= */

// Four corner brackets. Drawn rather than typed: the obvious character for this
// (U+26F6) is missing from most of the fonts this page will actually be shown
// in, and a control whose glyph might come out as a box cannot be a control.
const ZOOM_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M6 1.6H1.6V6M10 1.6h4.4V6M6 14.4H1.6V10M10 14.4h4.4V10" fill="none" ' +
  'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const viewerState = {
  opener: null,   // the control it was opened from, for where focus goes back to
  run: 0,         // bumped per open and per close, so a full-size file that
                  // lands after the viewer moved on cannot paint over whatever
                  // is on screen by then
};

function viewerOpen() { return !$('image-viewer').classList.contains('hidden'); }

/**
 * Show one picture over a dimmed page.
 *
 * `full` is the file worth looking at and `thumb` the copy the page already
 * has; passing the same URL for both - or leaving `thumb` out - is the case
 * where the site only ever served one size, and skips straight to it.
 */
function openViewer({ full, thumb = '', name = '', opener = null }) {
  const src = full || thumb;
  if (!src) return;

  const img = $('viewer-img');
  const wait = $('viewer-wait');
  const run = ++viewerState.run;
  viewerState.opener = opener;

  // Nothing to stand in with when the two are the same file - the gallery in
  // the details panel, and JanitorAI's tiles. That URL is one the page has
  // already drawn with, so it is normally cached and arrives on the same frame.
  const preview = !!thumb && thumb !== src;

  img.classList.toggle('is-thumb', preview);
  img.src = preview ? thumb : src;

  wait.textContent = 'Loading full image…';
  // The note is up whenever something is still on its way. With a thumbnail
  // underneath that is until the original lands; without one - where the frame
  // is empty rather than soft - it is until this picture itself does, which
  // matters more, because an empty dimmed screen with nothing on it is what a
  // control that did not work looks like.
  wait.classList.toggle('hidden', !preview && img.complete);

  $('viewer-name').textContent = name;
  $('viewer-original').href = src;

  $('image-viewer').classList.remove('hidden');
  $('viewer-close').focus({ preventScroll: true });

  if (!preview) {
    img.addEventListener('load', () => {
      if (run === viewerState.run) wait.classList.add('hidden');
    }, { once: true });
    // Nothing to fall back to here, so the frame would stay empty. Say why.
    img.addEventListener('error', () => {
      if (run !== viewerState.run) return;
      wait.textContent = 'That image could not be loaded.';
      wait.classList.remove('hidden');
    }, { once: true });
    return;
  }

  // Loaded off-DOM and swapped in once it is decoded. Assigning the new URL to
  // the visible element instead would clear it the moment it was set, putting
  // an empty frame where the thumbnail had been for the whole download.
  const original = new Image();
  original.referrerPolicy = 'no-referrer';
  original.addEventListener('load', () => {
    if (run !== viewerState.run) return;
    img.classList.remove('is-thumb');
    img.src = src;
    wait.classList.add('hidden');
  }, { once: true });
  // A dead link leaves the thumbnail up rather than emptying the frame. It is
  // the same picture at a lower resolution, which is the better of the two
  // answers to "the original is no longer where the listing says it is".
  original.addEventListener('error', () => {
    if (run !== viewerState.run) return;
    wait.classList.add('hidden');
  }, { once: true });
  original.src = src;
}

function closeViewer() {
  if (!viewerOpen()) return;

  // Focus goes back BEFORE the overlay is hidden, and the order is not a
  // preference. Hiding the element that currently holds focus - the close
  // button, every time this is reached by keyboard - makes the browser reset
  // focus to the body, and it does that at the next style flush: after any
  // focus() call made in the same breath, which it then quietly undoes. Moving
  // focus first means there is nothing for it to reset.
  const opener = viewerState.opener;
  viewerState.opener = null;
  if (opener?.isConnected) opener.focus({ preventScroll: true });

  viewerState.run++;                       // whatever is still downloading is no longer wanted
  $('image-viewer').classList.add('hidden');
  // Dropped rather than left behind: a page of tiles opened one after another
  // would otherwise hold every full-size picture it had shown for the rest of
  // the session.
  $('viewer-img').removeAttribute('src');
  $('viewer-img').classList.remove('is-thumb');
  $('viewer-wait').classList.add('hidden');
}

$('viewer-close').addEventListener('click', closeViewer);

// Everywhere else is a way out - the dimmed page, and the margins either side
// of the picture. Only the picture itself and the link under it keep a click,
// so that reaching for "Open original" cannot close the thing it belongs to.
$('image-viewer').addEventListener('click', e => {
  if (e.target.closest('#viewer-img, #viewer-original, #viewer-close')) return;
  closeViewer();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && viewerOpen()) {
    // Stops here rather than falling through to the notes panel underneath:
    // one press should put away one thing, and the gallery this was opened
    // from is inside that panel.
    e.preventDefault();
    closeViewer();
  }
});

function renderBulkGrid() {
  const grid = $('bulk-grid');
  const b = state.bulk;

  // Every tile is about to be replaced, including whichever one an open panel
  // is pinned to.
  closeNotes();

  // The window on screen is cut from the feed every time, so a grid that has
  // been re-columned by a resize is re-cut to match it.
  const per = tilesPerPage();
  b.items = b.feed.slice(b.offset, b.offset + per);

  grid.innerHTML = '';
  renderBulkHint();
  updateJaiInfo();

  if (!b.items.length) {
    showToolbars(false);
    return;
  }
  showToolbars(true);

  // Page numbers are left ungrouped on purpose. They are labels rather than
  // quantities, and half the world groups thousands with a dot - where it does,
  // "Page 1 / 1.520" reads as a decimal rather than as page 1 of 1520. The card
  // count in the status line is a real quantity, and is grouped.
  const page = Math.floor(b.offset / per) + 1;
  setText('.js-bulk-page', `Page ${page} / ${bulkPageCount(per, page)}`);
  setDisabled('.js-bulk-prev', b.offset === 0);
  setDisabled('.js-bulk-next',
    b.offset + per >= b.feed.length && b.sourcePage >= b.sourcePages);

  state.bulk.items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'bulk-card' + (state.bulk.selected.has(item.key) ? ' selected' : '');

    const img = item.avatarUrl
      ? `<img src="${item.avatarUrl}" alt="" loading="lazy" referrerpolicy="no-referrer"
              onerror="this.parentNode.innerHTML='<div class=\\'noimg\\'>no image</div>'" />`
      : `<div class="noimg">no image</div>`;

    // The corner that opens the picture at full size. Inside the figure rather
    // than beside it, so that the onerror above - which replaces everything in
    // the figure - takes this away along with the picture it belonged to: a
    // button offering a closer look at an image that would not load is worse
    // than no button.
    const zoom = item.avatarUrl
      ? `<button type="button" class="bulk-card-zoom" title="View full image"
                 aria-label="View the full image of ${escapeAttr(item.name)}">${ZOOM_ICON}</button>`
      : '';

    // Only on the tiles that have something to show. Which is most of them on
    // chub and Character Tavern, since both quote a token count for every card
    // - but a JanitorAI grid, whose listing says none of this, stays as bare as
    // it was rather than growing two dozen badges that open an empty panel.
    const details = cardDetails(item);
    const badge = details
      ? `<button type="button" class="bulk-card-info" title="Card details"
                 aria-label="Details for ${escapeAttr(item.name)}"
                 aria-haspopup="dialog" aria-expanded="false">i</button>`
      : '';

    card.innerHTML = `
      <input type="checkbox" class="bulk-check" ${state.bulk.selected.has(item.key) ? 'checked' : ''} />
      ${badge}
      <figure>${img}${zoom}</figure>
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

    const info = card.querySelector('.bulk-card-info');
    if (info) attachNotes(info, card, item, details);

    const zoomBtn = card.querySelector('.bulk-card-zoom');
    zoomBtn?.addEventListener('click', e => {
      // The whole tile is a checkbox. This corner of it is not, so the click
      // stops here instead of ticking the card behind it.
      e.stopPropagation();
      openViewer({
        // Not every site has a second, larger copy - JanitorAI serves one file
        // - and where there is none the tile's own URL is already the original.
        full: item.fullAvatarUrl || item.avatarUrl,
        thumb: item.avatarUrl,
        name: item.name,
        opener: zoomBtn,
      });
    });

    grid.appendChild(card);
  });

  updateBulkCount();
}

function updateBulkCount() {
  setText('.js-bulk-count', `${fmt(state.bulk.selected.size)} selected`);
  setDisabled('.js-bulk-convert', state.bulk.selected.size === 0);
}

onAll('.js-bulk-select-all', 'click', () => {
  state.bulk.items.forEach(i => state.bulk.selected.add(i.key));
  renderBulkGrid();
});
onAll('.js-bulk-select-none', 'click', () => {
  state.bulk.selected.clear();
  renderBulkGrid();
});

$('bulk-cancel').addEventListener('click', () => { state.cancelBulk = true; });

onAll('.js-bulk-convert', 'click', async () => {
  const chosen = state.bulk.items.filter(i => state.bulk.selected.has(i.key));
  if (!chosen.length) return;

  const status = $('bulk-status');
  const progress = $('bulk-progress');
  const fill = $('bulk-progress-fill');
  const text = $('bulk-progress-text');

  state.cancelBulk = false;
  progress.classList.remove('hidden');

  // Both copies of the button, and the ring on both: the toolbars are a grid
  // apart and either one may be the one in view.
  setBusyAll('.js-bulk-convert', true);

  // The bar below fills a card at a time, so it can sit at the same width for
  // several seconds on a slow card - and at 0% for the whole of the first one,
  // which is exactly when someone is deciding whether the click registered.
  text.textContent = `0 / ${chosen.length} - starting...`;
  fill.style.width = '0%';

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
      // Every tile in the grid came from one mirrored library, so the platform
      // is the grid's rather than something to work out per card.
      const adapter = state.bulk.adapter;
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
  setBusyAll('.js-bulk-convert', false);
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
// person looking at an unchanged grid, with the only sign of success a line of
// text below it saying "see below". So the page goes there itself.
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
    $('import-all').disabled = true;
    $('download-all').disabled = true;
    $('clear-all').disabled = true;
    return;
  }
  empty.classList.add('hidden');
  $('import-all').disabled = false;
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
        <button class="btn btn-small btn-import" data-act="import">Import</button>
        <button class="btn btn-small" data-act="download">Download</button>
        <button class="btn btn-small btn-danger" data-act="delete">Delete</button>
      </div>`;

    const importBtn = row.querySelector('[data-act="import"]');
    importBtn.addEventListener('click', () => {
      importToCcc(importBtn, async () => {
        const full = await getCard(r.id);
        return full ? [full.character] : [];
      }, () => `"${r.name}"`);
    });

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
  const show = !state.tokens.janitorai &&
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

// Re-read one at a time rather than getAll: a large collection with galleries
// would otherwise be fully resident before anything is done with it.
async function loadAllCharacters() {
  const rows = await listCardsLight();
  const characters = [];
  for (const r of rows) {
    const full = await getCard(r.id);
    if (full?.character) characters.push(full.character);
  }
  return characters;
}

// Nothing is awaited before importToCcc: it has to reach `connect()` while the
// click is still on the stack or the app tab gets blocked as a popup. The empty
// case is handled by `load` returning nothing rather than by counting first.
$('import-all').addEventListener('click', async () => {
  const ok = await importToCcc(
    $('import-all'),
    loadAllCharacters,
    added => `${added} card${added > 1 ? 's' : ''}`
  );

  // Only on the "all" button, and only once it worked. This is the end of the
  // run - there is nothing left here to do, and the point of the whole feature
  // is to be back in the app with the cards in it. A single Import deliberately
  // does not do this: that one is usually the first of several, and yanking the
  // tab away between each would make importing five cards a fight.
  if (ok) focusApp();
});

$('download-all').addEventListener('click', async () => {
  const characters = await loadAllCharacters();
  if (!characters.length) return;

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

  // Before loadDiscover, and after the tokens it reads for its note: the panel
  // has to be describing the search that the opening grid is about to run.
  initSearchPanel();

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
