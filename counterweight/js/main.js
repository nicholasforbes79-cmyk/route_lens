// Counterweight prototype: boot, input and the frame loop.

import RAPIER from '../vendor/rapier2d-compat.mjs';
import { Game } from './sim.js';
import { Renderer } from './render.js';

const canvas = document.getElementById('game');
const overlay = document.getElementById('overlay');

await RAPIER.init();

// Optional overrides for playtesting, e.g. ?phase=15&cap=90&seed=3
const params = new URLSearchParams(location.search);
const config = {};
if (params.has('phase')) config.phaseSeconds = Number(params.get('phase'));
if (params.has('cap')) config.towerCapSeconds = Number(params.get('cap'));
const game = new Game(RAPIER, {
  config,
  seed: params.has('seed') ? Number(params.get('seed')) : undefined,
});
const view = new Renderer(canvas, game);
window.__cw = { game, view };

let paused = false;
let shownState = null;

// ------------------------------------------------------------------ overlays

function show(html, light = false) {
  overlay.innerHTML = `<div class="card">${html}</div>`;
  overlay.className = `overlay${light ? ' light' : ''}`;
}
function hide() { overlay.className = 'overlay hidden'; }

function showMenu() {
  show(`
    <h1>Counterweight</h1>
    <p class="sub">Prototype · two players, one tower, one keyboard and one mouse</p>
    <p>One player <span class="amber">drops</span> pieces onto the top of the tower. The other
      <span class="teal">pulls</span> blocks out of the bottom half. Roles swap every 60 seconds:
      trade the keyboard and the mouse. When the tower falls, whoever caused it pays.</p>
    <div class="cols">
      <div>
        <h2 class="amber">Dropper · keyboard</h2>
        <ul>
          <li><kbd>A</kbd> <kbd>D</kbd> move, <kbd>W</kbd> <kbd>Q</kbd> rotate</li>
          <li><kbd>S</kbd> soft drop, <kbd>Space</kbd> hard drop</li>
          <li><kbd>E</kbd> hold</li>
          <li>Fill a whole row and it fuses: +50</li>
        </ul>
      </div>
      <div>
        <h2 class="teal">Puller · mouse</h2>
        <ul>
          <li>Drag a block sideways to slide it out</li>
          <li>Pull slowly; a fast yank shakes the tower</li>
          <li>Right-click a block to test its load</li>
          <li>Red blocks carry the most and score ×8</li>
        </ul>
      </div>
    </div>
    <p class="sub">Best of 5 towers. A collapse costs 150 points, split by blame. P1 starts as Dropper.</p>
    <div class="buttons"><button id="start">Start match (Enter)</button></div>`);
  document.getElementById('start').onclick = startMatch;
}

function blameHtml(r) {
  if (r.reason === 'cap') return '<p class="blame" style="border-color:#59b96b">The tower survived the full six minutes. +100 each.</p>';
  const b = r.blame;
  const line = (p) => {
    if (!b.pct[p]) return '';
    const a = b.top[p];
    const what = a ? ` (${a.label} at ${Math.floor(a.t / 60)}:${String(Math.floor(a.t % 60)).padStart(2, '0')})` : '';
    return `<strong>${b.pct[p]}% P${p + 1}</strong>${what}`;
  };
  const parts = [0, 1].sort((x, y) => b.pct[y] - b.pct[x]).map(line).filter(Boolean);
  const hot = b.protect ? '<br><span class="sub">Hot potato: moves made right after the swap were not counted.</span>' : '';
  return `<p class="blame">Collapse at ${r.rows} rows. Blame: ${parts.join(', ')}.${hot}</p>`;
}

function scoresHtml(r) {
  return `<table class="scores">
    <tr><th></th><th>This tower</th><th>Towers won</th><th>Match points</th></tr>
    ${[0, 1].map((p) => `<tr><td>P${p + 1}${r.winner === p ? ' ★' : ''}</td><td>${r.score[p]}</td><td>${game.wins[p]}</td><td>${game.matchScore[p]}</td></tr>`).join('')}
  </table>`;
}

