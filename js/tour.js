/* =========================================================================
 * TOUR - the first-visit walkthrough
 * =========================================================================
 * Someone arriving here has a page of controls and no idea that the whole
 * job is four steps long. This walks them through it once: a dimmed page, one
 * lit element at a time, and a short card beside it saying what that element
 * is for.
 *
 * The dimming is not a separate overlay with a hole cut in it - it is one
 * enormous box-shadow cast outward by the spotlight element itself. The lit
 * rectangle is therefore the same object that darkens everything around it,
 * so the two can never drift apart, and moving the highlight is a matter of
 * moving one box.
 *
 * Positions are recomputed every frame while the tour is open rather than
 * once per step. The page underneath is still live - images finish loading,
 * the trending grid arrives, the window gets resized, the user scrolls - and
 * anything that shifts a target would otherwise leave the highlight sitting
 * over empty space.
 * ========================================================================= */

import { getSetting, setSetting } from './db.js';

const $ = id => document.getElementById(id);

/* Bumping this shows the tour again to people who have already seen it. Worth
   doing when a step describes something that has genuinely changed; not worth
   doing for wording. */
const TOUR_VERSION = 1;

/* ---------------- the script ---------------- */

/**
 * target  CSS selector for the element to light up; null centres the card
 *         over the dimmed page with nothing highlighted.
 * place   preferred side of the target. Only a preference: a side with no
 *         room for the card is dropped in favour of one that has it.
 *
 * A step whose target is missing from the page is skipped rather than shown
 * without a highlight, so the tour survives markup being moved around.
 */
const STEPS = [
  {
    target: null,
    place: 'center',
    label: 'Welcome',
    title: 'Turn any character card into one you can chat with',
    body: 'Characters on chub.ai, Character Tavern and JanitorAI are each stored in that site’s '
        + 'own format, and none of them are the format Casual Character Chat reads. This tool '
        + 'rewrites them — avatar, greetings, personality, tags and all — so you can import '
        + 'them and start talking. Nothing to install, and nothing leaves your browser.',
  },
  {
    target: '.browse-links',
    place: 'bottom',
    label: 'Step 1',
    title: 'Find someone worth talking to',
    body: 'Open any of these three sites and browse until something catches your eye, then copy '
        + 'the address out of your browser’s address bar. One character’s page works, and so '
        + 'does a whole search or category page.',
  },
  {
    target: '#url-input',
    place: 'bottom',
    label: 'Step 2',
    title: 'Paste the link in here',
    body: 'One link, or a stack of them pasted together — the tool recognises which site each '
        + 'one came from on its own. You never have to tell it, and you never have to download '
        + 'anything from those sites yourself.',
  },
  {
    target: '#convert-btn',
    place: 'right',
    label: 'Step 3',
    title: 'Convert',
    body: 'A single character lands in the results further down within a second or two. A search '
        + 'or category page instead fills the grid below with everything on it, so you can take '
        + 'your pick.',
  },
  {
    target: '#bulk-grid',
    place: 'top',
    label: 'In bulk',
    title: 'Or grab a whole page at once',
    body: 'Every card comes in as a tile with its blurb, already showing chub’s trending '
        + 'characters right now — so there is something here to try before you paste anything. '
        + 'Tick the ones you want, or hit “Select all”, and convert the lot in one click.',
  },
  {
    target: '.results-head',
    place: 'bottom',
    label: 'Step 4',
    title: 'Download, then import',
    body: 'Converted cards stay here in your browser until you clear them. Download one on its '
        + 'own, or all of them as a single file, and load it into Casual Character Chat with its '
        + '“Import Data” button. That is the last step — the character is yours to chat with.',
  },
  {
    target: '.topbar-actions',
    place: 'bottom',
    label: 'Good to know',
    title: 'Status and settings',
    body: 'The pill tells you whether the fetcher that reaches those sites is awake; it can take '
        + 'a minute to stir on a first visit. Settings holds optional platform tokens — a '
        + 'JanitorAI one matters most, as signed out that site hides every character definition.',
  },
  {
    target: null,
    place: 'center',
    label: 'Ready',
    title: 'That’s the whole loop',
    body: 'Copy a link → Convert → Download → Import. If characters you can see on a site '
        + 'never show up here, “Missing characters?” under the grid explains why and how to fix '
        + 'it. You can replay this tour any time from the Tour button up top.',
  },
];

/* ---------------- geometry constants ---------------- */

const PAD  = 10;   // breathing room between the lit rectangle and its contents
const GAP  = 14;   // between the lit rectangle and the card beside it
const EDGE = 12;   // closest the card may come to the edge of the window
const ARROW = 12;  // the little pointer, as a square before rotation

