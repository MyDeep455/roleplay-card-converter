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
    title: 'Grab characters to chat with!',
    body: 'Here you can download countless character cards from other platforms for free. '
        + 'This tool auto-converts their data and creates a character card for you to use '
        + 'in Casual Character Chat. First conversion might take a minute, then it converts fast.',
  },
  {
    target: '.browse-links',
    place: 'bottom',
    label: 'Step 1',
    title: 'Find characters you like',
    body: 'Open any of these three sites and browse for any characters, then copy '
        + 'the address (URL) out of your browser’s address bar at the top of your screen.',
  },
  {
    target: '#url-input',
    place: 'bottom',
    label: 'Step 2',
    title: 'Paste the link in here',
    body: 'One link, or multiple links beneath each other - both are possible. '
        + 'Works for single characters as well as for a whole search page.',
  },
  {
    target: '#convert-btn',
    place: 'right',
    label: 'Step 3',
    title: 'Convert',
    body: 'Single characters are converted immediately when you click the Convert button. A search '
        + 'or category page instead fills the grid below for you to select.',
  },
  {
    target: '#bulk-grid',
    place: 'top',
    label: 'In bulk',
    title: 'You can download right away!',
    body: 'It is already showing you chub.ai’s trending characters right now — tick the ones you want and convert in one click. '
        + 'Note: Some platforms (such as chub.ai) block NSFW adult content for users outside the U.S. '
        + 'You’ll need to use a VPN (e.g. NordVPN) to see all unfiltered NSFW characters there.',
  }, 
  {
    target: '.results-head',
    place: 'bottom',
    label: 'Step 4',
    title: 'Download, then import. Finished!',
    body: 'Converted cards stay here in your browser until you clear them. '
        + 'Simply load them into Casual Character Chat with the “Import Data” button.',
  },
  {
    target: null,
    place: 'center',
    label: 'Ready',
    title: 'That’s the whole loop',
    body: 'Copy any card link → convert → download → import. '
        + 'You can replay this tour any time from the Tour button up top.',
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

/* True from the moment a step is left until the next one has been scrolled to
   and is ready to show. Nothing visible moves during that window: the light
   closes, the page travels behind an even dim, and the light reopens on the
   new target. See showStep. */
let moving = false;

/* Bumped by every showStep, so an older one that is still waiting on a fade or
   a scroll can tell it has been overtaken and bow out. */
let showToken = 0;

/* How long the card takes to fade, and how long anything waits for it. Must
   match the .tour-pop transition in the stylesheet. */
const FADE = 150;

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = ms => new Promise(r => setTimeout(r, ms));

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
 *
 * @param {number} popH  height of the card, which the highlight gives way to
 */
function targetRect(el, popH) {
  const r = el.getBoundingClientRect();
  const vh = innerHeight;

  // Less on a phone, where the card is docked to an edge and takes a third of
  // the screen with it: half the window for the highlight would leave the two
  // of them fighting over the same band.
  const share = innerWidth <= SHEET_WIDTH ? 0.42 : 0.5;
  let height = Math.min(r.height, vh * share);

  // A target long enough to be capped has been scrolled to its top and runs the
  // full width, so the only place left for the card is underneath it. Half the
  // window is a guess at how much room that needs; this is the actual figure,
  // and without it a step whose wording runs a line or two long tips over into
  // having nowhere to go and ends up floating in the middle of the lit area -
  // a highlight with the card sitting on top of the thing it is highlighting.
  //   Not below a quarter of the window, though. A card that large has not been
  // squeezed out by one line too many, and shaving the highlight down to a strip
  // to seat it would only trade one bad frame for another.
  if (height < r.height) {
    const room = vh - EDGE - GAP - popH - r.top - PAD - 2;
    if (room >= vh * 0.25) height = Math.min(height, room);
  }

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
 *
 * Nothing here is animated, deliberately. The highlight is glued to its target
 * for the same reason a label is glued to the thing it labels: the moment it is
 * allowed to ease towards where it should be, it trails behind every scroll and
 * arrives at each new step by sliding across the page like something thrown at
 * it. Steps change by closing the light and reopening it, which is showStep's
 * job; this function only ever writes where things are right now.
 */
function position() {
  const pop = $('tour-pop');
  const light = $('tour-spotlight');
  const arrow = $('tour-arrow');
  const vw = innerWidth, vh = innerHeight;

  // Between steps there is no target, whatever the step says: the light is shut
  // while the page travels.
  const el = moving ? null : currentTarget();

  // The card is measured before the highlight is sized, because a capped
  // highlight hands the card its room out of its own share and has to know how
  // much that is. Width first, height after: docking the card to an edge makes
  // it wider than its floating size and therefore shorter, and measuring the
  // old height would park a bottom-docked card below where it belongs for a
  // frame.
  const sheet = vw <= SHEET_WIDTH;
  const width = sheet ? `${vw - EDGE * 2}px` : '';
  if (pop.style.width !== width) pop.style.width = width;

  const popW = pop.offsetWidth, popH = pop.offsetHeight;

  // A step with no target still needs the page dimmed, and a zero-sized
  // spotlight in the middle of the window does exactly that - the shadow it
  // casts is the dimming, so there is nothing special to switch on.
  const rect = el
    ? targetRect(el, popH)
    : { top: vh / 2, left: vw / 2, width: 0, height: 0 };

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

  const key = [rect.top, rect.left, rect.width, rect.height, left, top, arrowStyle, moving].join(',');
  if (key === lastGeometry) return;
  lastGeometry = key;

  light.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
  light.style.width = `${rect.width}px`;
  light.style.height = `${rect.height}px`;
  // The outline and its ring come off for a step with nothing to point at,
  // which would otherwise draw a 1.5px dot in the middle of the screen. The
  // element itself stays - it is what is dimming the page.
  light.classList.toggle('tour-no-target', !el);

  // The card holds its ground until the new step is ready for it. Moving it
  // while it is fading out is the one thing here that would still read as a
  // slide, since the eye follows a half-visible box perfectly well.
  if (moving) return;

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
 * This decides when the highlight is allowed to open, so calling it a frame
 * early is exactly the thing that makes one look like it is being dragged
 * along behind the page.
 *
 * scrollend says so precisely and is answered first where it exists. It cannot
 * be relied on alone: a scrollTo that asks for the position the page is
 * already at fires nothing at all, and the step would sit dark waiting for an
 * event that is never coming.
 *
 * So the fallback watches the thing that actually matters - where the target
 * is - and calls it settled after three frames in the identical spot.
 * Unrounded, deliberately: the tail of an eased scroll creeps along in
 * fractions of a pixel, which rounding would report as having already stopped.
 */
function settle(el) {
  return new Promise(resolve => {
    let done = false, last = null, still = 0;
    const deadline = performance.now() + 900;

    const finish = () => {
      if (done) return;
      done = true;
      document.removeEventListener('scrollend', finish);
      resolve();
    };
    document.addEventListener('scrollend', finish);

    const check = () => {
      if (done) return;
      const top = el.getBoundingClientRect().top;
      still = top === last ? still + 1 : 0;
      last = top;
      if (still >= 2 || performance.now() > deadline) finish();
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
  // Clicking Next twice quickly, or holding an arrow key, starts a second run
  // of this while the first is still waiting on a fade or a scroll. Only the
  // newest may write anything; the others notice they have been overtaken at
  // their next await and stop.
  const token = ++showToken;
  const pop = $('tour-pop');

  let at = clamp(i, 0, steps.length - 1);
  while (steps[at].target && !visible(steps[at].target)) {
    const nextAt = at + dir;
    if (nextAt < 0 || nextAt >= steps.length) break;
    at = nextAt;
  }

  // Lights down. The card fades where it stands and the highlight shuts, so
  // the page can travel under an even dim with nothing sliding across it.
  const wasShowing = pop.classList.contains('show');
  moving = true;
  index = at;
  pop.classList.remove('show');
  lastGeometry = '';
  position();

  if (wasShowing) {
    await wait(reduceMotion() ? 60 : FADE);
    if (token !== showToken || !running) return;
  }

  // Written while the card is invisible: the new step's words should never
  // appear in the old step's place.
  const step = steps[index];
  $('tour-label').textContent = step.label;
  $('tour-title').textContent = step.title;
  $('tour-body').textContent = step.body;
  $('tour-back').disabled = index === 0;
  $('tour-next').textContent = index === steps.length - 1 ? 'Start now!' : 'Next';
  $('tour-skip').textContent = index === steps.length - 1 ? 'Close' : 'Skip tour';
  renderDots();

  const el = currentTarget();
  if (el && ensureVisible(el)) {
    await settle(el);
    if (token !== showToken || !running) return;
  }

  // Lights up, on the new target, both at once.
  moving = false;
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
  moving = false;
  lastGeometry = '';

  $('tour').classList.remove('hidden');
  document.addEventListener('keydown', onKeydown, true);
  frame = requestAnimationFrame(loop);
  showStep(0);
}

export async function endTour() {
  if (!running) return;
  running = false;
  moving = false;
  showToken++;             // strand any step still waiting to appear
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
