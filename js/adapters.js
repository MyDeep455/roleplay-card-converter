/* =========================================================================
 * ADAPTERS - chub.ai, Character Tavern and JanitorAI
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

/* ---------- rich text ---------- */

/**
 * Flatten a fragment of author-written HTML to plain text.
 *
 * Only JanitorAI needs this: its description field is a rich-text editor's
 * output, so it arrives as `<p>`/`<br>`/`<img>` markup rather than the plain
 * strings every other field on every other site hands back.
 *
 * DOMParser rather than a tag-stripping regex, because this markup is written
 * by hand in a WYSIWYG box and is routinely malformed - unclosed tags, stray
 * `<`, angle brackets used as emphasis - which is exactly where regexes start
 * eating real text. `parseFromString` runs no scripts and the tree it returns
 * never touches the live document, so the markup stays inert either way.
 */
function htmlToText(html) {
  if (typeof html !== 'string' || !html.trim()) return '';
  if (!/[<&]/.test(html)) return html.trim();       // already plain, nothing to do

  const doc = new DOMParser().parseFromString(html, 'text/html');

  // textContent alone would run every paragraph together into one line, since
  // the line breaks in rendered HTML come from the tags rather than the text.
  doc.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  doc.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6').forEach(el => el.append('\n'));

  return (doc.body.textContent || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')      // collapse the runs of empty <p> people leave behind
    .trim();
}

/** Absolute image URLs embedded in a fragment of author-written HTML. */
function imagesFromHtml(html) {
  if (typeof html !== 'string' || !html.includes('<img')) return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('img')]
    .map(img => img.getAttribute('src') || '')
    .filter(src => /^https:\/\//i.test(src));
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

  // The avatar CDN mirrors the card path exactly, so a thumbnail for a pasted
  // link costs nothing - no API call, just the URL the search would have given.
  avatarFromCardUrl(u) {
    const fullPath = this.fullPathFrom(u);
    return fullPath.includes('/') ? `https://avatars.charhub.io/avatars/${fullPath}/avatar.webp` : '';
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

  // Same idea as chub's: the card PNG lives at a path derived from the page
  // URL, so it doubles as the thumbnail without asking the site anything.
  avatarFromCardUrl(u) {
    const path = this.pathFrom(u);
    return path ? this.avatarUrlFor(path) : '';
  },

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

/* =========================================================================
 * JANITORAI
 * -------------------------------------------------------------------------
 * Everything here is CORS-open - the API sends Access-Control-Allow-Origin: *
 * and so does the image CDN - so every call goes direct from the browser and
 * the proxy is not involved at all, exactly like chub.
 *
 *   list    GET janitorai.com/hampter/characters?page=P&mode=all&sort=popular
 *   card    GET janitorai.com/hampter/characters/{uuid}
 *   images  ella.janitorai.com/bot-avatars/{avatar}
 *
 * The token, however, is not the optional nicety chub's is. Signed out, this
 * API is a shop window: it serves page 1 and nothing else, and every
 * definition field on every card comes back null.
 *
 *   page=2 (or any page > 1)   401 "Sign in to search and browse more characters."
 *   search=anything            401, the same
 *   personality, scenario,     null on every card, including ones whose own
 *   first_message,             showdefinition flag says true
 *   example_dialogs
 *   tags=, limit=, size=       accepted and silently ignored - byte-identical
 *                              payload, so page size is fixed at 34
 *
 * Signed in, all of that opens up. So a JanitorAI token is closer to required
 * than optional, and the messages below say so rather than leaving someone to
 * work out why every card converted into an empty shell.
 *
 * Even signed in, a card whose author turned "show definition" off keeps its
 * definition withheld - roughly two cards in five. Those still convert on
 * their public description and arrive with the "partial" badge the results
 * list already shows for stub cards.
 * ========================================================================= */

const JAI_SIGNED_OUT =
  'JanitorAI needs your account token for this. Signed out it only serves the first page of ' +
  'results, hides every character definition, and refuses searches entirely. Add a token in ' +
  'Settings - see the hint there for where to find it.';

// Any JWT, wherever it appears in what was pasted.
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

const janitorai = {
  id: 'janitorai',
  label: 'JanitorAI',
  hosts: ['janitorai.com', 'www.janitorai.com'],
  tokenHint:
    'Needed for almost everything - without it JanitorAI serves only the first page of results ' +
    'and no character definitions. On janitorai.com while logged in: DevTools > Application > ' +
    'Cookies > sb-auth-auth-token.0. Paste the whole value. It expires after a few hours, so ' +
    're-copy it when searches start failing.',

  API: 'https://janitorai.com/hampter',
  MEDIA: 'https://ella.janitorai.com',

  // The API's own page size. `limit` and `size` are accepted and ignored, so
  // this is a fact about the endpoint rather than a preference.
  PAGE_SIZE: 34,

  // Both are strict: an unknown value is a 400, and the error body for `sort`
  // is where this list came from.
  SORTS: new Set(['latest', 'popular', 'trending', 'trending24', 'created', 'relevance', 'random']),
  MODES: new Set(['all', 'sfw', 'nsfw']),

  matchUrl(u) { return this.hosts.includes(u.hostname.toLowerCase()); },

  // Card URLs read /characters/<uuid>_<slug>, and the slug is decoration - the
  // uuid alone resolves - so only the uuid is taken.
  idFrom(u) {
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.indexOf('characters');
    const seg = i >= 0 ? (parts[i + 1] || '') : '';
    const m = seg.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return m ? m[0] : '';
  },

  isProfileUrl(u) { return u.pathname.split('/').filter(Boolean)[0] === 'profiles'; },

  isLibraryUrl(u) { return !this.idFrom(u); },

  cardUrlFor(id) { return `https://janitorai.com/characters/${id}`; },

  avatarUrlFor(avatar) {
    const a = clean(avatar);
    if (!a) return '';
    return /^https?:\/\//i.test(a) ? a : `${this.MEDIA}/bot-avatars/${a}`;
  },

  /**
   * Turn whatever was pasted into an Authorization header value.
   *
   * The value people are told to copy is a Supabase cookie, and it reaches
   * this box in every shape you would expect: the raw JWT, a "Bearer ..."
   * line lifted from the network tab, or the whole `base64-eyJhY2Nl...`
   * cookie - often truncated, because it is long and selecting all of it in
   * DevTools is fiddly. The JWT sits at the very front of that blob, so
   * hunting for the JWT rather than parsing the JSON survives a short copy.
   */
  authToken(raw) {
    const t = clean(raw);
    if (!t) return null;

    const inside = /^base64-/i.test(t) ? this.decodeCookie(t) : '';
    const m = (inside && inside.match(JWT_PATTERN)) || t.match(JWT_PATTERN);
    return m ? `Bearer ${m[0]}` : null;
  },

  decodeCookie(value) {
    // URL-safe base64, and trimmed to a whole number of quads so a copy that
    // stopped mid-character still decodes everything before the cut.
    const b64 = value.slice(7).replace(/-/g, '+').replace(/_/g, '/');
    try {
      return atob(b64.slice(0, b64.length - (b64.length % 4)));
    } catch {
      return '';
    }
  },

  // 401 here always means the same thing, and transport's generic wording
  // cannot know that, so it is replaced with the one instruction that helps.
  async getJanitor(url, token) {
    try {
      return await getJson(url, { token });
    } catch (err) {
      if (err?.status === 401) throw new Error(JAI_SIGNED_OUT);
      throw err;
    }
  },

  async fetchCard(url, ctx = {}) {
    const u = new URL(url);
    if (this.isProfileUrl(u)) {
      throw new Error(
        'That is a creator profile. JanitorAI has no way to list one creator\'s cards, so open the ' +
        'profile on the site and paste the card links you want instead.'
      );
    }
    const id = this.idFrom(u);
    if (!id) throw new Error('Expected a URL like janitorai.com/characters/<id>_<name>.');
    return this.fetchCardById(id, url, ctx);
  },

  async fetchCardById(id, sourceUrl, ctx = {}) {
    const node = await this.getJanitor(`${this.API}/characters/${id}`, this.authToken(ctx.token));

    // JanitorAI's `description` is the public blurb shown on the card's page,
    // and it is the one field that is never withheld. On the other sites the
    // equivalent is author-to-downloader commentary and is dropped, but here
    // it is where most authors actually write the character - and for the two
    // in five cards whose definition stays hidden it is the only persona text
    // that exists. So on this platform alone it is carried into the card.
    const notes = stripJaiWatermark(htmlToText(node.description));

    const greetings = Array.isArray(node.first_messages) ? node.first_messages : [];
    const first = stripJaiWatermark(clean(node.first_message) || clean(greetings[0]));

    // first_messages repeats the main greeting as its first entry, so keeping
    // it would give every card a duplicate "Alternate Greeting 1".
    const alternates = greetings
      .map(g => stripJaiWatermark(clean(g)))
      .filter(g => g && g !== first);

    ctx.progress?.('Fetching avatar');
    const avatar = await imageToDataUrl(this.avatarUrlFor(node.avatar));

    // There is no gallery endpoint here the way chub has one. What JanitorAI
    // does have is authors embedding art in the description, so those images
    // are the gallery - same CDN, same permissive CORS as the avatar.
    const urls = imagesFromHtml(node.description).slice(0, 24);
    const gallery = [];
    for (let i = 0; i < urls.length; i++) {
      ctx.progress?.(`Gallery image ${i + 1}/${urls.length}`);
      const d = await imageToDataUrl(urls[i], { gallery: true });
      if (d) gallery.push(d);
    }

    const tags = [
      ...(Array.isArray(node.tags) ? node.tags : []),
      ...(Array.isArray(node.custom_tags) ? node.custom_tags : []),
    ].map(jaiTagLabel).filter(Boolean);

    return {
      name: clean(node.name),
      chatName: clean(node.chat_name),
      tagline: '',                       // the blurb is the description here, not a separate line
      description: notes,
      personality: stripJaiWatermark(clean(node.personality)),
      scenario: stripJaiWatermark(clean(node.scenario)),
      first_mes: first,
      mes_example: stripJaiWatermark(clean(node.example_dialogs)),
      alternate_greetings: alternates,
      system_prompt: '',
      post_history_instructions: '',
      tags: [...new Set(tags)],
      character_book: null,              // JanitorAI has no lorebook of any kind
      avatar,
      gallery,
      creator: clean(node.creator_name),
      sourceUrl: sourceUrl || this.cardUrlFor(id),
      sourcePlatform: 'JanitorAI',
    };
  },

  // The grid gives one line under the name, and a JanitorAI description can
  // run to pages, so the tile gets its opening.
  blurb(html) {
    const text = htmlToText(html).replace(/\s+/g, ' ').trim();
    return text.length > 140 ? `${text.slice(0, 137).trimEnd()}...` : text;
  },

  // The site keeps its browse state in the query string - `sort`, `mode` and
  // the search box - so those three are read across and the rest dropped,
  // because the rest is ignored by the API anyway.
  async listLibrary(url, page, ctx = {}) {
    const u = new URL(url);
    if (this.isProfileUrl(u)) {
      throw new Error(
        'JanitorAI has no endpoint for one creator\'s cards, so a profile page cannot be mirrored. ' +
        'Open it on the site and paste the card links you want.'
      );
    }

    const src = u.searchParams;
    const q = new URLSearchParams();

    const search = clean(src.get('search') || src.get('q') || src.get('query'));
    if (search) q.set('search', search);

    const sort = clean(src.get('sort'));
    q.set('sort', this.SORTS.has(sort) ? sort : (search ? 'relevance' : 'popular'));

    const mode = clean(src.get('mode'));
    q.set('mode', this.MODES.has(mode) ? mode : 'all');

    q.set('page', String(page));

    const token = this.authToken(ctx.token);
    const res = await this.getJanitor(`${this.API}/characters?${q}`, token);

    const nodes = res.data || [];
    const size = res.size || this.PAGE_SIZE;
    const total = res.total ?? res.filtered_total ?? nodes.length;

    return {
      items: nodes.map(n => ({
        key: n.id,
        name: clean(n.name) || 'Untitled',
        tagline: this.blurb(n.description),
        avatarUrl: this.avatarUrlFor(n.avatar),
        cardUrl: this.cardUrlFor(n.id),
        creator: clean(n.creator_name),
      })),
      page: res.page || page,
      // Signed out every page after the first is a 401, so offering tens of
      // thousands of them would be offering a wall.
      totalPages: token ? Math.max(1, Math.ceil(total / size)) : 1,
    };
  },

  /**
   * Fill in thumbnails for pasted card links.
   *
   * chub and Character Tavern both put the card image at a path derived from
   * the card's own URL, so a pasted link becomes a thumbnail for free. Here
   * the avatar's filename is an opaque id that appears nowhere in the URL, so
   * the only way to get one is to ask. That would be a slow blank grid if it
   * ran first, so instead the tiles are drawn immediately and each fills in as
   * its answer arrives.
   */
  async hydrateAvatars(items, ctx = {}) {
    const token = this.authToken(ctx.token);
    for (const item of items) {
      if (ctx.cancelled?.()) return;
      let id = '';
      try { id = this.idFrom(new URL(item.cardUrl)); } catch { /* not ours */ }
      if (!id) continue;

      try {
        const node = await getJson(`${this.API}/characters/${id}`, { token });
        ctx.onItem?.(item, {
          name: clean(node.name) || item.name,
          tagline: this.blurb(node.description),
          avatarUrl: this.avatarUrlFor(node.avatar),
          creator: clean(node.creator_name),
        });
      } catch {
        // A thumbnail is decoration; the link still converts without one.
      }
    }
  },
};

// Cards published through some third-party tools pick up a trailing "Created
// with janitorai.com" line. It is a site watermark, not something the
// character says.
function stripJaiWatermark(text) {
  if (!text) return '';
  return text
    .split('\n')
    .filter(line => !/^\s*created\s+(with|on|using|by)?\s*[^\n]*janitorai\.com\.?\s*$/i.test(line))
    .join('\n')
    .trim();
}

// Tag names carry a leading emoji ("👨 Male"); the app shows tags as plain
// text, so the picture goes and the word stays.
function jaiTagLabel(tag) {
  const name = typeof tag === 'string' ? tag : String(tag?.name ?? '');
  // The joiner and variation selector are written as escapes on purpose: as
  // literals they are invisible in the source, and a stray reformat or a
  // copy-paste through something that normalises text would silently drop
  // them, leaving the joiners behind in every multi-part emoji.
  return name
    .replace(/[\p{Extended_Pictographic}\u200D\uFE0F]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------- registry ---------- */

export const ADAPTERS = [chub, characterTavern, janitorai];

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
      `${u.hostname} is not supported - this tool handles chub.ai, character-tavern.com and ` +
      `janitorai.com. Cards from elsewhere can be imported straight into Casual Character Chat instead.`
    );
  }
  return { adapter: found, url: u };
}