/* Below this the window is too narrow to put a card *beside* anything, so the
   card stops chasing its target and docks to one edge instead - the same shape
   a phone shows for anything of this kind. */
const SHEET_WIDTH = 720;

/* ---------------- state ---------------- */

let steps = [];          // STEPS minus any whose target is not on the page
let index = 0;
let running = false;
let frame = 0;
let lastGeometry = '';   // so the loop only writes styles when something moved
let returnFocus = null;

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------- element lookup ---------------- */

// Measured rather than merely found: a step whose target exists but is
// display:none, or has collapsed to nothing because the content that gave it
// height never arrived, has nothing to point at either.
function visible(selector) {
  if (!selector) return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
}

function currentTarget() {
  return visible(steps[index]?.target);
}

/* ---------------- placement ---------------- */

/**
 * The rectangle to light up, which is the element plus a little air.
 *
 * Height is capped at half the window. The card grid is routinely two screens
 * tall, and lighting all of it would leave nowhere to put the card and nothing
 * dark to see it against - the highlight would be the whole page. Lighting its
 * first stretch points at it just as clearly, and the step that does this is
 * scrolled to its top rather than its middle so the lit part is the part that
 * was scrolled to.
 */
function targetRect(el) {
  const r = el.getBoundingClientRect();

  // Less on a phone, where the card is docked to an edge and takes a third of
  // the screen with it: half the window for the highlight would leave the two
  // of them fighting over the same band.
  const share = innerWidth <= SHEET_WIDTH ? 0.42 : 0.5;
  const height = Math.min(r.height, innerHeight * share);
  return { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: height + PAD * 2 };
}

/**
 * Which side of the target the card goes on.
 *
 * The step's own preference is tried first and the rest are fallbacks in the
 * order that reads best - under, over, then either flank. A tall target on a
 * short window can fail all four, and then the card simply floats in the
 * middle of the dimmed page with the highlight still visible behind it.
 */
