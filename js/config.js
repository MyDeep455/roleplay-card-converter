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

export const HOSTED_PROXY = 'https://roleplay-card-converter-proxy.onrender.com';
