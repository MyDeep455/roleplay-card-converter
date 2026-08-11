/* =========================================================================
 * ADAPTERS - chub.ai and Character Tavern
 * =========================================================================
 * Each adapter exposes:
 *
 *   matchUrl(url)               does this adapter own the URL?
 *   isLibraryUrl(url)           library/search page rather than a single card?
 *   fetchCard(url, ctx)         one card  -> NormalizedCard
 *   listLibrary(url, page, ctx) a library page -> { items, page, totalPages }
 *
 * A library `item` carries only what the mirror needs to draw a tile and fetch
 * the card later: name, tagline, avatar URL, creator. Star counts, download
 * totals, chat/message counts, ratings and comments are read past and dropped -
 * they are not part of a character card and never reach the output.
 * ========================================================================= */

import { getJson, getBlob, httpGet } from './transport.js';
import { blobToWebpDataUrl, blobToGalleryDataUrl, extractCardFromPng } from './media.js';
import { normalizeSpecCard } from './convert.js';

const clean = s => (typeof s === 'string' ? s.trim() : '');

async function imageToDataUrl(url, { gallery = false } = {}) {
  if (!url) return '';
  try {
    const blob = await getBlob(url);
    if (!blob || !blob.type.startsWith('image/')) return '';
    return gallery ? await blobToGalleryDataUrl(blob) : await blobToWebpDataUrl(blob);
  } catch {
    return '';   // a missing picture must never sink an otherwise good card
  }
}

/* =========================================================================
 * CHUB.AI
 * -------------------------------------------------------------------------
 * Public API, no token needed, Access-Control-Allow-Origin: * throughout, so
 * every call here goes direct from the browser.
 *   card    GET api.chub.ai/api/characters/{author}/{slug}?full=true
 *   search  GET api.chub.ai/search?search=&first=N&page=P
 *   gallery GET api.chub.ai/api/gallery/project/{numericId}
 * ========================================================================= */