function choosePlacement(preferred, rect, popW, popH) {
  const vw = innerWidth, vh = innerHeight;
  const fits = {
    bottom: rect.top + rect.height + GAP + popH <= vh - EDGE,
    top:    rect.top - GAP - popH >= EDGE,
    right:  rect.left + rect.width + GAP + popW <= vw - EDGE,
    left:   rect.left - GAP - popW >= EDGE,
  };
  for (const side of [preferred, 'bottom', 'top', 'right', 'left']) {
    if (fits[side]) return side;
  }
  return 'center';
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

/**
 * Writes the frame: where the hole is, where the card is, where its pointer
 * points. Called every animation frame, and skips the write entirely when
 * nothing has moved since the last one - which is nearly always.
 */
function position() {
  const pop = $('tour-pop');
  const light = $('tour-spotlight');
  const arrow = $('tour-arrow');
  const el = currentTarget();
  const vw = innerWidth, vh = innerHeight;

  // A step with no target still needs the page dimmed, and a zero-sized
  // spotlight in the middle of the window does exactly that - the shadow it
  // casts is the dimming, so there is nothing special to switch on.
  const rect = el
    ? targetRect(el)
    : { top: vh / 2, left: vw / 2, width: 0, height: 0 };

  // Width first, height after: docking the card to an edge makes it wider than
  // its floating size and therefore shorter, and measuring the old height would
  // park a bottom-docked card below where it belongs for a frame.
  const sheet = vw <= SHEET_WIDTH;
  const width = sheet ? `${vw - EDGE * 2}px` : '';
  if (pop.style.width !== width) pop.style.width = width;

  const popW = pop.offsetWidth, popH = pop.offsetHeight;

  let side, left, top;

  if (sheet) {
    // Docked to whichever edge has more clear space beyond the highlight, so
    // the card never sits on top of the thing it is describing. Measured
    // against the highlight's own edges rather than its middle: a tall target
    // has plenty of middle and no room at all on one side of it.
    side = 'center';
    left = EDGE;
    if (!el) {
      top = (vh - popH) / 2;
    } else {
      const above = rect.top;
      const below = vh - (rect.top + rect.height);
      top = above > below ? EDGE : vh - popH - EDGE;
    }
  } else {
    // A step that asked for the middle of the screen, or has nothing to point
    // at, does not get to be talked out of it by choosePlacement - which knows
    // only about fitting beside things and would happily hang the card off the
    // bottom of a zero-sized point, arrow and all.
    side = (!el || steps[index].place === 'center')
      ? 'center'
      : choosePlacement(steps[index].place, rect, popW, popH);

    switch (side) {
      case 'bottom':
        top = rect.top + rect.height + GAP;
        left = clamp(rect.left + rect.width / 2 - popW / 2, EDGE, vw - popW - EDGE);
        break;
      case 'top':
        top = rect.top - GAP - popH;
        left = clamp(rect.left + rect.width / 2 - popW / 2, EDGE, vw - popW - EDGE);
        break;
      case 'right':
        left = rect.left + rect.width + GAP;
        top = clamp(rect.top + rect.height / 2 - popH / 2, EDGE, vh - popH - EDGE);
        break;
      case 'left':
        left = rect.left - GAP - popW;
        top = clamp(rect.top + rect.height / 2 - popH / 2, EDGE, vh - popH - EDGE);
        break;
      default:
        left = (vw - popW) / 2;
        top = (vh - popH) / 2;
    }
  }

  // The pointer only makes sense when the card is actually next to something.
  let arrowStyle = 'none';
  if (side !== 'center') {
    const half = ARROW / 2;
    if (side === 'bottom' || side === 'top') {
      const x = clamp(rect.left + rect.width / 2 - left, 18, popW - 18) - half;
      arrowStyle = `${side === 'bottom' ? 'up' : 'down'}|${x}|${side === 'bottom' ? -half : popH - half}`;
    } else {
      const y = clamp(rect.top + rect.height / 2 - top, 18, popH - 18) - half;
      arrowStyle = `${side === 'right' ? 'left' : 'right'}|${side === 'right' ? -half : popW - half}|${y}`;
    }
  }

  const key = [rect.top, rect.left, rect.width, rect.height, left, top, arrowStyle].join(',');
  if (key === lastGeometry) return;
  lastGeometry = key;

  light.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
  light.style.width = `${rect.width}px`;
  light.style.height = `${rect.height}px`;
  // The outline and its ring come off for a step with nothing to point at,
  // which would otherwise draw a 1.5px dot in the middle of the screen. The
  // element itself stays - it is what is dimming the page.
  light.classList.toggle('tour-no-target', !el);

  pop.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;

  if (arrowStyle === 'none') {
    arrow.hidden = true;
  } else {
    const [dir, x, y] = arrowStyle.split('|');
    arrow.hidden = false;
    arrow.className = `tour-arrow tour-arrow-${dir}`;
    arrow.style.left = `${x}px`;
    arrow.style.top = `${y}px`;
  }
}

function loop() {
  if (!running) return;
  position();
  frame = requestAnimationFrame(loop);
}

/* ---------------- scrolling ---------------- */

/**
 * Brings the step's target somewhere it can actually be looked at.
 *
 * Only scrolls when it has to: a step whose element is already comfortably on
 * screen should not make the page lurch on the way in. Small targets get
 * centred; one taller than the window is brought to its top instead, since
 * centring it would put both of its ends off screen and the highlight only
 * covers its first half anyway.
 *
 * @returns {boolean} whether a scroll was started
 */
function ensureVisible(el) {
  const r = el.getBoundingClientRect();
  const vh = innerHeight;
  const margin = Math.min(120, vh * 0.2);

  let to;
  if (r.height > vh - margin * 2) {
    if (r.top >= margin && r.top <= vh * 0.4) return false;
    to = scrollY + r.top - margin;
  } else {
    if (r.top >= margin && r.bottom <= vh - margin) return false;
    to = scrollY + r.top + r.height / 2 - vh / 2;
  }
  to = Math.max(0, to);

  // A gliding scroll shows how far the page moved and is worth having. Past a
  // couple of screens it stops being that and becomes a long blur with the
  // card waiting at the end of it - on a phone the grid alone is thousands of
  // pixels tall, and the trip from it to the results is most of the page. Those
  // simply cut.
  const far = Math.abs(to - scrollY) > vh * 2.5;
  window.scrollTo({ top: to, behavior: (far || reduceMotion()) ? 'auto' : 'smooth' });
  return true;
}

/**
 * Resolves once a smooth scroll has stopped moving the target.
 *
 * There is no reliable cross-browser event for "the smooth scroll you asked
 * for has finished" - scrollend is recent and Safari does not have it - so
 * this watches the thing that actually matters, the target's position, and
 * calls it settled after two identical frames. The timeout is the backstop for
 * a scroll that never completes because the page could not travel that far.
 */
function settle(el) {
  return new Promise(resolve => {
    let last = null, still = 0;
    const deadline = performance.now() + 700;
    const check = () => {
      const top = Math.round(el.getBoundingClientRect().top);
      still = top === last ? still + 1 : 0;
      last = top;
      if (still >= 2 || performance.now() > deadline) resolve();
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

/* ---------------- rendering a step ---------------- */

function renderDots() {
  const dots = $('tour-dots');
  dots.innerHTML = '';
  steps.forEach((_, i) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = `tour-dot${i === index ? ' on' : ''}`;
    dot.setAttribute('aria-label', `Step ${i + 1} of ${steps.length}`);
    dot.addEventListener('click', () => showStep(i));
    dots.appendChild(dot);
  });
}

/**
 * @param {number} i    step to show
 * @param {number} dir  which way the person was heading, so a step whose
 *                      target has since disappeared is stepped over rather
 *                      than shown pointing at nothing. The grid is the one
 *                      that can go: it empties itself if chub cannot be
 *                      reached, and that can land mid-tour.
 */
async function showStep(i, dir = 1) {
  let at = clamp(i, 0, steps.length - 1);
  while (steps[at].target && !visible(steps[at].target)) {
    const nextAt = at + dir;
    if (nextAt < 0 || nextAt >= steps.length) break;
    at = nextAt;
  }

  index = at;
  const step = steps[index];
  const pop = $('tour-pop');

  $('tour-label').textContent = step.label;
  $('tour-title').textContent = step.title;
  $('tour-body').textContent = step.body;
  $('tour-back').disabled = index === 0;
  $('tour-next').textContent = index === steps.length - 1 ? 'Start converting' : 'Next';
  $('tour-skip').textContent = index === steps.length - 1 ? 'Close' : 'Skip tour';
  renderDots();

  // The card is hidden for the length of the travel and reappears already in
  // place. Left visible it would fly across the page chasing a moving target,
  // which is both hard to read and the exact thing that makes these tours feel
  // cheap.
  pop.classList.remove('show');

  const el = currentTarget();
  if (el && ensureVisible(el)) await settle(el);
  if (!running) return;

  lastGeometry = '';       // force a write even if the numbers happen to match
  position();
  pop.classList.add('show');
  pop.focus({ preventScroll: true });
}

/* ---------------- open and close ---------------- */

function onKeydown(e) {
  if (!running) return;

  if (e.key === 'Escape') { e.preventDefault(); endTour(); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); next(); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); showStep(index - 1, -1); return; }

  // Tab has to be caught rather than left alone: everything behind the tour is
  // still in the document, so focus would wander off into a page the person
  // cannot currently click.
  if (e.key === 'Tab') {
    const focusable = [...$('tour-pop').querySelectorAll('button:not(:disabled)')];
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === $('tour-pop'))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault(); first.focus();
    }
  }
}

