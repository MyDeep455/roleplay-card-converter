# Character Card Browser

Search **chub.ai**, **character-tavern.com** and **janitorai.com** from one page, convert what you
like, and put it straight into
[Casual Character Chat](https://github.com/MyDeep455/casual-character-chat-app) — no file to save and
no import dialog to go through.

### ▶ [Open it](https://MyDeep455.github.io/roleplay-card-converter/)

Nothing to install, nothing to sign up for. It runs entirely in your browser.

> Formerly the *Roleplay Card Converter*. The address is unchanged, so existing links and the button
> inside Casual Character Chat keep working.

---

## What it does

**Search all three sites without leaving.** Pick a site, type what you are after, press **Search**.
The tool writes that site's own search URL and mirrors the results into a grid — tick what you want
and convert it.

| Control | What it does |
|---|---|
| **Site** | chub.ai, Character Tavern or JanitorAI. Switching re-runs the search on the new site. |
| **Search box** | The same words you would have typed on the site. Leave it empty to just browse. |
| **Sort** | That site's own orderings — 13 on chub, 4 on Character Tavern, 7 on JanitorAI. |
| **Advanced filters** | Folded away, and holds the three below. A number beside the line says how many of them are currently narrowing your search. |
| **Tags / Exclude** | Comma-separated. Must have / must not have. |
| **Content** | Include NSFW, hide it, or show only it. |

Controls a site cannot honour are hidden rather than shown dead — JanitorAI gets no tag boxes,
because its API accepts them and then ignores them. They are not counted on that site either, so the
number beside *Advanced filters* only ever means filters that are actually doing something.

Converted cards are kept in your browser's own storage until you clear them. Press **Import** on any
one of them — or **Import all** — and it lands in Casual Character Chat directly. **Download** is
still offered beside it for anyone who wants a backup file of their own, but nothing needs one.

**Your data stays yours.** There is no account, no server storing anything, and nothing is uploaded.
The tool talks to the three card sites and to nothing else. Converted cards live in your browser's
IndexedDB on your own machine.

---

## Using it

### Searching

Type in the box and press **Search** (or Enter). Changing the site, the sort or the content filter
re-runs the search on its own, because the panel is meant to describe the grid underneath it rather
than sit above stale results.

The tool builds the site's real search URL, so the link under the grid opens the same search on the
site itself — nothing here is a private format.

**Each site is its own thing, and the panel follows it rather than papering over the differences:**

- **chub.ai** has the deepest filtering: 13 sort orders, tags and excluded tags (`topics` /
  `excludetopics`), and separate NSFW/NSFL switches. It sorts by *Relevance* unless told otherwise.
  Its *Trending* is a couple of hundred cards picked out right now rather than an ordering of the
  36,000-odd it holds, and a search term intersected with that shelf reliably finds nothing — so it
  is never the default, and a search that empties because of it says so.
- **Character Tavern** honours three sort orders and no more — *Trending*, *Newest* and *Oldest*.
  Every other value is accepted and quietly ignored, so only those are offered. Its *Trending* is
  the same kind of shelf as chub's, about thirty hand-picked cards, and is treated the same way.
- **JanitorAI** has sort and a SFW/NSFW mode, and no working tag filter at all. It also needs a
  token to search — see [Tokens](#tokens).

### Picking from the results

You get a plain grid — avatar, name, tagline, creator — with checkboxes. Tick what you want and press
**Convert selected**. The tagline is shown whole rather than trimmed: it scrolls inside the tile once
it runs past about seven lines on a phone or ten on a desktop, and never sideways. Star counts,
downloads, ratings and comments are never read and never reach the output.

Tiles carry a small **ⓘ** in the corner of the picture. Hover it on a computer or tap it on a phone
and the card's details open beside the tile — a popover next to the card where there is a mouse, a
sheet across the bottom of the screen where there is not:

| | |
|---|---|
| **Token count** | how big the card is, above everything else, because it decides whether the rest is worth reading |
| **Creator notes** | the paragraph the tagline is the first line of — what the card is for, which model it was written against, what the alternate greetings are |
| **Greetings** | the opening messages themselves, in the author's order and numbered where there is more than one |
| **Gallery** | the art that came with the card, as pictures rather than a count |
| **Tags** | the site's own topic list, as chips |
| **Lorebook** | only where the site says, which today is Character Tavern alone |

All of it comes out of the same search reply the tiles were drawn from, so the panel costs no extra
request and never leaves the grid — and a site that does not answer something simply shows one part
fewer. No site answers all six, and which parts you get is a fact about the platform rather than
about the card:

| | chub.ai | Character Tavern | JanitorAI |
|---|---|---|---|
| Token count | ✓ | ✓ | |
| Creator notes | ✓ | ✓ | — *(its one description field is already the tile's tagline)* |
| Greetings | | ✓ | |
| Gallery | | | ✓ *(the art authors embed in the description)* |
| Tags | ✓ | ✓ | ✓ |
| Lorebook | | ✓ | |

The gaps are all the same shape: the answer exists, but only behind a request per card. chub's search
returns a null `definition` on every result, so its greetings are a fetch away and its gallery is a
second endpoint again; a page of tiles that filled those in would be two dozen extra requests to draw
a grid. Same story for the lorebook line on a chub card — chub's search can *filter* for lore but
never says which card has it. A tile with nothing at all to add gets no badge in the first place.

The notes, the greetings and the gallery share one scrolling column, so they read in order and
against each other. The tags sit pinned underneath it and scroll on their own, which is what keeps
them reachable: a card with a five-thousand-character writeup and fifty tags still shows the tags
where they always are, rather than pushing them off the bottom of a phone with nothing able to
scroll them back.

**Prev** and **Next** page through four full rows at a time, whatever that works out to at your
window size. Each site hands out its results in its own page size — 24 on chub, 34 on JanitorAI —
so those are buffered behind the grid and dealt out to fit it; one press of **Next** may cost a
request to the site, or none at all.

### Cards from anywhere else

Casual Character Chat imports character card PNGs and JSON by itself, so there is nothing to convert
first — take the file straight to the app. That also covers a card you have already found somewhere
else: download it on the site and hand the file to the app, no trip through here needed.

### Getting cards into Casual Character Chat

Press **Import** on a card, or **Import all** above the list. The card goes into the app's own
storage as it arrives — nothing is written to disk and there is nothing to pick out of a downloads
folder afterwards.

The two halves talk over `postMessage`, which is why this works at all: a converted card carries its
avatar and gallery as embedded images and routinely runs to several megabytes, far past what a URL
could ever carry. Cards only travel one way, and the app never sends anything back but a count of
what it added.

**The short way round.** Open it from inside Casual Character Chat — the **🃏 Browse Characters**
button, next to *Create Character*. The app then knows the tool and the tool knows where to answer,
so importing takes one press and puts you back in the tab you started in.
Opening it on its own also works; it opens the app itself the first time you press Import,
and the app asks you to confirm before letting the cards in. That question lands on the app's tab
rather than this one, so a hint appears beside the Import button you pressed, pointing you at the tab
that is waiting for an answer.

Refreshing Casual Character Chat mid-session costs you nothing: it recognises this tool again
afterwards and keeps importing without asking, and an Import pressed while it is still reloading
waits for it to come back rather than disappearing into the gap.

Importing the same card twice is harmless — the app skips anything whose id it already holds rather
than overwriting your copy.

If pop-ups are blocked, the browser will stop the app's tab from opening. Allow pop-ups for the site,
or fall back to **Download** and the app's own **Import Data** button. Use **Backup**, not *Character
Card*, if you go that way: the file is already in the app's own format, and the character-card path
would run it through the app's converter a second time and drop the gallery and lorebook entries.

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
lorebook they became world facts. They are worth *reading* before you pick a card, which is what the
**ⓘ** on a tile is for, and that is where they stay — the panel is a reading aid and the conversion
takes nothing from it. (A converted card does carry tags, but those come from the card itself during
conversion, exactly as they always did, not from the panel's copy of them.)

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

Because a search there fails outright rather than returning less, the search panel says so as soon
as JanitorAI is selected, instead of letting the search run and report an error.

The tool cannot fetch that token for you, and not for lack of trying — browsers seal each site's
cookies off from every other site, JanitorAI answers with `Access-Control-Allow-Origin: *` (which
browsers refuse for credentialed requests, so its login cannot be borrowed), and it refuses to be
framed. All three were tested; all three are walls.

So a card that arrives without its greeting and description raises a notice offering the only two
routes there are: copy the description and greeting by hand from the card's page, or, **on a
computer**, read the token out of the browser yourself — logged in on janitorai.com, **F12 →
Application → Cookies → `sb-auth-auth-token.0`** (plus `.1` if present — long sessions are split
across two cookies) — and paste the value into **Settings**. The raw JWT and a `Bearer …` line are
accepted too. It expires after a few hours, so repeat when searches start failing. **A phone has no
DevTools panel, so there is no token route there at all** — only copying by hand.

The same two routes sit behind **Missing characters?** under a grid of JanitorAI results, which
appears only while no token is saved.

Even with a token, a card whose author turned **show definition** off keeps its definition hidden —
roughly two in five. Those still convert, on their public description, and arrive marked `partial card`.

A token you enter is stored in your browser's IndexedDB on your own machine and sent only to the site
it belongs to. When a request goes through the proxy it is forwarded once and never logged or stored.

---

## Files

```
index.html                 UI
style.css                  styling
js/config.js               the one file you may need to edit (hosted proxy URL)
js/transport.js            fetching; one host proxied, everything else direct
js/adapters.js             chub.ai, Character Tavern and JanitorAI: fetching, plus
                           the `search` descriptor each one builds its search URLs from
js/convert.js              card -> Casual Character Chat schema
js/media.js                PNG card extraction, WebP re-encoding
js/db.js                   IndexedDB (cards + settings)
js/app.js                  UI wiring, the search panel, and the conversion pipelines
js/ccc-link.js             handing converted cards to Casual Character Chat

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
