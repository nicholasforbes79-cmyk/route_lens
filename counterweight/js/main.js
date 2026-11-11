// Counterweight, turn-based 3D: boot, input, on-screen prompts, frame loop.

import RAPIER from '../vendor/rapier3d-compat.mjs';
import { Game } from './game.js';
import { View } from './view.js';
import { TIER_NAMES } from './config.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const overlay = $('overlay');

await RAPIER.init();

// Playtest overrides, e.g. ?rounds=6&seed=3
const params = new URLSearchParams(location.search);
const config = {};
if (params.has('rounds')) config.roundsPerTower = Number(params.get('rounds'));
if (params.has('towers')) config.towers = Number(params.get('towers'));
const game = new Game(RAPIER, { config, seed: params.has('seed') ? Number(params.get('seed')) : undefined });
const view = new View(canvas, game);
window.__cw = { game, view };

let shown = null; // which state the prompt and overlay were last drawn for
let helpOpen = false;
const log = [];

// ------------------------------------------------------------------ overlays

const RULES = `
  <ul>
    <li>Two players share one tower and take turns. You only need a mouse.</li>
    <li>The <span class="drop">Dropper</span> places the piece the hand is holding on top of the tower.</li>
    <li>Then the <span class="pull">Puller</span> slides one block out of the tower.</li>
    <li>That is one round. Every 3 rounds the two of you swap roles.</li>
    <li>Knock the tower down on your move and you lose 10 points.</li>
    <li>Most points after 3 towers wins.</li>
  </ul>
  <h2>Points</h2>
  <ul>
    <li><span class="drop">Dropper:</span> 1 point per square of the piece, +3 for finishing a layer.</li>
    <li><span class="pull">Puller:</span> 1, 2 or 4 points. The more weight the block was carrying, the more it is worth.</li>
    <li>Blocks you knock off the tower cost 2 points each.</li>
  </ul>`;

function card(html) {
  overlay.innerHTML = `<div class="card">${html}</div>`;
  overlay.classList.remove('hidden');
}
function closeCard() { overlay.classList.add('hidden'); helpOpen = false; }

function showMenu() {
  card(`<h1>Counterweight</h1>
    <p>Build it up. Pull it apart. Don't be the one who knocks it down.</p>
    ${RULES}
    <div class="buttons"><button id="go">Start game</button>
      <a href="realtime2d/">Older real-time 2D version</a></div>`);
  $('go').onclick = () => { game.startGame(); };
}

function showHelp() {
  helpOpen = true;
  card(`<h1>How to play</h1>${RULES}
    <h2>Controls</h2>
    <ul>
      <li><strong>Look around:</strong> drag with the mouse. Scroll to zoom.</li>
      <li><strong>Dropper:</strong> move the mouse over the tower to aim, press R or right-click to turn the piece, click to drop.</li>
      <li><strong>Puller:</strong> click a coloured block to choose it, then click it again to pull.</li>
    </ul>
    <div class="buttons"><button id="closeHelp" class="plain">Back to the game</button></div>`);
  $('closeHelp').onclick = closeCard;
}

function scoreTable(r) {
  return `<table><tr><th></th><th>This tower</th><th>Total</th></tr>
    ${[0, 1].map((p) => `<tr><td>P${p + 1}</td><td>${r.score[p]}</td><td>${r.total[p]}</td></tr>`).join('')}</table>`;
}

function showTowerEnd() {
  const r = game.result;
  const what = r.reason === 'collapse'
    ? `P${r.culprit + 1} knocked the tower down and loses 10 points.`
    : `The tower survived all ${game.cfg.roundsPerTower} rounds.`;
  card(`<h1>Tower ${game.towerIndex + 1} is over</h1><p>${what}</p>${scoreTable(r)}
    <div class="buttons"><button id="next">Next tower</button></div>`);
  $('next').onclick = () => game.nextTower();
}

function showGameOver() {
  const r = game.result;
  const what = r.reason === 'collapse' ? `P${r.culprit + 1} knocked the last tower down.` : 'The last tower survived.';
  const who = r.winner < 0 ? 'It\'s a draw' : `P${r.winner + 1} wins`;
  card(`<h1>${who}</h1><p>${what}</p>${scoreTable(r)}
    <div class="buttons"><button id="again">Play again</button></div>`);
  $('again').onclick = () => game.startGame();
}

