# Roleplay Card Converter

Downloads character cards from **chub.ai**, **character-tavern.com** and **janitorai.com** and
converts them into the
[Casual Character Chat](https://github.com/MyDeep455/casual-character-chat-app) JSON format, ready to
import.

### ▶ [Open the converter](https://MyDeep455.github.io/roleplay-card-converter/)

Nothing to install, nothing to sign up for. It runs entirely in your browser.

---

## What it does

Paste any chub.ai, Character Tavern or JanitorAI link into the one box and press **Convert**. What you
pasted decides what happens — there is nothing to choose first:

| What you paste | What you get |
|---|---|
| A **card** link | Converted straight away |
| A **search** or browse link | A grid of what it found; tick the ones you want |
| **Several card links**, one per line | The same grid, everything preselected |

Converted cards are kept in your browser's own storage until you clear them, and downloaded as a
Casual Character Chat backup file — one card at a time, or all of them in a single file.

**Your data stays yours.** There is no account, no server storing anything, and nothing is uploaded.
The tool talks to the three card sites and to nothing else. Converted cards live in your browser's
IndexedDB on your own machine.

---

## Using it

### A single card

Paste the card's page URL and press **Convert**:

- `https://chub.ai/characters/author/character-name`
- `https://character-tavern.com/character/author/card_name`
- `https://janitorai.com/characters/<id>_character-name`

### A whole search

Set your search up on the site first, then copy the URL out of the address bar. The whole query
string is carried over — search terms, tags, excluded tags, sort order, lorebook/OC toggles, token
ranges. If the URL names a page (`&page=3`), it starts there.

You get a plain grid — avatar, name, tagline, creator — with checkboxes. Tick what you want and press
**Convert selected**. Star counts, downloads, ratings and comments are never read and never reach the
output.

### Several at once

Paste card links one per line, mixing both sites freely. They all land in the same grid, already
ticked. Search links cannot be mixed in — one search is hundreds of cards, so paste those on their
own.

### Cards from anywhere else

Casual Character Chat imports character card PNGs and JSON by itself, so there is nothing to convert
first — take the file straight to the app.

### Getting cards into Casual Character Chat

In the app: **Import → Backup (.json)** → pick the file → confirm.

Use **Backup**, not *Character Card*. The file is already in the app's own format; the character-card
path would run it through the app's converter a second time and drop the gallery and lorebook entries.

---

## The one feature that needs a server

Browsers refuse to read a response from another site unless that site opts in with an
`Access-Control-Allow-Origin` header. Almost everything here opts in:

| What | Opted in? | |
|---|---|---|
| `api.chub.ai` — cards, search, galleries | yes | direct from your browser |
| `ct-cards.storage.character-tavern.com` — card PNGs, avatars | yes | direct from your browser |
| `janitorai.com/hampter` — cards and listings | yes | direct from your browser |
| `ella.janitorai.com` — avatars, description art | yes | direct from your browser |
| `character-tavern.com/api/search/cards` — library listing | **no**, and rejects preflight with 405 | needs a server |

So exactly one feature — **mirroring a Character Tavern library** — cannot work from a web page alone.
Single Character Tavern cards, their images, the entirety of chub.ai and the entirety of JanitorAI are
all unaffected.

The **proxy pill** in the header tells you where you stand. If it says the proxy is unavailable,
everything still works except that one thing.

### "Proxy blocked" — an extension, not the server

Ad blockers stop this, and more often than you would expect: blocking lists cover the shared domains
free hosting platforms hand out, so the proxy gets caught by association rather than for anything it
does. uBlock Origin, Adblock Plus, Ghostery and Privacy Badger have all been seen doing it.

Click your blocker's toolbar icon and allow this site, then click the proxy pill to retry. Opening
the page in a private window, where extensions are usually switched off, confirms the diagnosis in
seconds. The browser console names it outright as `ERR_BLOCKED_BY_CLIENT`.

Only Character Tavern library mirroring is affected — nothing else on the page makes that request.

`proxy.js` is what fills that gap. It is about 250 lines, has no dependencies, and only ever fetches
from an allow-list of the two card sites, so it cannot be pointed at anything else.

---

## Running it on your own machine

Optional. Worth it if you want Character Tavern library mirroring without depending on anyone's
hosted proxy, or you would simply rather run everything locally.

You need [Node.js](https://nodejs.org) 18 or newer. Then:

```
git clone https://github.com/MyDeep455/roleplay-card-converter.git
cd roleplay-card-converter
npm start
```

Open **http://127.0.0.1:8787** — `proxy.js` serves the tool as well as proxying, so that one command
is the whole thing. No `npm install`; there is nothing to install.

| | |
|---|---|
| `npm start` | serve at `http://127.0.0.1:8787` |
| `npm run start:open` | the same, and open your browser |
| **Windows** | double-click `Start Card Converter.vbs` |
| **macOS / Linux** | `./start.sh` |
| **VS Code** | just open the folder — `.vscode/tasks.json` starts it automatically |
| **Windows, at login** | run `install-autostart.cmd` once; undo with `uninstall-autostart.cmd` |

Different port: `PORT=8788 npm start` (Windows: `set PORT=8788 && npm start`).

Started twice by mistake? The second one notices the port is already its own and exits quietly, so
combining the launchers above is safe.

What you **cannot** do is open `index.html` by double-clicking it — `file://` pages get no IndexedDB
and no ES modules. It has to be served over `http://`, which is what `npm start` is for.

A local copy prefers a local server and falls back to the deployed one from `js/config.js` if none is
running, so working on the tool locally does not mean losing library mirroring.

---

## Hosting it for other people

Two pieces, and the second one is optional.

### 1. The tool itself — GitHub Pages

Fork or upload this repo, then **Settings → Pages → Source: Deploy from a branch**, branch `main`,
folder `/ (root)`. That is the whole deployment; it is a static site with no build step.

Update the link at the top of this README to your Pages URL.

At this point everything works except Character Tavern library mirroring, and the tool says so
plainly rather than failing oddly. For a lot of people that is enough — stop here if it is.

### 2. The proxy — one free web service

Only needed to switch that last feature on for your visitors.

1. On [Render](https://render.com), **New → Blueprint**, point it at your repo. `render.yaml` sets
   everything up; there is no build step and no environment variable to configure.
2. Copy the URL it gives you (`https://something.onrender.com`).
3. Paste it into `js/config.js`:

   ```js
   export const HOSTED_PROXY = 'https://something.onrender.com';
   ```
4. Commit. Pages redeploys itself, and mirroring now works for everyone, with nothing for them to
   install.

**Free tiers sleep.** After ~15 minutes idle the service shuts down and the next request waits up to
a minute for it to wake. The tool handles this on purpose: the pill shows *Waking proxy…* and a
mirror started during a cold start says so instead of appearing to hang. Only library mirroring ever
touches the proxy, so nothing else is ever slow.

Any host that runs a Node process works just as well — `proxy.js` reads `PORT` from the environment
and binds `0.0.0.0` when it detects a hosting platform.

**On abuse.** A public proxy is a URL anyone can hit. Two things keep that boring: it will only fetch
from the two card sites' hosts, and it rate-limits to 90 requests per minute per IP (both at the top
of `proxy.js`). Real use is a few requests per library page.

---

## How the conversion maps

| Casual Character Chat field | Comes from |
|---|---|
| `name` | card name |
| `chatName` | in-chat name where the card has one, else the name |
| `avatar` | card image, re-encoded to WebP (max 1024px, quality 0.80) |
| `gallery[]` | the platform's gallery images, WebP (max 1600px) |
| `description` | tagline, then `--- CHARACTER DESCRIPTION ---` (personality + description), then `--- EXAMPLE MESSAGES ---` |
| `lore` | lorebook text, flat mode only |
| `loreEntries[]` | lorebook entries as `{ keywords, text }` |
| `loreMode` | `keyword` when most entries carry trigger keywords, else `flat` |
| `scenarios[]` | `Main Greeting` (scenario + first message), then each alternate greeting |
| `instructions` | `system_prompt` |
| `reminder` | `post_history_instructions` |
| `tags` | tag list, comma-joined |
| `background`, `narratorReminder`, `musicUrl` | left empty for you to fill in |

**Creator notes are dropped entirely.** They are a message from the card's author to whoever
downloads it — changelogs, credits, "use this preset", links — not anything the character *is*.
Wherever they were put they were wrong: in the description they became part of the persona, in the
lorebook they became world facts.

**About lore mode.** A real lorebook can run to 150+ entries and hundreds of KB. In always-on mode all
of that is prepended to every prompt, which is ruinous for context and cost. So when most entries
carry trigger keywords — the author saying "inject these on demand" — the card is set to
keyword-triggered and the bulk lives in `loreEntries` only. Books with no keywords stay flat, because
nothing would ever trigger them. Either way you can flip the radio in the card editor; the entries
are always populated.

Meta information — votes, downloads, ratings, favourites, comments, chat and message counts — is
excluded throughout. The output contains only the fields of the app's character schema.

---

## Tokens

Chub accepts an optional API token (**Settings**) for reaching your own private cards. Public cards
need nothing, and Character Tavern needs nothing at all.

**JanitorAI is the exception: there a token is close to required.** Signed out, its API is a shop
window — it serves the first page of results and refuses every page after it, refuses searches
outright, and returns `null` for every character definition, so cards convert into name-and-avatar
shells. Signed in, all of it works.

To get one: log in on janitorai.com, then **DevTools → Application → Cookies → `sb-auth-auth-token.0`**,
and paste the whole value into **Settings**. The raw JWT and a `Bearer …` line are accepted too. It is
a session token and expires after a few hours, so re-copy it when searches start failing.

Even with a token, a card whose author turned **show definition** off keeps its definition hidden —
roughly two in five. Those still convert, on their public description, and arrive marked `partial`.

A token you enter is stored in your browser's IndexedDB on your own machine and sent only to the site
it belongs to. When a request goes through the proxy it is forwarded once and never logged or stored.

---

## Files

```
index.html                 UI
style.css                  styling
js/config.js               the one file you may need to edit (hosted proxy URL)
js/transport.js            fetching; one host proxied, everything else direct
js/adapters.js             chub.ai, Character Tavern and JanitorAI
js/convert.js              card -> Casual Character Chat schema
js/media.js                PNG card extraction, WebP re-encoding
js/db.js                   IndexedDB (cards + settings)
js/app.js                  UI wiring and the conversion pipelines

proxy.js                   serves the tool + proxies the one blocked endpoint, zero dependencies
render.yaml                one-click deploy of the above
start.sh                   macOS/Linux launcher
Start Card Converter.vbs   Windows launcher
install-autostart.cmd      optional: run the server at Windows login
uninstall-autostart.cmd    undo the above
.vscode/tasks.json         starts the server when the folder opens in VS Code
```

## Licence

MIT — see [LICENSE](LICENSE).

Not affiliated with chub.ai, character-tavern.com or janitorai.com. Respect the terms of whichever site you download
from, and the wishes of the people whose cards you convert.
