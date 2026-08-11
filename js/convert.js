/* =========================================================================
 * CONVERT - platform card -> Casual Character Chat character
 * =========================================================================
 * Adapters do not each invent their own output. Every one of them produces
 * the same intermediate shape (`NormalizedCard`, essentially a V2/V3 card
 * `data` object plus the pictures we fetched), and this file is the single
 * place that turns that into a CCC character.
 *
 * The field mapping follows the app's own importer (`convertExternalCardToCCC`
 * in script.js) so a converted card reads exactly like one imported by hand,
 * with two deliberate additions the app's importer cannot make:
 *
 *   - `gallery`, because the app's PNG importer has no gallery source but the
 *     card editor does keep one.
 *   - `loreEntries`, filled from the card's lorebook, so a lorebook arrives as
 *     structured entries rather than one wall of text.
 *
 * Creator notes are deliberately dropped. They are a message from the card's
 * author to whoever downloads it - changelogs, credits, "use this preset",
 * links - not anything the character is. Wherever they were put they were
 * wrong: in the description they became part of the persona, and in the
 * lorebook they became world facts. Nothing reads them, so nothing carries
 * them.
 * ========================================================================= */

/**
 * The shape every adapter returns.
 * @typedef {Object} NormalizedCard
 * @property {string}   name
 * @property {string}   [chatName]        in-chat display name, if the platform has one
 * @property {string}   [tagline]         short blurb shown on the card's page
 * @property {string}   [description]
 * @property {string}   [personality]
 * @property {string}   [scenario]
 * @property {string}   [first_mes]
 * @property {string}   [mes_example]
 * @property {string[]} [alternate_greetings]
 * @property {string}   [system_prompt]
 * @property {string}   [post_history_instructions]
 * @property {string[]} [tags]
 * @property {Object}   [character_book]  { entries: [{ keys[], content }] }
 * @property {string}   [avatar]          WebP data URL
 * @property {string[]} [gallery]         WebP data URLs
 * @property {string}   [sourceUrl]
 * @property {string}   [sourcePlatform]
 * @property {string}   [creator]
 */

/* ---------- text helpers ---------- */

const txt = v => (typeof v === 'string' ? v.trim() : '');

// Joins section bodies under the app's header strings, skipping any section
// with nothing in it so cards do not end up with dangling headers.
function joinSections(sections) {
  return sections
    .filter(s => s && txt(s.body))
    .map(s => (s.header ? `${s.header}\n${txt(s.body)}` : txt(s.body)))
    .join('\n\n')
    .trim();
}

export function newCharacterId() {
  return 'char-' + Date.now() + '-' + Math.random().toString(36).slice(2, 11);
}

/* ---------- lorebook ---------- */

// Card lorebooks arrive in several shapes: a V3 `character_book` object with
// an entries array, a bare string, or (on some platforms) a flat list.
// Everything funnels into { flat, entries } here.
export function extractLorebook(book) {
  const entries = [];
  const pieces = [];

  if (typeof book === 'string' && book.trim()) {
    pieces.push(book.trim());
    return { flat: pieces.join('\n\n'), entries };
  }

  const list = Array.isArray(book) ? book : (book && Array.isArray(book.entries) ? book.entries : null);
  if (!list) return { flat: '', entries };

  list.forEach(e => {
    if (!e) return;
    const keysRaw = Array.isArray(e.keys) ? e.keys
                  : Array.isArray(e.key) ? e.key
                  : (e.keys || e.key || e.keyword || '');
    const keywords = (Array.isArray(keysRaw) ? keysRaw.join(', ') : String(keysRaw || '')).trim();
    const content = txt(e.content || e.value || e.entry || '');
    if (!content) return;

    entries.push({ keywords, text: content });
    pieces.push([keywords ? `[${keywords}]` : '', content].filter(Boolean).join('\n').trim());
  });

  return { flat: pieces.join('\n\n').trim(), entries };
}

/* ---------- the mapping ---------- */

/**
 * Turn a NormalizedCard into a Casual Character Chat character object.
 * The result is written straight into the app's `characters` map on import,
 * so every field the editor reads has to be present and of the right type.
 */