// ------------------------------------------------------------------ HUD

function icon(el, cells) {
  const w = Math.max(...cells.map((c) => c[0])) + 1, d = Math.max(...cells.map((c) => c[1])) + 1;
  const on = new Set(cells.map((c) => `${c[0]},${c[1]}`));
  el.style.gridTemplateColumns = `repeat(${w}, auto)`;
  let html = '';
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) html += `<i class="${on.has(`${x},${z}`) ? 'on' : ''}"></i>`;
  el.innerHTML = html;
}

function drawHud() {
  const g = game;
  for (const p of [0, 1]) {
    const isDropper = p === g.dropper;
    $(`p${p}pts`).textContent = g.total[p] + g.score[p];
    const role = $(`p${p}role`);
    role.textContent = isDropper ? 'Dropper' : 'Puller';
    role.className = `role ${isDropper ? 'drop' : 'pull'}`;
    const active = (g.state === 'aim' || g.state === 'dropping' || g.state === 'choose' || g.state === 'pulling') && g.mover === p;
    $(`p${p}`).className = `player${active ? ' active' : ''}${active && g.role === 'pull' ? ' pulling' : ''}`;
  }
  $('towerLabel').textContent = `Tower ${g.towerIndex + 1} of ${g.cfg.towers}`;
  $('roundLabel').textContent = `Round ${g.round} of ${g.cfg.roundsPerTower}`;
  const left = g.cfg.swapEvery - ((g.round - 1) % g.cfg.swapEvery);
  $('swapLabel').textContent = g.round + left > g.cfg.roundsPerTower ? 'No more role swaps'
    : `Roles swap after ${left === 1 ? 'this round' : `${left} rounds`}`;
  icon($('nowIcon'), g.piece.cells);
  icon($('nextIcon'), g.next.cells);
  $('pieces').classList.toggle('hidden', g.role !== 'drop');
}

function drawLog() {
  while (game.messages.length) log.unshift(game.messages.shift());
  log.length = Math.min(log.length, 5);
  $('log').innerHTML = log.map((m) => `<div class="${m.player >= 0 ? 'p' + m.player : ''}">${m.text}</div>`).join('');
}

function button(label, cls, onClick, disabled = false) {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
  b.disabled = disabled;
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

function drawPrompt() {
  const g = game;
  const line = $('promptLine'), sub = $('promptSub'), btns = $('promptButtons');
  btns.replaceChildren();
  const who = `P${g.mover + 1}`;
  if (g.state === 'aim') {
    line.innerHTML = `${who}: <span class="drop">drop the piece</span>`;
    sub.textContent = 'Move the mouse over the tower to aim. Click to drop.';
    btns.append(button('Turn piece (R)', 'plain', () => game.rotatePiece()), button('Drop (Space)', '', dropNow));
  } else if (g.state === 'choose') {
    line.innerHTML = `${who}: <span class="pull">pull a block out</span>`;
    const sel = view.selectedId != null && g.blocks.get(view.selectedId);
    if (sel) {
      const pts = g.cfg.score.pull[view.pullInfo.get(sel.id).tier];
      sub.textContent = `It will slide the way the arrow points. Worth +${pts}.`;
      btns.append(button(`Pull it (Space)`, 'pull', pullNow), button('Choose another', 'plain', () => { view.selectedId = null; shown = null; }));
    } else {
      sub.innerHTML = 'Click a coloured block.' +
        '<span class="dot" style="background:#4f8fd6"></span>light +1' +
        '<span class="dot" style="background:#e6b422"></span>medium +2' +
        '<span class="dot" style="background:#d9534f"></span>heavy +4' +
        '<span class="dot" style="background:#7a6a55"></span>can\'t be pulled';
    }
  } else if (g.state === 'dropping' || g.state === 'pulling' || g.state === 'settle') {
    line.textContent = g.state === 'settle' ? 'Waiting for the tower to settle…' : (g.state === 'pulling' ? 'Pulling…' : 'Dropping…');
    sub.textContent = '';
  } else {
    line.textContent = '';
    sub.textContent = '';
  }
}

function sync() {
  const key = `${game.state}|${view.selectedId}|${game.mover}|${game.round}|${game.towerIndex}`;
  drawLog();
  if (game.world) drawHud();
  if (key === shown) return;
  shown = key;
  $('hud').classList.toggle('hidden', !game.world);
  if (game.state === 'choose' && view.pullInfo.size === 0) view.refreshPullInfo();
  if (game.state !== 'choose') { view.pullInfo.clear(); view.selectedId = null; view.hoverId = null; $('tip').textContent = ''; }
  if (game.state === 'menu') showMenu();
  else if (game.state === 'towerEnd') showTowerEnd();
  else if (game.state === 'gameOver') showGameOver();
  else if (!helpOpen) closeCard();
  drawPrompt();
}

// ------------------------------------------------------------------ actions

function dropNow() {
  const target = game.beginDrop();
  if (target) view.startDrop(target.y, () => game.place());
}

function pullNow() {
  const blk = view.selectedId != null && game.blocks.get(view.selectedId);
  if (!blk) return;
  game.startPull(blk, view.cameraDir());
}

function hoverTip(blk, x, y) {
  const tip = $('tip');
  const info = blk && view.pullInfo.get(blk.id);
  if (!info) { tip.textContent = ''; return; }
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
  if (info.can) tip.textContent = `${TIER_NAMES[info.tier]} load · +${game.cfg.score.pull[info.tier]}`;
  else tip.textContent = game.inPullLayers(blk) ? 'Boxed in: no clear way out' : 'Top two layers can\'t be pulled';
}

// ------------------------------------------------------------------ pointer

let down = null; // { x, y, dragged, button }

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, dragged: false, button: e.button, touch: e.pointerType === 'touch' };
});

