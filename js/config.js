/* =========================================================================
 * CONFIG - the one file you may need to edit
 * =========================================================================
 * Everything else in this tool runs from your browser with nothing to set up.
 * There is exactly one exception, and this is where you point it somewhere.
 *
 * Character Tavern's *search* API (used only to mirror a whole library) sends
 * no CORS headers and rejects a preflight with 405, so no web page anywhere is
 * allowed to read it. It has to be fetched by a server instead. Every other
 * request this tool makes - all of chub.ai, every single card, every avatar
 * and gallery image, and Character Tavern's own card files - is CORS-open and
 * goes straight from your browser, proxy or no proxy.
 *
 * Leave HOSTED_PROXY empty and the tool still does all of that. The only thing
 * you lose is "Mirror a Character Tavern library".
 *
 * To turn that feature on for everyone visiting your hosted copy, deploy
 * proxy.js once (see README - "Hosting it for other people") and paste the URL
 * it gives you here:
 *
 *   export const HOSTED_PROXY = 'https://your-service.onrender.com';
 *
 * No trailing slash needed - one is trimmed either way.
 *
 * This is ignored entirely when you run the tool locally with `npm start`,
 * because then the proxy is already on the same origin as the page.
 * ========================================================================= */

export const HOSTED_PROXY = 'https://ccc-card-converter.onrender.com';

/* -------------------------------------------------------------------------
 * Where Casual Character Chat lives.
 * -------------------------------------------------------------------------
 * Only ever used as a fallback. The normal way in is the other direction:
 * Casual Character Chat opens this tool itself, and tells it where to send
 * cards back to in the link it opens (see js/ccc-link.js). Whoever launched
 * the tool is always preferred over anything written here, so a self-hosted
 * copy of the app keeps working without this ever being touched.
 *
 * This address is what "Import" falls back to when the tool was opened on its
 * own - a bookmark, a search result - and there is no launcher to answer to.
 * ------------------------------------------------------------------------- */
export const CCC_APP_URL = 'https://casual-character-chat.vercel.app/';