const chub = {
  id: 'chub',
  label: 'Chub.ai',
  hosts: ['chub.ai', 'www.chub.ai', 'characterhub.org', 'www.characterhub.org', 'chub.chat'],
  tokenHint: 'Optional - only needed to reach your own private cards. On chub.ai: DevTools > Application > Local Storage > CH-API-KEY.',

  matchUrl(u) { return this.hosts.includes(u.hostname.toLowerCase()); },

  // /characters/author/slug  ->  author/slug
  fullPathFrom(u) {
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.findIndex(p => ['characters', 'character', 'lorebooks'].includes(p));
    const rest = i >= 0 ? parts.slice(i + 1) : parts;
    return rest.slice(0, 2).join('/');
  },

  isLibraryUrl(u) {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return true;                       // chub.ai/
    if (parts[0] === 'search') return true;                    // chub.ai/search?...
    return parts[0] === 'characters' && parts.length < 3;      // chub.ai/characters?...
  },

  async fetchCard(url, ctx = {}) {
    const u = new URL(url);
    const fullPath = this.fullPathFrom(u);
    if (!fullPath || !fullPath.includes('/')) {
      throw new Error('That does not look like a Chub character URL (expected chub.ai/characters/author/name).');
    }

    const payload = await getJson(
      `https://api.chub.ai/api/characters/${encodeURI(fullPath)}?full=true`,
      { token: ctx.token || null }
    );
    const node = payload.node || payload;
    const def = node.definition || {};

    ctx.progress?.('Fetching avatar');
    const avatar = await imageToDataUrl(node.max_res_url || node.avatar_url);

    let gallery = [];
    if (node.hasGallery && node.id) {
      ctx.progress?.('Fetching gallery');
      gallery = await this.fetchGallery(node.id, ctx);
    }

    return {
      name: clean(def.name || node.name),
      tagline: clean(node.tagline),
      description: clean(def.description),
      personality: clean(def.personality || def.tavern_personality),
      scenario: clean(def.scenario),
      first_mes: clean(def.first_message),
      mes_example: clean(def.example_dialogs),
      alternate_greetings: Array.isArray(def.alternate_greetings) ? def.alternate_greetings : [],
      system_prompt: clean(def.system_prompt),
      post_history_instructions: clean(def.post_history_instructions),
      tags: Array.isArray(node.topics) ? node.topics : [],
      character_book: def.embedded_lorebook || null,
      avatar,
      gallery,
      creator: clean((node.fullPath || '').split('/')[0]),
      sourceUrl: url,
      sourcePlatform: 'Chub.ai',
    };
  },

  async fetchGallery(projectId, ctx = {}) {
    try {
      const res = await getJson(`https://api.chub.ai/api/gallery/project/${projectId}`);
      const nodes = res.nodes || res.data?.nodes || [];
      const urls = nodes
        .map(n => n.primary_image_path || n.image_path || n.url || n.image || n.src)
        .filter(Boolean)
        .slice(0, 24);                     // a sane ceiling for one card

      const out = [];
      for (let i = 0; i < urls.length; i++) {
        ctx.progress?.(`Gallery image ${i + 1}/${urls.length}`);
        const d = await imageToDataUrl(urls[i], { gallery: true });
        if (d) out.push(d);
      }
      return out;
    } catch {
      return [];   // galleries are a bonus, never a reason to lose the card
    }
  },

  // Every filter on the library page is carried in the URL, so the whole query
  // string is forwarded rather than a hand-picked few - anything not copied
  // across is a filter silently ignored. Unknown params are harmless here (the
  // API returns 200 and skips them); only invalid *values* for known params
  // are rejected, and a pasted chub URL carries chub's own valid values.
  //
  // `sort` is the one parameter the API is strict about: an unknown value gets
  // a 400 rather than being ignored. Helpfully, that error lists the accepted
  // ones, which is exactly where this set came from.
  SORTS: new Set([
    'download_count', 'id', 'rating', 'rating_count', 'last_activity_at',
    'trending_downloads', 'n_favorites', 'created_at', 'star_count', 'msgs_chat',
    'msgs_user', 'chats_user', 'name', 'timeline', 'n_tokens', 'random',
    'trending', 'newcomer', 'favorite_time', 'ai_rating', 'public_chats', 'default',
  ]),

  async listLibrary(url, page, ctx = {}) {
    const src = new URL(url).searchParams;
    const q = new URLSearchParams(src);

    // Accept the names a person might type by hand for the search box.
    if (!q.get('search')) {
      const alias = src.get('q') || src.get('query');
      if (alias) q.set('search', alias);
    }
    q.delete('q');
    q.delete('query');

    // chub calls tags "topics"; accept either spelling.
    if (q.get('tags') && !q.get('topics')) q.set('topics', q.get('tags'));
    q.delete('tags');

    const pageSize = Number(q.get('first')) || 24;
    q.set('first', String(pageSize));
    q.set('page', String(page));
    q.set('venus', 'true');
    // Defaults only when the URL is silent - never override a chosen filter.
    if (!q.get('nsfw')) q.set('nsfw', 'true');

    // The site writes its homepage orderings as `segment=` - "Newcomer",
    // "Trending" and friends - but the API only knows `sort=` and drops
    // `segment` on the floor. Forwarded verbatim it therefore did nothing, and
    // the default below then overwrote the order the person actually picked.
    // The two vocabularies use the same words, so a segment naming a real sort
    // simply becomes one.
    const chosen = [q.get('sort'), q.get('segment')].find(v => v && this.SORTS.has(v));

    // Anything left over is a value this API would 400 on, so fall back rather
    // than fail the whole mirror over an ordering.
    q.set('sort', chosen || 'star_count');
    q.delete('segment');

    const res = await getJson(`https://api.chub.ai/search?${q}`, { token: ctx.token || null });
    const nodes = res.data?.nodes || res.nodes || [];
    const count = res.data?.count ?? res.count ?? nodes.length;

    return {
      items: nodes.map(n => ({
        key: n.fullPath,
        name: n.name || n.fullPath,
        tagline: clean(n.tagline),
        avatarUrl: n.avatar_url || n.max_res_url || '',
        cardUrl: `https://chub.ai/characters/${n.fullPath}`,
        creator: (n.fullPath || '').split('/')[0],
      })),
      page,
      totalPages: Math.max(1, Math.ceil(count / pageSize)),
    };
  },
};

/* =========================================================================
 * CHARACTER TAVERN
 * -------------------------------------------------------------------------
 * Two hosts, two different CORS stories:
 *
 *   ct-cards.storage.character-tavern.com  sends ACAO: * and serves the card
 *     as a PNG with a full chara_card_v3 (lorebook and all) embedded. Single
 *     cards therefore work direct, exactly like chub.
 *
 *   character-tavern.com/api/search/cards  sends no CORS header and rejects
 *     preflight, so library mirroring goes through the local proxy. It returns
 *     the whole card definition inline, which makes mirroring cheap.
 * ========================================================================= */