canvas.addEventListener('pointermove', (e) => {
  if (down) {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) down.dragged = true;
    if (down.dragged) view.orbit(e.clientX - down.lx, e.clientY - down.ly);
    down.lx = e.clientX; down.ly = e.clientY;
    return;
  }
  if (game.state === 'aim') {
    const p = view.aimPoint(e.clientX, e.clientY);
    if (p) game.aimAt(p.x, p.z);
  } else if (game.state === 'choose') {
    const blk = view.pickBlock(e.clientX, e.clientY);
    view.hoverId = blk ? blk.id : null;
    hoverTip(blk, e.clientX, e.clientY);
  }
});

canvas.addEventListener('pointerup', (e) => {
  const d = down;
  down = null;
  if (!d || d.dragged) return;
  if (d.button === 2) { game.rotatePiece(); return; }
  if (game.state === 'aim') {
    const p = view.aimPoint(e.clientX, e.clientY);
    if (p) game.aimAt(p.x, p.z);
    // On a touch screen a tap only aims; the Drop button drops.
    if (!d.touch) dropNow();
  } else if (game.state === 'choose') {
    const blk = view.pickBlock(e.clientX, e.clientY);
    const info = blk && view.pullInfo.get(blk.id);
    if (blk && info && info.can) {
      if (view.selectedId === blk.id) pullNow();
      else view.selectedId = blk.id;
    } else {
      view.selectedId = null;
      if (d.touch) hoverTip(blk, e.clientX, e.clientY);
    }
  }
});

canvas.addEventListener('pointercancel', () => { down = null; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => { e.preventDefault(); view.zoom(e.deltaY); }, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') game.rotatePiece();
  else if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    if (game.state === 'menu') game.startGame();
    else if (game.state === 'towerEnd') game.nextTower();
    else if (game.state === 'gameOver') game.startGame();
    else if (game.state === 'aim') dropNow();
    else if (game.state === 'choose') pullNow();
  } else if (e.code === 'ArrowLeft') view.orbit(40, 0);
  else if (e.code === 'ArrowRight') view.orbit(-40, 0);
  else if (e.code === 'ArrowUp') view.orbit(0, 30);
  else if (e.code === 'ArrowDown') view.orbit(0, -30);
  else if (e.code === 'Escape' && helpOpen) closeCard();
});

$('helpBtn').onclick = () => (helpOpen ? closeCard() : showHelp());
window.addEventListener('resize', () => view.resize());

// ------------------------------------------------------------------ loop

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  game.update(dt);
  sync();
  view.render(dt);
  requestAnimationFrame(frame);
}
sync();
requestAnimationFrame(frame);