function showResult() {
  const r = game.result;
  const who = r.winner >= 0 ? `P${r.winner + 1} wins the tower` : 'Tower drawn';
  show(`
    <h1>Tower ${game.towerIndex + 1}: ${who}</h1>
    ${blameHtml(r)}
    ${scoresHtml(r)}
    <p><strong>P${r.chooser + 1}</strong>, ${r.winner >= 0 ? 'you lost this one, so you' : 'you'} pick your starting role for the next tower:</p>
    <div class="buttons">
      <button id="pickD">Start as Dropper (D)</button>
      <button id="pickP" class="alt">Start as Puller (P)</button>
    </div>`, true);
  document.getElementById('pickD').onclick = () => game.nextTower('dropper');
  document.getElementById('pickP').onclick = () => game.nextTower('puller');
}

function showMatchOver() {
  const r = game.result;
  const who = r.matchWinner >= 0 ? `P${r.matchWinner + 1} wins the match` : 'The match is a draw';
  show(`
    <h1>${who}</h1>
    ${blameHtml(r)}
    ${scoresHtml(r)}
    <div class="buttons"><button id="again">Play again (Enter)</button></div>`, true);
  document.getElementById('again').onclick = startMatch;
}

function startMatch() {
  paused = false;
  game.startMatch(0);
}

function syncOverlay() {
  if (game.state === shownState) return;
  shownState = game.state;
  if (game.state === 'menu') showMenu();
  else if (game.state === 'result') showResult();
  else if (game.state === 'matchover') showMatchOver();
  else hide();
}

// ------------------------------------------------------------------ keyboard

const held = new Map(); // direction key -> seconds held
const KEYS = {
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  KeyW: 'cw', ArrowUp: 'cw', KeyQ: 'ccw', KeyS: 'soft', ArrowDown: 'soft',
  Space: 'hard', KeyE: 'hold',
};

window.addEventListener('keydown', (e) => {
  if (e.code === 'Enter' && (game.state === 'menu' || game.state === 'matchover')) { startMatch(); return; }
  if (game.state === 'result') {
    if (e.code === 'KeyD') game.nextTower('dropper');
    if (e.code === 'KeyP') game.nextTower('puller');
    return;
  }
  if (e.code === 'Escape' && (game.state === 'playing' || game.state === 'freeze')) { paused = !paused; return; }
  const action = KEYS[e.code];
  if (!action) return;
  e.preventDefault();
  if (e.repeat || paused) return;
  if (action === 'left') { game.moveActive(-1); held.set('left', 0); held.delete('right'); }
  else if (action === 'right') { game.moveActive(1); held.set('right', 0); held.delete('left'); }
  else if (action === 'cw') game.rotateActive(1);
  else if (action === 'ccw') game.rotateActive(-1);
  else if (action === 'soft') game.softDrop = true;
  else if (action === 'hard') game.hardDrop();
  else if (action === 'hold') game.holdActive();
});

window.addEventListener('keyup', (e) => {
  const action = KEYS[e.code];
  if (action === 'left' || action === 'right') held.delete(action);
  if (action === 'soft') game.softDrop = false;
});

function autoRepeat(dt) {
  // 170 ms before repeating, then one step every 50 ms
  for (const [dir, t] of held) {
    const nt = t + dt;
    const steps = (x) => (x < 0.17 ? 0 : 1 + Math.floor((x - 0.17) / 0.05));
    for (let i = steps(t); i < steps(nt); i++) game.moveActive(dir === 'left' ? -1 : 1);
    held.set(dir, nt);
  }
}

// ------------------------------------------------------------------ mouse

function world(e) {
  const r = canvas.getBoundingClientRect();
  return view.toWorld(e.clientX - r.left, e.clientY - r.top);
}

canvas.addEventListener('mousedown', (e) => {
  if (paused) return;
  const p = world(e);
  if (e.button === 0) game.pointerDown(p.x, p.y);
  else if (e.button === 2) game.tap(p.x, p.y);
});
window.addEventListener('mousemove', (e) => {
  const p = world(e);
  game.setPointer(p.x, p.y);
  view.hover = game.world ? game.cellAt(p.x, p.y) : null;
});
window.addEventListener('mouseup', (e) => { if (e.button === 0) game.pointerUp(); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('blur', () => { held.clear(); game.softDrop = false; game.pointerUp(); });
window.addEventListener('resize', () => view.resize());

// ------------------------------------------------------------------ loop

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!paused) {
    autoRepeat(dt);
    game.update(dt);
  }
  syncOverlay();
  view.draw(dt, paused);
  requestAnimationFrame(frame);
}
syncOverlay();
requestAnimationFrame(frame);
