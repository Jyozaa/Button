(() => {
'use strict';

const btn = document.getElementById('btn');
const label = document.getElementById('label');
const wrap = document.getElementById('btn-wrap');
const stage = document.getElementById('stage');
const ring = document.getElementById('ring');
const ringFg = document.getElementById('ring-fg');

const HOLD_MS = 1000;
const DOUBLE_WINDOW = 450;
const DRAG_MIN = 28;
const CIRC = 2 * Math.PI * 54;

/* ---------------- state ---------------- */
let count = 0;
let size = 100;
let pos = { x: 0, y: 0 };
let rot = 0;
let lastId = null;
let lastUsed = Object.create(null);
let stillLeft = 0;
let challenge = null; // {type:'hold'|'double'|'hover'|'drag'|'multiples', ...}
let avoid = null;     // {dodgesLeft, nearMiss}
let followRaf = 0;
let followUntil = 0;
let driftRaf = 0;
let hoverGrow = null; // {base}
let shell = null; // {items:[{el,x,y}], correct:Element, token, d, resolved} — correct lives ONLY here
let shellToken = 0;
let suppressClick = false;
let lastCursor = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
let darkFlashToken = 0;

const reducedQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const isCoarse = window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
function reduced() { return !!(reducedQuery && reducedQuery.matches); }

/* ---------------- tiny helpers ---------------- */
function rand(a, b) { return a + Math.random() * (b - a); }
function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
function choice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function bounds(s) {
  const mx = Math.max(0, window.innerWidth / 2 - s / 2 - 10);
  const my = Math.max(0, window.innerHeight / 2 - s / 2 - 10);
  return { mx, my };
}
function clampPos(x, y, s) {
  const b = bounds(s == null ? size : s);
  return { x: clamp(x, -b.mx, b.mx), y: clamp(y, -b.my, b.my) };
}
function btnCenter() {
  return { x: window.innerWidth / 2 + pos.x, y: window.innerHeight / 2 + pos.y };
}
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function setLabel(t) {
  label.textContent = t;
  btn.setAttribute('aria-label', t === '' ? 'Button' : t);
}
function setSize(d) {
  size = d;
  btn.style.width = d + 'px';
  btn.style.height = d + 'px';
  label.style.fontSize = clamp(d * 0.17, 11, 26) + 'px';
  ring.style.width = (d + 22) + 'px';
  ring.style.height = (d + 22) + 'px';
  btn.classList.toggle('tiny-hit', d < 34);
  setPos(pos.x, pos.y); // re-clamp: a bigger circle must stay reachable
}
function setPos(x, y) {
  const c = clampPos(x, y, size);
  pos.x = c.x; pos.y = c.y;
  wrap.style.transform = 'translate(' + pos.x + 'px,' + pos.y + 'px)';
}
function setRot(r) {
  rot = r;
  btn.style.transform = r ? 'rotate(' + r + 'deg)' : '';
}
function moveBy(dx, dy) { setPos(pos.x + dx, pos.y + dy); }
function randomSpot(minDistFrom, minDist) {
  const b = bounds(size);
  for (let i = 0; i < 24; i++) {
    const p = { x: rand(-b.mx, b.mx), y: rand(-b.my, b.my) };
    if (!minDistFrom || dist(p, { x: pos.x, y: pos.y }) >= (minDist || 0)) return p;
  }
  return { x: rand(-b.mx, b.mx), y: rand(-b.my, b.my) };
}
function cancelWrapAnimations() {
  try { if (wrap.getAnimations) wrap.getAnimations().forEach(a => { try { a.cancel(); } catch (e) {} }); } catch (e) {}
  try { if (btn.getAnimations) btn.getAnimations().forEach(a => { try { a.cancel(); } catch (e) {} }); } catch (e) {}
}
function stopFollow() {
  if (followRaf) { cancelAnimationFrame(followRaf); followRaf = 0; }
  followUntil = 0;
}
function stopDrift() {
  if (driftRaf) { cancelAnimationFrame(driftRaf); driftRaf = 0; }
}

const TRANSIENT = ['hollow', 'outline-only', 'glow', 'halo', 'pulse', 'blurred', 'ghost', 'shadow-double'];
function clearTransient() {
  TRANSIENT.forEach(c => btn.classList.remove(c));
  label.style.transform = '';
  darkFlashToken++;
  document.body.classList.remove('dark');
  ring.classList.remove('visible');
}
function fullReset() {
  stopFollow(); stopDrift();
  endShell();
  challenge = null; avoid = null; hoverGrow = null; stillLeft = 0;
  holdActive = false;
  clearTransient();
  cancelWrapAnimations();
  setSize(100);
  setRot(0);
  setPos(0, 0);
  setLabel('Click');
}

/* ---------------- audio (Web Audio, subtle) ---------------- */
let muted = false;
try { muted = localStorage.getItem('the-button-muted') === '1'; } catch (e) {}
let actx = null, master = null;
function ensureAudio() {
  try {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      actx = new AC();
      master = actx.createGain();
      master.gain.value = 0.9;
      master.connect(actx.destination);
    }
    if (actx.state === 'suspended') actx.resume();
  } catch (e) {}
}
function tone(o) {
  if (muted || !actx || !master) return;
  try {
    const f = o.f || 520, f2 = o.f2, d = o.d || 0.07;
    const type = o.type || 'sine', g = o.g == null ? 0.05 : o.g;
    const delay = o.delay || 0;
    const t0 = actx.currentTime + delay;
    const osc = actx.createOscillator();
    const gn = actx.createGain();
    osc.type = type;
    let freq = f;
    let pan = o.pan;
    if (count > 40) { // slightly stranger late
      freq = f * (1 + rand(-0.03, 0.03));
      if (pan === undefined && Math.random() < 0.5) pan = rand(-0.5, 0.5);
    }
    osc.frequency.setValueAtTime(Math.max(30, freq), t0);
    if (f2) osc.frequency.exponentialRampToValueAtTime(Math.max(30, f2), t0 + d);
    let out = gn;
    if (pan !== undefined && actx.createStereoPanner) {
      const p = actx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      gn.connect(p); p.connect(master);
    } else {
      gn.connect(master);
    }
    gn.gain.setValueAtTime(0.0001, t0);
    gn.gain.exponentialRampToValueAtTime(Math.max(0.0002, g), t0 + 0.01);
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    osc.connect(gn);
    osc.start(t0); osc.stop(t0 + d + 0.05);
  } catch (e) {}
}
const sTick = () => tone({ f: rand(460, 580), d: 0.055, g: 0.05 });
const sMove = (pan) => tone({ f: rand(480, 640), d: 0.06, g: 0.045, pan });
const sGrow = () => tone({ f: 300, f2: 540, d: 0.18, g: 0.045 });
const sShrink = () => tone({ f: 540, f2: 300, d: 0.18, g: 0.045 });
const sDodge = () => tone({ f: rand(820, 920), d: 0.06, g: 0.04 });
const sDup = () => { tone({ f: 520, d: 0.07 }); tone({ f: 660, d: 0.07, delay: 0.07 }); tone({ f: 780, d: 0.09, delay: 0.14 }); };
const sResolve = () => { tone({ f: 440, d: 0.12, type: 'triangle', g: 0.05 }); tone({ f: 660, d: 0.16, type: 'triangle', g: 0.05, delay: 0.1 }); };
function toggleMute() {
  muted = !muted;
  try { localStorage.setItem('the-button-muted', muted ? '1' : '0'); } catch (e) {}
}

/* ---------------- labels (dry, 1-3 words) ---------------- */
const L_SUBTLE = ['Again?', 'Sure?', 'Okay.'];
const L_MOVE = ['Over here', 'Again', 'Missed me', 'This way'];
const L_AVOID = ['Catch me', 'No', 'Almost', 'Too slow'];
const L_LATE = ['Still here?', 'Really?', '...', '?', 'Okay.', 'Hmm.'];

/* ---------------- behaviour system ----------------
   Each entry: id, min, max (null = no upper bound),
   w (weight), cd (cooldown in interactions). */
const BEHAVIOURS = [
  { id: 's1-text', min: 1, max: 6, w: 10, cd: 1, run: b1Text },
  { id: 's1-tilt', min: 1, max: 8, w: 6, cd: 2, run: b1Tilt },
  { id: 's1-shade', min: 2, max: 10, w: 5, cd: 2, run: b1Shade },
  { id: 'm-nudge', min: 5, max: 18, w: 8, cd: 2, run: mNudge },
  { id: 'm-hop', min: 5, max: 18, w: 6, cd: 2, run: mHop },
  { id: 'm-nearby', min: 5, max: 25, w: 7, cd: 2, run: mNearby },
  { id: 'm-drift', min: 6, max: 30, w: 4, cd: 4, run: mDrift },
  { id: 'm-spin', min: 5, max: 22, w: 5, cd: 3, run: mSpin },
  { id: 'm-boomerang', min: 6, max: 20, w: 5, cd: 4, run: mBoomerang },
  { id: 'z-grow140', min: 8, max: 24, w: 5, cd: 3, run: zGrow140 },
  { id: 'z-shrink70', min: 8, max: 24, w: 6, cd: 3, run: zShrink70 },
  { id: 'z-huge240', min: 10, max: 32, w: 1.5, cd: 6, run: zHuge },
  { id: 'z-hover-expand', min: 10, max: 28, w: 2.5, cd: 5, run: zHoverExpand },
  { id: 'z-shrink-steps', min: 12, max: 26, w: 4, cd: 4, run: zShrinkSteps },
  { id: 'a-hollow', min: 12, max: 34, w: 6, cd: 4, run: () => aLook('hollow') },
  { id: 'a-outline', min: 12, max: 38, w: 5, cd: 4, run: () => aLook('outline-only') },
  { id: 'a-invert', min: 14, max: 55, w: 2, cd: 8, run: aInvert },
  { id: 'a-glow', min: 14, max: 42, w: 5, cd: 4, run: () => aLook('glow') },
  { id: 'a-halo', min: 16, max: 50, w: 1.5, cd: 8, run: () => aLook('halo', '...') },
  { id: 'a-textspin', min: 14, max: 38, w: 4, cd: 5, run: aTextSpin },
  { id: 'a-pulse', min: 14, max: 38, w: 4, cd: 5, run: () => aLook('pulse') },
  { id: 'a-blur', min: 14, max: 38, w: 3, cd: 6, run: () => aLook('blurred', '...') },
  { id: 'a-ghost', min: 15, max: 42, w: 2, cd: 7, run: () => aLook('ghost', '...') },
  { id: 'a-shadow', min: 15, max: 38, w: 4, cd: 5, run: () => aLook('shadow-double') },
  { id: 'v-dodge2', min: 18, max: 55, w: 9, cd: 4, run: vDodge },
  { id: 'v-teleport', min: 18, max: 60, w: 5, cd: 5, run: vTeleport },
  { id: 'v-nearmiss', min: 20, max: 60, w: 4, cd: 6, run: vNearMiss },
  { id: 'v-follow', min: 22, max: 65, w: 4, cd: 7, run: vFollow },
  { id: 'v-approach', min: 22, max: 65, w: 1.5, cd: 9, run: vApproach },
  { id: 'x-shell', min: 25, max: 75, w: 9, cd: 5, run: xShell },
  { id: 'c-hold', min: 30, max: 90, w: 4, cd: 6, run: cHold },
  { id: 'c-double', min: 30, max: 90, w: 4, cd: 5, run: cDouble },
  { id: 'c-hover', min: 32, max: 90, w: 3, cd: 6, run: cHover },
  { id: 'c-drag', min: 35, max: 90, w: 2, cd: 8, run: cDrag },
  { id: 'p-fall', min: 40, max: null, w: 4, cd: 4, run: pFall },
  { id: 'p-roll', min: 40, max: null, w: 3, cd: 6, run: pRoll },
  { id: 'p-gravity', min: 40, max: null, w: 3, cd: 5, run: pGravity },
  { id: 'p-overshoot', min: 40, max: null, w: 4, cd: 4, run: pOvershoot },
  { id: 'p-swing', min: 42, max: null, w: 1.5, cd: 8, run: pSwing },
  { id: 'p-ricochet', min: 42, max: null, w: 2, cd: 7, run: pRicochet },
  { id: 'e-full', min: 45, max: null, w: 0.8, cd: 10, run: eFull },
  { id: 'e-tiny', min: 45, max: null, w: 1.2, cd: 10, run: eTiny },
  { id: 'e-offscreen', min: 48, max: null, w: 0.7, cd: 12, run: eOffscreen },
  { id: 'e-darkflash', min: 45, max: null, w: 1.5, cd: 10, run: eDarkFlash },
  { id: 'e-under-cursor', min: 46, max: null, w: 1, cd: 10, run: eUnderCursor },
  { id: 'e-stuck', min: 45, max: null, w: 2, cd: 8, run: eStuck },
  { id: 'e-novtext', min: 40, max: null, w: 3, cd: 6, run: eNoText },
  { id: 'e-outline-flash', min: 44, max: null, w: 2, cd: 8, run: () => aLook('outline-only', '?') },
  { id: 'e-split', min: 50, max: null, w: 0.8, cd: 14, run: eSplit },
  { id: 'e-still', min: 45, max: null, w: 2, cd: 10, run: eStill },
  { id: 'e-reset', min: 30, max: null, w: 1.6, cd: 12, run: eReset },
];
const CALM_IDS = ['s1-text', 's1-tilt', 's1-shade', 'e-novtext'];
const byId = Object.create(null);
BEHAVIOURS.forEach(b => { byId[b.id] = b; });

function eligible(b) {
  if (count < b.min) return false;
  if (b.max != null && count > b.max) return false;
  if (b.id === lastId) return false;
  const lu = lastUsed[b.id];
  if (lu != null && count - lu < b.cd) return false;
  if (b.id === 'c-hover' && isCoarse && !window.matchMedia('(pointer: fine)').matches) {
    // touch-only devices: hover challenge would be confusing; allow rarely anyway via touch fallback
    if (Math.random() < 0.7) return false;
  }
  if (shellActive()) return false;
  // dodging a giant circle is silly: no avoidance while enlarged
  if (size > 130 && (b.id === 'v-dodge2' || b.id === 'v-teleport' || b.id === 'v-nearmiss' || b.id === 'v-follow' || b.id === 'v-approach')) return false;
  return true;
}
function pickBehaviour() {
  let pool;
  if (stillLeft > 0) {
    pool = BEHAVIOURS.filter(b => CALM_IDS.includes(b.id) && b.id !== lastId);
    if (!pool.length) pool = BEHAVIOURS.filter(b => CALM_IDS.includes(b.id));
  } else {
    pool = BEHAVIOURS.filter(eligible);
  }
  if (!pool.length) pool = [byId['s1-text']];
  let total = 0;
  pool.forEach(b => { total += b.w; });
  let r = Math.random() * total;
  for (const b of pool) { r -= b.w; if (r <= 0) return b; }
  return pool[pool.length - 1];
}

/* ---------------- behaviour implementations ---------------- */
function pulseScale() {
  try {
    if (reduced()) return;
    btn.animate(
      [{ transform: (btn.style.transform || '') + ' scale(1)' }, { transform: (btn.style.transform || '') + ' scale(1.05)' }, { transform: (btn.style.transform || '') + ' scale(1)' }],
      { duration: 180, easing: 'ease-out' }
    );
  } catch (e) {}
}

// stage 1
function b1Text() {
  clearTransient();
  const seq = ['Again?', 'Sure?', 'Okay.'];
  let t;
  if (count <= 3) t = seq[(count - 1) % seq.length];
  else t = choice(L_SUBTLE.concat(['Click']));
  setLabel(t);
  setRot(rot + rand(-2, 2));
  pulseScale();
  sTick();
}
function b1Tilt() {
  clearTransient();
  setRot(clamp(rot + rand(-8, 8), -14, 14));
  if (Math.random() < 0.4) setLabel(choice(L_SUBTLE));
  sTick();
}
function b1Shade() {
  clearTransient();
  const shades = ['#161616', '#1e1e1e', '#101010', '#242424'];
  btn.style.backgroundColor = choice(shades);
  setTimeout(() => { if (lastId === 's1-shade') btn.style.backgroundColor = ''; }, 4000);
  if (Math.random() < 0.3) setLabel(choice(L_SUBTLE));
  sTick();
}

// stage 2
function mNudge() {
  clearTransient();
  const dir = Math.random() < 0.5 ? -1 : 1;
  const d = reduced() ? rand(8, 16) : rand(50, 72);
  moveBy(dir * d, rand(-10, 10));
  setRot(rot + rand(-6, 6));
  setLabel(choice(L_MOVE));
  sMove(dir * 0.4);
}
function mHop() {
  clearTransient();
  moveBy(rand(-16, 16), reduced() ? rand(-24, -12) : rand(-70, -50));
  setLabel(choice(['Again', 'Over here']));
  sMove(0);
}
function mNearby() {
  clearTransient();
  const p = randomSpot(pos, reduced() ? 10 : 70);
  const range = reduced() ? 26 : 120;
  setPos(pos.x + clamp(p.x - pos.x, -range, range), pos.y + clamp(p.y - pos.y, -range, range));
  setRot(rot + rand(-10, 10));
  setLabel(choice(L_MOVE));
  sMove(rand(-0.3, 0.3));
}
function mDrift() {
  clearTransient();
  const p = randomSpot(pos, 40);
  setPos((pos.x + p.x) / 2, (pos.y + p.y) / 2);
  setLabel(choice(['This way', 'Again']));
  sMove(0);
  if (reduced()) return;
  stopDrift();
  const t0 = performance.now(), dur = 2400;
  const ox = pos.x, oy = pos.y;
  const step = (t) => {
    const k = (t - t0) / dur;
    if (k >= 1 || stillLeft > 0) { driftRaf = 0; return; }
    setPos(ox + Math.sin(k * 5) * 12, oy + Math.cos(k * 4) * 10);
    driftRaf = requestAnimationFrame(step);
  };
  driftRaf = requestAnimationFrame(step);
}
function mSpin() {
  clearTransient();
  setRot(rot + (Math.random() < 0.5 ? -1 : 1) * rand(15, 45));
  sMove(rand(-0.2, 0.2));
}
function mBoomerang() {
  clearTransient();
  const ox = pos.x, oy = pos.y;
  const dx = reduced() ? rand(-16, 16) : rand(-90, 90);
  const dy = reduced() ? rand(-12, 12) : rand(-70, -30);
  setPos(ox + dx, oy + dy);
  setLabel(choice(['Missed me', 'Again']));
  sMove(0);
  setTimeout(() => {
    if (challenge || shellActive()) return;
    setPos(ox, oy);
  }, reduced() ? 250 : 480);
}

// stage 3
function zGrow140() { clearTransient(); setSize(140); setLabel(choice(['Bigger', 'Bigger?'])); sGrow(); }
function zShrink70() { clearTransient(); setSize(70); setLabel(choice(['Smaller?', 'Enough?'])); sShrink(); }
function zHuge() {
  clearTransient();
  setSize(Math.min(240, Math.min(window.innerWidth, window.innerHeight) * 0.7));
  setLabel(choice(['Bigger?', 'Enough?']));
  sGrow();
}
function zHoverExpand() {
  clearTransient();
  hoverGrow = { base: size };
  setSize(Math.min(size + 18, 220));
  setLabel('Bigger?');
  sGrow();
  if (isCoarse) hoverGrow = null;
}
function zShrinkSteps() {
  clearTransient();
  setSize(Math.max(40, size - 20));
  setLabel('Smaller?');
  sShrink();
}

// stage 4
function aLook(cls, text) {
  clearTransient();
  btn.classList.add(cls);
  if (cls === 'outline-only' || cls === 'hollow') btn.style.backgroundColor = '';
  if (text !== undefined) setLabel(text);
  else if (Math.random() < 0.35) setLabel(choice(['...', 'Okay.', label.textContent]));
  sTick();
}
function aInvert() {
  clearTransient();
  document.body.classList.add('dark');
  setLabel(choice(['Okay.', '...']));
  tone({ f: 330, d: 0.1, g: 0.05 });
}
function aTextSpin() {
  clearTransient();
  label.style.transform = 'rotate(' + choice([90, 180, -90]) + 'deg)';
  sTick();
}

// stage 5
function dodge(fromX, fromY) {
  const c = btnCenter();
  const b = bounds(size);
  let best = null, bestD = -1;
  for (let i = 0; i < 20; i++) {
    const p = { x: rand(-b.mx, b.mx), y: rand(-b.my, b.my) };
    const px = window.innerWidth / 2 + p.x, py = window.innerHeight / 2 + p.y;
    const d = Math.hypot(px - fromX, py - fromY);
    if (d > bestD) { bestD = d; best = p; }
  }
  if (best) {
    cancelWrapAnimations();
    setPos(best.x, best.y);
  }
  setLabel(choice(L_AVOID));
  sDodge();
}
function vDodge() {
  clearTransient();
  moveBy(reduced() ? rand(-14, 14) : (Math.random() < 0.5 ? -46 : 46), rand(-8, 8));
  avoid = { dodgesLeft: 2, nearMiss: false };
  setLabel('Catch me');
  sDodge();
}
function vTeleport() {
  clearTransient();
  cancelWrapAnimations();
  const p = randomSpot(pos, reduced() ? 20 : 150);
  setPos(p.x, p.y);
  setLabel(choice(['Almost', 'Too slow', 'No']));
  sDodge();
}
function vNearMiss() {
  clearTransient();
  avoid = { dodgesLeft: 2, nearMiss: true };
  moveBy(rand(-20, 20), rand(-14, 14));
  setLabel('Almost');
  sTick();
}
function vFollow() {
  clearTransient();
  setLabel('Catch me');
  sDodge();
  if (reduced()) { const p = randomSpot(pos, 30); setPos(p.x, p.y); return; }
  stopFollow();
  followUntil = performance.now() + 4000;
  const loop = () => {
    if (performance.now() > followUntil || challenge) { followRaf = 0; return; }
    const c = btnCenter();
    const dx = lastCursor.x - c.x, dy = lastCursor.y - c.y;
    const d = Math.hypot(dx, dy) || 1;
    const want = 130; // keep a playful distance
    const tx = lastCursor.x - (dx / d) * want - window.innerWidth / 2;
    const ty = lastCursor.y - (dy / d) * want - window.innerHeight / 2;
    setPos(pos.x + (tx - pos.x) * 0.12, pos.y + (ty - pos.y) * 0.12);
    followRaf = requestAnimationFrame(loop);
  };
  followRaf = requestAnimationFrame(loop);
}
function vApproach() {
  clearTransient();
  setLabel(choice(['Too slow', 'Almost']));
  sTick();
  const cx = lastCursor.x - window.innerWidth / 2, cy = lastCursor.y - window.innerHeight / 2;
  setTimeout(() => {
    if (challenge || shellActive()) return;
    cancelWrapAnimations();
    setPos(pos.x + (cx - pos.x) * 0.6, pos.y + (cy - pos.y) * 0.6);
    sMove(0);
  }, reduced() ? 200 : 650);
}

// stage 6 — shell game. Every visible circle shares one CSS class and identical
// markup; the correct circle exists only as a JS reference, with no DOM trace.
function shellActive() { return !!(shell && shell.items.length); }
function shuffled(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}
function shellDiameter() {
  // One uniform diameter for every circle, measured once so the text fits.
  // Never computed per-circle, so all circles stay identical.
  // Returns {d, min}: min is the smallest diameter that still fits the text.
  let w = 0;
  try {
    const probe = document.createElement('span');
    probe.textContent = 'Which one?';
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
      'font-size:15px;font-weight:400;letter-spacing:0.01em;';
    document.body.appendChild(probe);
    w = probe.offsetWidth || 0;
    probe.remove();
  } catch (e) { w = 0; }
  if (!w) w = 84; // no-layout fallback (generous estimate of the 15px text width)
  return { d: Math.max(128, Math.ceil(w + 56)), min: Math.ceil(w + 32) };
}
function shellCapacity(d) {
  const m = d / 2 + 14; // edge margin
  const hx = window.innerWidth / 2 - m;
  const hy = window.innerHeight / 2 - m;
  if (hx <= 0 || hy <= 0) return 0;
  return (Math.floor((hx * 2) / (d + 18)) + 1) * (Math.floor((hy * 2) / (d + 18)) + 1);
}
function shellSpots(n, d) {
  // Center-offset coordinates (same system as the main button).
  const m = d / 2 + 14; // edge margin
  const hx = Math.max(0, window.innerWidth / 2 - m);
  const hy = Math.max(0, window.innerHeight / 2 - m);
  const cell = d + 18; // minimum center distance: circles never overlap
  const spots = [];
  const cap = (Math.floor((hx * 2) / cell) + 1) * (Math.floor((hy * 2) / cell) + 1);
  if (cap >= n && hx > 0 && hy > 0) {
    // shuffled grid cells: guaranteed spacing, no consistent pattern after shuffling
    const cols = Math.floor((hx * 2) / cell) + 1;
    const rows = Math.floor((hy * 2) / cell) + 1;
    const ox = (hx * 2 - (cols - 1) * cell) / 2;
    const oy = (hy * 2 - (rows - 1) * cell) / 2;
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cells.push({ x: -hx + ox + c * cell, y: -hy + oy + r * cell });
      }
    }
    return shuffled(cells).slice(0, n);
  }
  // tiny-viewport fallback: best-effort spread
  for (let i = 0; i < n; i++) {
    let best = { x: 0, y: 0 }, bestScore = -1;
    for (let t = 0; t < 400; t++) {
      const p = { x: hx ? rand(-hx, hx) : 0, y: hy ? rand(-hy, hy) : 0 };
      let score = Infinity;
      for (const q of spots) score = Math.min(score, dist(p, q));
      if (score >= cell) { best = p; break; }
      if (score > bestScore) { bestScore = score; best = p; }
    }
    spots.push(best);
  }
  return spots;
}
function placeShellEl(el, x, y, d) {
  el.style.left = (window.innerWidth / 2 + x - d / 2) + 'px';
  el.style.top = (window.innerHeight / 2 + y - d / 2) + 'px';
}
function shellShuffle() {
  if (!shellActive() || shell.resolved) return;
  const pts = shuffled(shell.items.map(it => ({ x: it.x, y: it.y })));
  shell.items.forEach((it, i) => {
    it.x = pts[i].x; it.y = pts[i].y;
    placeShellEl(it.el, it.x, it.y, shell.d);
  });
}
function endShell() {
  if (shell) {
    shell.items.forEach(it => { try { it.el.remove(); } catch (e) {} });
    shell = null;
  }
  try { stage.querySelectorAll('.shell').forEach(el => { try { el.remove(); } catch (e) {} }); } catch (e) {}
  wrap.style.visibility = '';
  wrap.removeAttribute('aria-hidden');
}
function xShell() {
  clearTransient();
  endShell();
  stopFollow(); stopDrift();
  avoid = null; hoverGrow = null;
  const n = randInt(4, 7);
  // uniform diameter, shrunk only as far as needed so all n fit without overlap
  let dd = shellDiameter();
  let d = dd.d;
  while (d > dd.min && shellCapacity(d) < n) d -= 4;
  // the normal button sits out: identical <button> elements take over
  wrap.style.visibility = 'hidden';
  wrap.setAttribute('aria-hidden', 'true');
  const token = ++shellToken;
  const pts = shuffled(shellSpots(n, d));
  const items = [];
  for (let i = 0; i < n; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'shell';
    b.setAttribute('aria-label', 'Which one?');
    const s = document.createElement('span');
    s.textContent = 'Which one?';
    b.appendChild(s);
    b.style.width = d + 'px';
    b.style.height = d + 'px';
    placeShellEl(b, pts[i].x, pts[i].y, d);
    b.addEventListener('click', (ev) => { ev.stopPropagation(); onShellClick(b); });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    stage.appendChild(b);
    items.push({ el: b, x: pts[i].x, y: pts[i].y });
  }
  shell = { items, correct: choice(items).el, token, d, resolved: false };
  challenge = { type: 'multiples' };
  sDup();
  if (!reduced()) {
    // gentle opening shuffle; every circle moves through the same transition
    const rounds = randInt(2, 3);
    for (let r = 1; r <= rounds; r++) {
      setTimeout(() => { if (shell && shell.token === token) shellShuffle(); }, r * 360);
    }
  }
}
function onShellClick(el) {
  if (!shellActive() || shell.resolved) return;
  if (!challenge || challenge.type !== 'multiples') return;
  if (el.classList.contains('shell-gone')) return;
  ensureAudio();
  if (el === shell.correct) {
    shell.resolved = true;
    sResolve();
    const tok = shell.token;
    const kept = shell.items.find(it => it.el === el);
    shell.items.forEach(it => { if (it.el !== el) it.el.classList.add('shell-gone'); });
    setTimeout(() => {
      if (!shell || shell.token !== tok || !kept) return;
      const cx = kept.x, cy = kept.y;
      endShell();
      setPos(cx, cy); // the real circle remains where it was...
      try { btn.focus({ preventScroll: true }); } catch (e) {}
      advance(true); // ...then the next strange behaviour continues
    }, reduced() ? 120 : 420);
  } else {
    sDodge(); // soft pip only: no reveal, no indicators
    el.classList.add('shell-gone');
    const tok = shell.token;
    setTimeout(() => {
      if (!shell || shell.token !== tok || shell.resolved) return;
      try { el.remove(); } catch (e) {}
      shell.items = shell.items.filter(it => it.el !== el);
      if (shell.items.length > 1 && Math.random() < 0.5) shellShuffle();
    }, reduced() ? 120 : 320);
  }
}

