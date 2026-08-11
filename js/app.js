/* =========================================================================
 * APP - wiring, UI state and the conversion pipelines
 * ========================================================================= */

import { ADAPTERS, adapterForUrl } from './adapters.js';
import { toCccCharacter, toCccBackup } from './convert.js';
import { blobToWebpDataUrl } from './media.js';
import {
  checkProxy, setProxyEnabled, getProxyKind, needsProxy, isProxyBlocked, BLOCKED_MESSAGE,
} from './transport.js';
import {
  saveCard, getCard, deleteCard, clearCards, countCards,
  listCardsLight, getSetting, setSetting,
} from './db.js';

const $ = id => document.getElementById(id);

const state = {
  tokens: {},          // adapterId -> token
  useProxy: true,
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

  $('proxy-status').className = `pill ${spec.cls}`;
  $('proxy-status-text').textContent = label;

  const detail = $('proxy-detail');
  if (detail) detail.textContent = detailText;
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

function buildTokenFields() {
  const wrap = $('token-fields');
  wrap.innerHTML = '';
  ADAPTERS.forEach(a => {
    const div = document.createElement('div');
    div.className = 'token-field';
    div.innerHTML = `
      <label for="token-${a.id}">${a.label} <span class="chip">optional</span></label>
      <p class="hint">${a.tokenHint}</p>
      <input type="password" id="token-${a.id}" placeholder="Paste token" autocomplete="off" spellcheck="false" />`;
    wrap.appendChild(div);
    div.querySelector('input').value = state.tokens[a.id] || '';
  });
}

$('settings-btn').addEventListener('click', () => {
  buildTokenFields();
  $('use-proxy').checked = state.useProxy;
  refreshProxyStatus();
  $('settings-modal').classList.remove('hidden');
});

$('settings-close').addEventListener('click', () => $('settings-modal').classList.add('hidden'));

$('settings-save').addEventListener('click', async () => {
  ADAPTERS.forEach(a => {
    const input = $(`token-${a.id}`);
    if (input) state.tokens[a.id] = input.value.trim();
  });
  state.useProxy = $('use-proxy').checked;
  setProxyEnabled(state.useProxy);
  await setSetting('tokens', state.tokens);
  await setSetting('useProxy', state.useProxy);
  $('settings-modal').classList.add('hidden');
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

    const extras = [];
    if (character.gallery.length) extras.push(`${character.gallery.length} gallery image(s)`);
    if (character.scenarios.length) extras.push(`${character.scenarios.length} greeting(s)`);
    if (character.loreEntries.length) extras.push(`${character.loreEntries.length} lore entries`);

    setStatus(status,
      `Converted "${character.name}"${extras.length ? ' - ' + extras.join(', ') : ''}. See below.`,
      'ok');
    $('url-input').value = '';
  } catch (err) {
    setStatus(status, err.message || String(err), 'error');
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
    setStatus(status, err.message || String(err), 'error');
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

  const notes = [];
  if (searches.length) notes.push(`${searches.length} search link(s) skipped - paste those one at a time`);
  if (bad.length) notes.push(`${bad.length} unsupported and skipped`);

  setStatus(status,
    `${items.length} card link(s) loaded and selected.${notes.length ? ' ' + notes.join('; ') + '.' : ''}`,
    notes.length ? 'error' : 'ok');
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
    : `Currently showing this URL: <a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;

  // A page of search results is a shelf, not an order - nothing below it is
  // converted until it is picked. Pasted links arrive already ticked, so the
  // step being asked for is the opposite one.
  hint.classList.remove('hidden');
  hint.innerHTML = urlList
    ? 'All selected &rarr; untick any you don\'t want &rarr; click "Convert selected"'
    : 'Select the characters you want &rarr; click "Convert selected" to convert and download them';
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

  let done = 0, failed = 0;
  const failures = [];

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
      done++;
    } catch (err) {
      failed++;
      failures.push(`${item.name}: ${err.message || err}`);
    }

    // Courtesy gap so a 50-card run does not arrive as one burst.
    await new Promise(r => setTimeout(r, 250));
  }

  fill.style.width = '100%';
  progress.classList.add('hidden');
  $('bulk-convert').disabled = false;
  await renderResults();

  const cancelled = state.cancelBulk ? ' (cancelled early)' : '';
  setStatus(status,
    `Converted ${done} card(s)${failed ? `, ${failed} failed` : ''}${cancelled}.` +
    (failures.length ? `\n\nFailures:\n- ${failures.slice(0, 12).join('\n- ')}` : ''),
    failed ? 'error' : 'ok');
});

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
  state.useProxy = (await getSetting('useProxy', true)) !== false;
  setProxyEnabled(state.useProxy);
  await renderResults();

  // Not awaited: the suggestions go direct to chub and have nothing to do with
  // the proxy, so neither should wait on the other. The proxy check in
  // particular can sit for a minute against a sleeping service.
  loadDiscover();
  await refreshProxyStatus();
})();
