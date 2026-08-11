/* =========================================================================
 * APP - wiring, UI state and the conversion pipelines
 * ========================================================================= */

import { ADAPTERS, adapterForUrl } from './adapters.js';
import { toCccCharacter, toCccBackup, normalizeSpecCard } from './convert.js';
import { extractCardFromPng, blobToWebpDataUrl } from './media.js';
import { checkProxy, setProxyEnabled, getProxyKind, needsProxy } from './transport.js';
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

/* ---------------- tabs ---------------- */

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`panel-${tab.dataset.tab}`).classList.add('active');
  });
});

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
    hosted: ['Proxy unreachable', 'The cloud proxy did not answer - most often an ad blocker or privacy ' +
      'extension blocking it, so allow this site if the console shows ERR_BLOCKED_BY_CLIENT. Everything ' +
      'else works either way; only mirroring a Character Tavern library needs it. Click the pill to retry.'],
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

/* ---------------- single card ---------------- */

$('single-go').addEventListener('click', convertSingle);
$('single-url').addEventListener('keydown', e => { if (e.key === 'Enter') convertSingle(); });

async function convertSingle() {
  const status = $('single-status');
  const raw = $('single-url').value.trim();
  if (!raw) return setStatus(status, 'Paste a card URL first.', 'error');

  const btn = $('single-go');
  btn.disabled = true;
  try {
    const { adapter } = adapterForUrl(raw);
    setStatus(status, `Fetching from ${adapter.label}...`, 'busy');

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
    $('single-url').value = '';
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

$('bulk-go').addEventListener('click', () => startMirror(pageFromUrl($('bulk-url').value)));
$('bulk-url').addEventListener('keydown', e => {
  if (e.key === 'Enter') startMirror(pageFromUrl($('bulk-url').value));
});
$('bulk-prev').addEventListener('click', () => startMirror(Math.max(1, state.bulk.page - 1)));
$('bulk-next').addEventListener('click', () => startMirror(state.bulk.page + 1));

async function startMirror(page) {
  const status = $('bulk-status');
  const raw = $('bulk-url').value.trim();
  if (!raw) return setStatus(status, 'Paste a library URL first.', 'error');

  try {
    const { adapter } = adapterForUrl(raw);

    // Say so up front when the wait is going to be a cold start rather than a
    // slow site, otherwise a minute of nothing reads as a hang.
    const coldStart = needsProxy(raw) && getProxyKind() === 'hosted';
    setStatus(
      status,
      coldStart
        ? `Mirroring page ${page} of ${adapter.label}... (waking the cloud proxy, this can take up to a minute the first time)`
        : `Mirroring page ${page} of ${adapter.label}...`,
      'busy'
    );
    $('bulk-go').disabled = true;

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
    $('bulk-go').disabled = false;
  }
}

// The pasted-URL path reuses the same grid, so a mixed list of platforms can
// be reviewed and ticked exactly like a mirrored library page.
$('bulk-urllist-go').addEventListener('click', () => {
  const status = $('bulk-status');
  const lines = $('bulk-urllist').value.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return setStatus(status, 'Paste at least one card URL.', 'error');

  const items = [];
  const bad = [];
  lines.forEach(line => {
    try {
      const { adapter } = adapterForUrl(line);
      items.push({
        key: line,
        name: decodeURIComponent(line.split('/').filter(Boolean).pop() || line).replace(/[-_]+/g, ' '),
        tagline: adapter.label,
        avatarUrl: '',
        cardUrl: line,
        creator: '',
      });
    } catch {
      bad.push(line);
    }
  });

  state.bulk = {
    adapter: null, url: '', page: 1, totalPages: 1,
    items, selected: new Set(items.map(i => i.key)), urlList: true,
  };
  renderBulkGrid();
  setStatus(status,
    `${items.length} URL(s) loaded and selected.${bad.length ? ` ${bad.length} unsupported and skipped.` : ''}`,
    bad.length ? 'error' : 'ok');
});

function renderBulkGrid() {
  const grid = $('bulk-grid');
  const toolbar = $('bulk-toolbar');
  grid.innerHTML = '';

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

/* ---------------- manual import ---------------- */

$('manual-file').addEventListener('change', async e => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;

  const status = $('manual-status');
  let ok = 0;
  const errors = [];

  for (const file of files) {
    try {
      setStatus(status, `Reading ${file.name}...`, 'busy');
      let raw = null;
      let avatar = '';

      if (file.type === 'image/png' || /\.png$/i.test(file.name)) {
        raw = extractCardFromPng(await file.arrayBuffer());
        if (!raw) throw new Error('no character data embedded in this PNG');
        avatar = await blobToWebpDataUrl(file);
      } else {
        raw = JSON.parse(await file.text());
      }

      const card = normalizeSpecCard(raw);
      card.avatar = avatar;
      card.sourcePlatform = 'File';
      const character = toCccCharacter(card);
      await storeCharacter(character, { platform: 'File', sourceUrl: file.name });
      ok++;
    } catch (err) {
      errors.push(`${file.name}: ${err.message || err}`);
    }
  }

  await renderResults();
  setStatus(status,
    `Imported ${ok} file(s).` + (errors.length ? `\nFailed:\n- ${errors.join('\n- ')}` : ''),
    errors.length ? 'error' : 'ok');
});

$('manual-json-go').addEventListener('click', async () => {
  const status = $('manual-status');
  const text = $('manual-json').value.trim();
  if (!text) return setStatus(status, 'Paste some card JSON first.', 'error');

  try {
    const card = normalizeSpecCard(JSON.parse(text));
    card.sourcePlatform = 'Pasted JSON';
    const character = toCccCharacter(card);
    await storeCharacter(character, { platform: 'Pasted JSON', sourceUrl: '' });
    await renderResults();
    setStatus(status, `Converted "${character.name}".`, 'ok');
    $('manual-json').value = '';
  } catch (err) {
    setStatus(status, `Could not read that JSON: ${err.message || err}`, 'error');
  }
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
  await refreshProxyStatus();
})();