// stage 7
let holdActive = false, holdRaf = 0, holdStart = 0;
function ringProgress(k) {
  ringFg.style.strokeDasharray = String(CIRC);
  ringFg.style.strokeDashoffset = String(CIRC * (1 - clamp(k, 0, 1)));
}
function cHold() {
  clearTransient();
  setLabel('Hold');
  challenge = { type: 'hold' };
  ring.classList.add('visible');
  ringProgress(0);
  sTick();
}
function startHold() {
  if (!challenge || challenge.type !== 'hold' || holdActive) return;
  ensureAudio();
  holdActive = true;
  holdStart = performance.now();
  const step = (t) => {
    if (!holdActive || !challenge || challenge.type !== 'hold') { holdRaf = 0; return; }
    const k = (t - holdStart) / HOLD_MS;
    ringProgress(k);
    if (k >= 1) { completeHold(); return; }
    holdRaf = requestAnimationFrame(step);
  };
  holdRaf = requestAnimationFrame(step);
}
function cancelHold() {
  if (!holdActive) return;
  holdActive = false;
  if (holdRaf) cancelAnimationFrame(holdRaf);
  holdRaf = 0;
  if (challenge && challenge.type === 'hold') ringProgress(0);
}
function completeHold() {
  holdActive = false;
  if (holdRaf) cancelAnimationFrame(holdRaf);
  holdRaf = 0;
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 50);
  ring.classList.remove('visible');
  sResolve();
  advance(true);
}
function cDouble() {
  clearTransient();
  setLabel('Again');
  challenge = { type: 'double', firstAt: 0, timer: 0 };
  sTick();
}
function doublePress() {
  const now = Date.now();
  const ch = challenge;
  if (ch.firstAt && now - ch.firstAt <= DOUBLE_WINDOW) {
    if (ch.timer) clearTimeout(ch.timer);
    tone({ f: 700, d: 0.08, g: 0.05 });
    challenge = null;
    advance(true);
    return true;
  }
  ch.firstAt = now;
  sTick();
  pulseScale();
  if (ch.timer) clearTimeout(ch.timer);
  ch.timer = setTimeout(() => { if (challenge === ch) ch.firstAt = 0; }, DOUBLE_WINDOW + 60);
  return false;
}
function cHover() {
  clearTransient();
  setLabel('...');
  challenge = { type: 'hover' };
  sTick();
}
function completeHover() {
  if (!challenge || challenge.type !== 'hover') return;
  challenge = null;
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 60);
  sTick();
  advance(true);
}
let dragState = null;
function cDrag() {
  clearTransient();
  setLabel('Pull');
  challenge = { type: 'drag', presses: [] };
  dragState = null;
  try { btn.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(0)' }], { duration: 320 }); } catch (e) {}
  sTick();
}
function completeDrag() {
  if (!challenge || challenge.type !== 'drag') return;
  try { if (dragState && dragState.id != null && btn.hasPointerCapture && btn.hasPointerCapture(dragState.id)) btn.releasePointerCapture(dragState.id); } catch (e) {}
  dragState = null;
  tone({ f: 620, d: 0.09, g: 0.05 });
  advance(true);
}

// stage 8
function pFall() {
  clearTransient();
  setLabel(choice(['...', '?']));
  tone({ f: 500, f2: 220, d: 0.3, g: 0.045 });
  const b = bounds(size);
  const floor = b.my;
  if (reduced()) { setPos(pos.x, floor); return; }
  cancelWrapAnimations();
  const sx = pos.x, sy = pos.y;
  try {
    const a = wrap.animate([
      { transform: 'translate(' + sx + 'px,' + sy + 'px)' },
      { transform: 'translate(' + sx + 'px,' + floor + 'px)' },
      { transform: 'translate(' + sx + 'px,' + (floor - 70) + 'px)' },
      { transform: 'translate(' + sx + 'px,' + floor + 'px)' },
      { transform: 'translate(' + sx + 'px,' + (floor - 16) + 'px)' },
      { transform: 'translate(' + sx + 'px,' + floor + 'px)' },
    ], { duration: 1150, easing: 'ease-out' });
    a.onfinish = () => { setPos(sx, floor); };
  } catch (e) { setPos(sx, floor); }
  pos.x = sx; pos.y = floor;
}
function pRoll() {
  clearTransient();
  setLabel('...');
  tone({ f: 420, f2: 200, d: 0.32, g: 0.045 });
  const b = bounds(size);
  if (reduced()) { setPos(pos.x, b.my); return; }
  cancelWrapAnimations();
  const sx = clamp(pos.x, -b.mx, b.mx);
  const ex = clamp(sx + (Math.random() < 0.5 ? -1 : 1) * rand(90, 160), -b.mx, b.mx);
  const floor = b.my;
  try {
    const a = wrap.animate([
      { transform: 'translate(' + sx + 'px,' + pos.y + 'px)' },
      { transform: 'translate(' + sx + 'px,' + floor + 'px)' },
      { transform: 'translate(' + ex + 'px,' + floor + 'px)' },
    ], { duration: 1200, easing: 'ease-in-out' });
    a.onfinish = () => setPos(ex, floor);
  } catch (e) { setPos(ex, floor); }
  pos.x = ex; pos.y = floor;
}
function pGravity() {
  clearTransient();
  setLabel(choice(['?', '...']));
  tone({ f: 480, f2: 260, d: 0.25, g: 0.04 });
  if (reduced()) { moveBy(rand(-10, 10), 10); return; }
  const ox = pos.x, oy = pos.y;
  try {
    wrap.animate([
      { transform: 'translate(' + ox + 'px,' + oy + 'px)' },
      { transform: 'translate(' + ox + 'px,' + (oy + 26) + 'px)' },
      { transform: 'translate(' + ox + 'px,' + oy + 'px)' },
      { transform: 'translate(' + ox + 'px,' + (oy + 12) + 'px)' },
      { transform: 'translate(' + ox + 'px,' + oy + 'px)' },
    ], { duration: 800, easing: 'ease-in-out' });
  } catch (e) {}
}
function pOvershoot() {
  clearTransient();
  setLabel(choice(L_MOVE));
  const p = randomSpot(pos, 120);
  sMove(0);
  if (reduced()) { setPos(p.x, p.y); return; }
  const prev = wrap.style.transitionTimingFunction;
  wrap.style.transitionTimingFunction = 'cubic-bezier(0.2, 1.6, 0.4, 1)';
  setPos(p.x, p.y);
  setTimeout(() => { wrap.style.transitionTimingFunction = prev; }, 650);
}
function pSwing() {
  clearTransient();
  setLabel('...');
  sTick();
  if (reduced()) { setRot(rot + 6); return; }
  try {
    btn.style.transformOrigin = '50% -70px';
    const a = btn.animate([
      { transform: 'rotate(0deg)' }, { transform: 'rotate(14deg)' },
      { transform: 'rotate(-10deg)' }, { transform: 'rotate(6deg)' },
      { transform: 'rotate(-3deg)' }, { transform: 'rotate(0deg)' },
    ], { duration: 1600, easing: 'ease-in-out' });
    a.onfinish = () => { btn.style.transformOrigin = ''; setRot(rot); };
  } catch (e) {}
}
function pRicochet() {
  clearTransient();
  setLabel(choice(['?', 'Almost']));
  sMove(0);
  if (reduced()) { moveBy(rand(-14, 14), rand(-12, 12)); return; }
  cancelWrapAnimations();
  stopFollow();
  let vx = rand(2.4, 4) * (Math.random() < 0.5 ? -1 : 1);
  let vy = rand(-3.4, -2);
  let x = pos.x, y = pos.y;
  const t0 = performance.now(), dur = 1300;
  const step = (t) => {
    const b = bounds(size);
    vy += 0.16;
    x += vx; y += vy;
    if (x > b.mx) { x = b.mx; vx *= -0.7; }
    if (x < -b.mx) { x = -b.mx; vx *= -0.7; }
    if (y > b.my) { y = b.my; vy *= -0.55; vx *= 0.92; }
    if (y < -b.my) { y = -b.my; vy *= -0.6; }
    setPos(x, y);
    if (t - t0 < dur) followRaf = requestAnimationFrame(step);
    else { followRaf = 0; }
  };
  followRaf = requestAnimationFrame(step);
}

// stage 9
function eFull() {
  clearTransient();
  setPos(0, 0);
  setSize(Math.max(200, Math.min(window.innerWidth, window.innerHeight) * 0.94));
  setLabel(choice(['Still here?', '...']));
  sGrow();
}
function eTiny() {
  clearTransient();
  const p = randomSpot(pos, 30);
  setPos(p.x, p.y);
  setSize(28);
  setLabel('?');
  sShrink();
}
function eOffscreen() {
  clearTransient();
  setPos(0, 0);
  setSize(Math.min(window.innerWidth, window.innerHeight) * 1.9);
  setLabel('Still here?');
  sGrow();
}
function eDarkFlash() {
  clearTransient();
  setLabel('...');
  const my = ++darkFlashToken;
  document.body.classList.add('dark');
  tone({ f: 300, d: 0.14, g: 0.05 });
  setTimeout(() => {
    if (my === darkFlashToken && lastId === 'e-darkflash') document.body.classList.remove('dark');
  }, 1700);
}
function eUnderCursor() {
  clearTransient();
  setLabel(choice(['?', '...']));
  cancelWrapAnimations();
  setPos(lastCursor.x - window.innerWidth / 2, lastCursor.y - window.innerHeight / 2);
  sMove(0);
}
function eStuck() {
  clearTransient();
  setLabel(choice(['...', 'Still here?']));
  const b = bounds(size);
  const edge = randInt(0, 3);
  if (edge === 0) setPos(0, b.my);
  else if (edge === 1) setPos(0, -b.my);
  else if (edge === 2) setPos(-b.mx, 0);
  else setPos(b.mx, 0);
  sMove(0);
}
function eNoText() {
  clearTransient();
  setLabel('');
  sTick();
}
function eSplit() {
  clearTransient();
  setLabel('...');
  sDup();
  if (reduced()) return;
  const c = btnCenter();
  const n = 5;
  const els = [];
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = 'clone';
    el.style.width = size + 'px';
    el.style.height = size + 'px';
    el.style.background = document.body.classList.contains('dark') ? '#f5f4f0' : (btn.style.backgroundColor || '#161616');
    el.style.left = (c.x - size / 2) + 'px';
    el.style.top = (c.y - size / 2) + 'px';
    stage.appendChild(el);
    els.push(el);
  }
  const ang0 = rand(0, Math.PI * 2);
  try {
    els.forEach((el, i) => {
      const a = ang0 + (i / n) * Math.PI * 2;
      const dx = Math.cos(a) * 95, dy = Math.sin(a) * 95;
      el.animate([
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(0.85)', opacity: 0.9 },
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
      ], { duration: 1200, easing: 'ease-in-out' });
    });
  } catch (e) {}
  setTimeout(() => els.forEach(el => { try { el.remove(); } catch (e) {} }), 1300);
}
function eStill() {
  clearTransient();
  stopFollow(); stopDrift();
  cancelWrapAnimations();
  setPos(0, 0);
  setSize(100);
  setRot(0);
  setLabel('...');
  stillLeft = 3;
  sTick();
}
function eReset() {
  fullReset();
  sTick();
}