const characterTavern = {
  id: 'character-tavern',
  label: 'Character Tavern',
  hosts: ['character-tavern.com', 'www.character-tavern.com'],
  tokenHint: 'Not needed.',

  CARD_CDN: 'https://ct-cards.storage.character-tavern.com',

  matchUrl(u) { return this.hosts.includes(u.hostname.toLowerCase()); },

  pathFrom(u) {
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.indexOf('character');
    if (i >= 0 && parts.length >= i + 3) return `${parts[i + 1]}/${parts[i + 2]}`;
    const c = parts.indexOf('chat');
    if (c >= 0 && parts.length >= c + 3) return `${parts[c + 1]}/${parts[c + 2]}`;
    return '';
  },

  isLibraryUrl(u) {
    const p = u.pathname;
    return p === '/' || p.startsWith('/search') || p.startsWith('/browse') || p.startsWith('/tags');
  },

  avatarUrlFor(path) { return `${this.CARD_CDN}/${path}.png`; },

  async fetchCard(url, ctx = {}) {
    const path = this.pathFrom(new URL(url));
    if (!path) throw new Error('Expected a URL like character-tavern.com/character/author/name.');
    return this.fetchCardByPath(path, url, ctx);
  },

  async fetchCardByPath(path, sourceUrl, ctx = {}) {
    ctx.progress?.('Downloading card PNG');
    const pngUrl = `${this.CARD_CDN}/${path}.png?action=download`;

    let card = null;
    try {
      const buf = await (await httpGet(pngUrl)).arrayBuffer();
      card = extractCardFromPng(buf);
    } catch { /* fall through to the search index below */ }

    if (card) {
      const norm = normalizeSpecCard(card);
      ctx.progress?.('Fetching avatar');
      norm.avatar = await imageToDataUrl(this.avatarUrlFor(path));
      norm.sourceUrl = sourceUrl;
      norm.sourcePlatform = 'Character Tavern';
      norm.creator = path.split('/')[0];
      if (!norm.name) norm.name = path.split('/')[1];
      return norm;
    }

    // No embedded card - fall back to the search index, which stores the
    // definition field by field (but carries no lorebook). Needs the proxy.
    ctx.progress?.('Card PNG had no data, using search index');
    const hit = await this.findHitByPath(path);
    if (!hit) throw new Error(`No card data found for ${path}.`);
    return this.hitToCard(hit, sourceUrl, ctx);
  },

  // Same two names as listLibrary: `query`, not `q`, and `limit`, not
  // hitsPerPage. Getting them wrong here does not error - it searches for
  // nothing and returns the unfiltered list, so the card is simply not found.
  async findHitByPath(path) {
    const name = (path.split('/')[1] || path).replace(/[_-]+/g, ' ');
    const res = await getJson(
      `https://character-tavern.com/api/search/cards?query=${encodeURIComponent(name)}&limit=50`
    );
    return (res.hits || []).find(h => h.path === path) || null;
  },

  async hitToCard(hit, sourceUrl, ctx = {}) {
    ctx.progress?.('Fetching avatar');
    const avatar = await imageToDataUrl(this.avatarUrlFor(hit.path));
    return {
      name: clean(hit.name),
      chatName: clean(hit.inChatName),
      tagline: clean(hit.tagline),
      description: clean(hit.characterDefinition),
      personality: clean(hit.characterPersonality),
      scenario: clean(hit.characterScenario),
      first_mes: clean(hit.characterFirstMessage),
      mes_example: clean(hit.characterExampleMessages),
      alternate_greetings: Array.isArray(hit.alternativeFirstMessage) ? hit.alternativeFirstMessage : [],
      system_prompt: '',
      post_history_instructions: clean(hit.characterPostHistoryPrompt),
      tags: Array.isArray(hit.tags) ? hit.tags : [],
      character_book: null,
      avatar,
      gallery: [],
      creator: clean(hit.author),
      sourceUrl: sourceUrl || `https://character-tavern.com/character/${hit.path}`,
      sourcePlatform: 'Character Tavern',
    };
  },

  // The site builds its API call as `/api/search/cards?<the page's whole query
  // string>`, so the search box and every filter - tags, exclude_tags, sort,
  // hasLorebook, isOC, token range - are just URL params passed straight
  // through. Forwarding them wholesale is therefore not a guess, it is what
  // the site itself does.
  //
  // Two names matter and are easy to get wrong, because the API answers 200
  // and silently ignores a mistake rather than erroring: the search term is
  // `query` (not `q`, which returns the unfiltered list) and the page size is
  // `limit` (not `hitsPerPage`, which is ignored in favour of the default 30).
  async listLibrary(url, page) {
    const src = new URL(url).searchParams;
    const q = new URLSearchParams(src);

    if (!q.get('query')) {
      const alias = src.get('q') || src.get('search');
      if (alias) q.set('query', alias);
    }
    q.delete('q');
    q.delete('search');
    q.delete('layout');        // grid/list toggle - purely the site's own UI

    if (!q.get('limit')) q.set('limit', '24');
    q.set('page', String(page));

    const res = await getJson(`https://character-tavern.com/api/search/cards?${q}`);
    return {
      items: (res.hits || []).map(h => ({
        key: h.path,
        name: h.name,
        tagline: clean(h.tagline),
        avatarUrl: this.avatarUrlFor(h.path),
        cardUrl: `https://character-tavern.com/character/${h.path}`,
        creator: h.author,
      })),
      page: res.page || page,
      totalPages: res.totalPages || 1,
    };
  },
};

/* ---------- registry ---------- */

export const ADAPTERS = [chub, characterTavern];

export function adapterForUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    throw new Error('That is not a valid URL. Include https:// at the start.');
  }
  const found = ADAPTERS.find(a => a.matchUrl(u));
  if (!found) {
    throw new Error(
      `${u.hostname} is not supported - this tool handles chub.ai and character-tavern.com. ` +
      `Cards from elsewhere can be imported straight into Casual Character Chat instead.`
    );
  }
  return { adapter: found, url: u };
}