export function toCccCharacter(card) {
  const tagline = txt(card.tagline);
  const description = txt(card.description);
  const personality = txt(card.personality);
  const mesExample = txt(card.mes_example);

  const fullDescription = joinSections([
    { header: '', body: tagline },
    { header: '--- CHARACTER DESCRIPTION ---', body: [personality, description].filter(Boolean).join('\n\n') },
    { header: '--- EXAMPLE MESSAGES ---', body: mesExample },
  ]);

  const book = extractLorebook(card.character_book);

  // A lorebook entry that just repeats the tagline is noise - the tagline is
  // already at the top of the description.
  const flatLore = book.flat && book.flat !== tagline ? book.flat : '';

  // Which lore mode the card actually wants.
  //
  // Always-on lore is concatenated into every prompt, which is fine for a few
  // paragraphs and ruinous for a real lorebook - imported cards routinely
  // carry 150+ entries running to hundreds of KB. When most entries came with
  // trigger keywords, that is the author saying "inject these on demand", so
  // the card is set to keyword mode and the bulky text lives only in
  // loreEntries. Otherwise nothing would ever trigger, so it stays flat.
  const keyed = book.entries.filter(e => e.keywords).length;
  const useKeyword = book.entries.length > 0 && keyed >= book.entries.length / 2;

  // In keyword mode the entries are already in loreEntries; repeating them
  // here would double the card's size for text the app will not read.
  const fullLore = useKeyword ? '' : flatLore;

  const scenarios = [];
  const mainScenario = [txt(card.scenario), txt(card.first_mes)].filter(Boolean).join('\n\n').trim();
  if (mainScenario) scenarios.push({ name: 'Main Greeting', text: mainScenario });

  if (Array.isArray(card.alternate_greetings)) {
    card.alternate_greetings.forEach((greeting, i) => {
      const t = txt(greeting);
      if (t) scenarios.push({ name: `Alternate Greeting ${i + 1}`, text: t });
    });
  }

  const tags = Array.isArray(card.tags)
    ? card.tags.map(t => String(t).trim()).filter(Boolean).join(', ')
    : txt(card.tags);

  return {
    id: newCharacterId(),
    name: txt(card.name) || 'Unnamed Import',
    chatName: txt(card.chatName) || txt(card.name) || '',
    avatar: card.avatar || '',
    background: '',
    gallery: Array.isArray(card.gallery) ? card.gallery.filter(Boolean) : [],
    instructions: txt(card.system_prompt),
    description: fullDescription,
    lore: fullLore,
    loreMode: useKeyword ? 'keyword' : 'flat',
    loreEntries: book.entries,
    tags,
    reminder: txt(card.post_history_instructions),
    narratorReminder: '',
    musicUrl: '',
    scenarios,
    type: 'character',
    characterIds: [],
    chats: {},
  };
}

/**
 * Wrap characters in the backup envelope the app's importer recognises.
 * This is the v3 "JSON backup" branch of handleFileImport, which writes the
 * character object through untouched - the chara_card_v2 branch would send it
 * back through the app's own converter and drop gallery and loreEntries.
 */
export function toCccBackup(characters) {
  const map = {};
  characters.forEach(c => { map[c.id] = c; });
  return {
    version: 3,
    characters: map,
    personas: {},
    appSettings: null,
  };
}

/* ---------- generic V2/V3 card -> NormalizedCard ---------- */

/**
 * Accepts anything shaped like a TavernAI V1/V2/V3 card and flattens it.
 * Used by the PNG/JSON import paths and by adapters whose platform already
 * hands back a standard card.
 */
export function normalizeSpecCard(raw) {
  const d = (raw && raw.data) ? raw.data : raw || {};
  return {
    name: d.name || d.char_name || '',
    chatName: d.nickname || '',
    tagline: d.tagline || d.card_description || '',
    description: d.description || d.char_persona || '',
    personality: d.personality || d.tavern_personality || '',
    scenario: d.scenario || d.world_scenario || '',
    first_mes: d.first_mes || d.first_message || d.char_greeting || '',
    mes_example: d.mes_example || d.example_dialogue || d.example_dialogs || '',
    alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [],
    system_prompt: d.system_prompt || '',
    post_history_instructions: d.post_history_instructions || '',
    tags: Array.isArray(d.tags) ? d.tags : [],
    character_book: d.character_book || d.embedded_lorebook || d.lorebook || d.lore || null,
    creator: d.creator || '',
  };
}