/* ---------------- core flow ---------------- */
function advance(fromChallenge) {
  stopFollow();
  if (challenge && challenge.type === 'multiples') endShell();
  if (challenge && challenge.type === 'double' && challenge.timer) clearTimeout(challenge.timer);
  challenge = null;
  avoid = null;
  hoverGrow = null;
  count++;
  if (stillLeft > 0) stillLeft--;
  const b = pickBehaviour();
  lastId = b.id;
  lastUsed[b.id] = count;
  if (fromChallenge) {
    // completion sound already played; run silently-ish: temporarily mute run sounds
    const m = muted; muted = true;
    try { b.run(); } finally { muted = m; }
    // hold sets ring visible etc. even when muted — fine.
  } else {
    b.run();
  }
}

function onClick(e) {
  ensureAudio();
  if (suppressClick) { suppressClick = false; return; }
  if (!challenge) {
    pulseScale();
    advance(false);
    return;
  }
  if (challenge.type === 'hold') return; // hold ignores clicks
  if (challenge.type === 'double') { doublePress(); return; }
  if (challenge.type === 'hover') { completeHover(); return; }
  if (challenge.type === 'drag') {
    if (e && e.detail === 0) { // keyboard fallback: two quick presses
      const now = Date.now();
      challenge.presses.push(now);
      challenge.presses = challenge.presses.filter(t => now - t < 600);
      if (challenge.presses.length >= 2) completeDrag();
      else sTick();
    }
    return;
  }
  if (challenge.type === 'multiples') return; // resolved only via the shell circles
}