function next() {
  if (index >= steps.length - 1) endTour();
  else showStep(index + 1);
}

export function startTour() {
  if (running) return;

  steps = STEPS.filter(s => !s.target || visible(s.target));
  if (!steps.length) return;

  // A tour that runs while a modal is open would dim and point at things the
  // modal is covering.
  $('settings-modal').classList.add('hidden');

  returnFocus = document.activeElement;
  running = true;
  index = 0;
  lastGeometry = '';

  $('tour').classList.remove('hidden');
  document.addEventListener('keydown', onKeydown, true);
  frame = requestAnimationFrame(loop);
  showStep(0);
}

export async function endTour() {
  if (!running) return;
  running = false;
  cancelAnimationFrame(frame);
  document.removeEventListener('keydown', onKeydown, true);

  const tour = $('tour');
  $('tour-pop').classList.remove('show');
  tour.classList.add('hidden');

  if (returnFocus?.focus) returnFocus.focus({ preventScroll: true });
  returnFocus = null;

  // Recorded however the tour ended, skipping included: someone who closed it
  // on the second step has decided they do not need it, and being handed it
  // again on the next visit would be the tool arguing with them. The Tour
  // button is there for anyone who wants it back.
  try {
    await setSetting('tourVersion', TOUR_VERSION);
  } catch {
    // A blocked or full IndexedDB is not worth interrupting anyone over; the
    // only cost is that the tour introduces itself again next time.
  }
}

/**
 * Runs the tour on a first visit and stays out of the way afterwards.
 *
 * Called without being awaited at boot, so a slow settings read cannot hold up
 * the rest of the page.
 */
export async function maybeStartTour() {
  let seen = 0;
  try {
    seen = (await getSetting('tourVersion', 0)) || 0;
  } catch {
    return;   // if the setting cannot be read, do not risk showing it every time
  }
  if (seen >= TOUR_VERSION) return;

  // One frame of grace so the trending grid's placeholder tiles are laid out
  // before the highlight measures anything.
  requestAnimationFrame(() => startTour());
}

/* ---------------- wiring ---------------- */

$('tour-btn').addEventListener('click', () => startTour());
$('tour-next').addEventListener('click', next);
$('tour-back').addEventListener('click', () => showStep(index - 1, -1));
$('tour-skip').addEventListener('click', endTour);
$('tour-close').addEventListener('click', endTour);

// The dimmed area is a legitimate "I am done here" target - it is what people
// reach for when a card is in the way - but only outside the card itself.
$('tour-scrim').addEventListener('click', endTour);