/* ---------------- events ---------------- */
btn.addEventListener('click', onClick);
btn.addEventListener('contextmenu', (e) => e.preventDefault());

btn.addEventListener('pointerdown', (e) => {
  ensureAudio();
  lastCursor = { x: e.clientX || lastCursor.x, y: e.clientY || lastCursor.y };
  if (challenge && challenge.type === 'hover') { completeHover(); return; }
  if (challenge && challenge.type === 'hold') { startHold(); return; }
  if (challenge && challenge.type === 'drag') {
    dragState = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, id: e.pointerId };
    try { btn.setPointerCapture(e.pointerId); } catch (err) {}
  }
});
window.addEventListener('pointerup', (e) => {
  if (challenge && challenge.type === 'hold') cancelHold();
  if (challenge && challenge.type === 'drag' && dragState) {
    const ox = dragState.ox, oy = dragState.oy;
    dragState = null;
    setPos(ox, oy); // snap back if released too early; stays armed
  }
});
window.addEventListener('pointercancel', () => {
  if (challenge && challenge.type === 'hold') cancelHold();
  dragState = null;
});
btn.addEventListener('pointerleave', () => {
  if (challenge && challenge.type === 'hold') cancelHold();
});
window.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  lastCursor = { x: e.clientX, y: e.clientY };
  if (challenge && challenge.type === 'drag' && dragState) {
    const dx = e.clientX - dragState.sx, dy = e.clientY - dragState.sy;
    if (Math.hypot(dx, dy) > DRAG_MIN) { completeDrag(); return; }
    setPos(dragState.ox + dx * 0.5, dragState.oy + dy * 0.5);
    return;
  }
  if (avoid && avoid.dodgesLeft > 0 && (!challenge || challenge.type !== 'multiples')) {
    const c = btnCenter();
    const d = Math.hypot(e.clientX - c.x, e.clientY - c.y);
    const R = size / 2 + (reduced() ? 40 : 90);
    if (d < R) {
      dodge(e.clientX, e.clientY);
      avoid.dodgesLeft--;
      if (avoid.dodgesLeft <= 0) avoid = null;
    }
  }
}, { passive: true });
window.addEventListener('pointerdown', (e) => {
  if (e.target === btn || (e.target && e.target.classList && e.target.classList.contains('shell'))) return;
  if (e.clientX == null) return;
  lastCursor = { x: e.clientX, y: e.clientY };
  if (avoid && avoid.nearMiss && avoid.dodgesLeft > 0) {
    const c = btnCenter();
    if (Math.hypot(e.clientX - c.x, e.clientY - c.y) < size / 2 + 130) {
      dodge(e.clientX, e.clientY);
      avoid.dodgesLeft--;
      if (avoid.dodgesLeft <= 0) avoid = null;
    }
  }
}, { passive: true });

btn.addEventListener('pointerenter', (e) => {
  if (challenge && challenge.type === 'hover' && e.pointerType !== 'touch') completeHover();
  if (hoverGrow && !challenge) {
    setSize(Math.min(hoverGrow.base * 1.3, 260));
  }
});
btn.addEventListener('pointerleave', () => {
  if (hoverGrow && !challenge) setSize(hoverGrow.base);
});
btn.addEventListener('focus', () => {
  if (challenge && challenge.type === 'hover') completeHover();
});
btn.addEventListener('keydown', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && challenge && challenge.type === 'hold' && !e.repeat) {
    ensureAudio();
    e.preventDefault();
    startHold();
  }
});
btn.addEventListener('keyup', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && challenge && challenge.type === 'hold') cancelHold();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'm' || e.key === 'M') toggleMute();
});
window.addEventListener('resize', () => {
  setPos(pos.x, pos.y);
  if (shell && shell.d) {
    const hx = Math.max(0, window.innerWidth / 2 - (shell.d / 2 + 14));
    const hy = Math.max(0, window.innerHeight / 2 - (shell.d / 2 + 14));
    shell.items.forEach(it => {
      it.x = clamp(it.x, -hx, hx);
      it.y = clamp(it.y, -hy, hy);
      placeShellEl(it.el, it.x, it.y, shell.d);
    });
  }
});

/* ---------------- init ---------------- */
ringFg.style.strokeDasharray = String(CIRC);
ringFg.style.strokeDashoffset = String(CIRC);
setSize(100);
setPos(0, 0);
setLabel('Click');

/* read-only hook for automated verification (no visible UI) */
window.__button = {
  getState() {
    return {
      count, size, x: pos.x, y: pos.y, rot,
      text: label.textContent,
      challenge: challenge ? challenge.type : null,
      avoid: avoid ? avoid.dodgesLeft : 0,
      lastId,
      shell: shell ? shell.items.length : 0,
      shellActive: shellActive(),
      dark: document.body.classList.contains('dark'),
    };
  },
};

})();
