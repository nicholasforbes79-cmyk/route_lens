// Canvas drawing for Counterweight. Reads the Game state; never changes it.

import { SHAPES } from './config.js';

export const AMBER = '#f2a93b';
export const TEAL = '#2ec4b6';

const STOPS = [
  [0.0, [79, 143, 214]],
  [0.3, [89, 185, 107]],
  [0.6, [230, 195, 66]],
  [0.8, [224, 86, 74]],
  [1.2, [190, 40, 52]],
];

function stressRgb(pct) {
  const p = Math.max(0, Math.min(1.2, pct));
  for (let i = 1; i < STOPS.length; i++) {
    if (p <= STOPS[i][0]) {
      const [p0, c0] = STOPS[i - 1], [p1, c1] = STOPS[i];
      const k = (p - p0) / (p1 - p0);
      return c0.map((v, j) => v + (c1[j] - v) * k);
    }
  }
  return STOPS[STOPS.length - 1][1];
}

function cellColour(pct, mat) {
  let [r, g, b] = stressRgb(pct);
  if (mat === 'lead') { r *= 0.55; g *= 0.55; b *= 0.6; }
  if (mat === 'ice') { r += (255 - r) * 0.5; g += (255 - g) * 0.5; b += (255 - b) * 0.5; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export class Renderer {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.viewTop = 16;
    this.clock = 0;
    this.hover = null;
    this.resize();
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
  }

  layout() {
    const { W, H, game } = this;
    const side = W < 900 ? 132 : 190;
    const top = 76;
    const areaW = W - side * 2, areaH = H - top;
    const want = Math.max(16, Math.max(game.towerTop || 0, game.active ? game.active.y + 3 : 0) + 2);
    this.viewTop += (want - this.viewTop) * 0.06;
    const s = Math.min(areaW / 19, areaH / (this.viewTop + 1.2));
    this.s = s;
    this.ox = side + areaW / 2 - (game.cfg.wellWidth / 2) * s;
    this.oy = H - 1.2 * s;
    this.side = side;
    this.top = top;
  }

  sx(x) { return this.ox + x * this.s; }
  sy(y) { return this.oy - y * this.s; }
  toWorld(px, py) { return { x: (px - this.ox) / this.s, y: (this.oy - py) / this.s }; }

  draw(dt, paused) {
    const { ctx, game, dpr } = this;
    this.clock += dt;
    this.layout();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round';
    const { W, H, s } = this;

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#2a211d');
    bg.addColorStop(1, '#40322a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    if (game.world) {
      this.drawStage();
      this.drawZone();
      for (const blk of game.blocks.values()) this.drawBlock(blk);
      this.drawPullOverlays();
      this.drawActive();
      this.drawPopups();
    }
    this.drawHud(paused);
  }

  drawStage() {
    const { ctx, game, s } = this;
    const W = game.cfg.wellWidth, F = game.cfg.foundationRows, wallTop = game.cfg.wallTop;
    ctx.fillStyle = '#1d1613';
    ctx.fillRect(0, this.sy(0), this.W, this.H - this.sy(0));
    // walls
    ctx.fillStyle = '#5b4a3c';
    ctx.fillRect(this.sx(-1), this.sy(wallTop), s, wallTop * s);
    ctx.fillRect(this.sx(W), this.sy(wallTop), s, wallTop * s);
    // foundation
    for (let r = 0; r < F; r++) {
      for (let c = 0; c < W; c++) {
        ctx.fillStyle = (r + c) % 2 ? '#6a6059' : '#62584f';
        ctx.fillRect(this.sx(c), this.sy(r + 1), s + 0.5, s + 0.5);
      }
    }
    ctx.strokeStyle = '#2c2420';
    ctx.lineWidth = 2;
    ctx.strokeRect(this.sx(0), this.sy(F), W * s, F * s);
  }

  drawZone() {
    const { ctx, game, s } = this;
    const W = game.cfg.wellWidth, F = game.foundationTop;
    if (game.zoneTop <= F + 0.05) return;
    const y0 = this.sy(game.zoneTop), h = (game.zoneTop - F) * s;
    ctx.fillStyle = 'rgba(46,196,182,0.13)';
    ctx.fillRect(this.sx(-1.4), y0, (W + 2.8) * s, h);
    ctx.strokeStyle = 'rgba(46,196,182,0.8)';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(this.sx(-1.4), y0);
    ctx.lineTo(this.sx(W + 1.4), y0);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = TEAL;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('PULL ZONE', this.sx(W + 1.5), y0 + 4);
  }

  blockTransform(x, y, rot) {
    const { ctx, s, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(this.sx(x), this.sy(y));
    ctx.rotate(-rot);
    ctx.scale(s, -s);
  }

  drawCells(cells, colourOf, outline, lineWidth = 0.07) {
    const { ctx } = this;
    const key = (lx, ly) => `${Math.round(lx * 2)},${Math.round(ly * 2)}`;
    const have = new Set(cells.map((c) => key(c.lx, c.ly)));
    for (const c of cells) {
      ctx.fillStyle = colourOf(c);
      ctx.fillRect(c.lx - 0.5, c.ly - 0.5, 1, 1);
      if (c.mat === 'lead') {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(c.lx - 0.22, c.ly - 0.22, 0.44, 0.44);
      } else if (c.mat === 'ice') {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 0.07;
        ctx.beginPath();
        ctx.moveTo(c.lx - 0.3, c.ly + 0.05); ctx.lineTo(c.lx - 0.05, c.ly + 0.3);
        ctx.moveTo(c.lx - 0.3, c.ly - 0.25); ctx.lineTo(c.lx + 0.25, c.ly + 0.3);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = outline;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const c of cells) {
      const { lx, ly } = c;
      if (!have.has(key(lx - 1, ly))) { ctx.moveTo(lx - 0.5, ly - 0.5); ctx.lineTo(lx - 0.5, ly + 0.5); }
      if (!have.has(key(lx + 1, ly))) { ctx.moveTo(lx + 0.5, ly - 0.5); ctx.lineTo(lx + 0.5, ly + 0.5); }
      if (!have.has(key(lx, ly - 1))) { ctx.moveTo(lx - 0.5, ly - 0.5); ctx.lineTo(lx + 0.5, ly - 0.5); }
      if (!have.has(key(lx, ly + 1))) { ctx.moveTo(lx - 0.5, ly + 0.5); ctx.lineTo(lx + 0.5, ly + 0.5); }
    }
    ctx.stroke();
    // faint seams between the cells of one piece
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    for (const c of cells) {
      const { lx, ly } = c;
      if (have.has(key(lx + 1, ly))) { ctx.moveTo(lx + 0.5, ly - 0.5); ctx.lineTo(lx + 0.5, ly + 0.5); }
      if (have.has(key(lx, ly + 1))) { ctx.moveTo(lx - 0.5, ly + 0.5); ctx.lineTo(lx + 0.5, ly + 0.5); }
    }
    ctx.stroke();
  }

  drawBlock(blk) {
    const { ctx, game } = this;
    const pulse = 0.82 + 0.18 * Math.sin(this.clock * 7);
    this.blockTransform(blk.x, blk.y, blk.rot);
    this.drawCells(blk.cells, (c) => {
      const pct = game.stress(c);
      c._pct = pct;
      return cellColour(pct >= 0.8 ? pct * pulse + (1 - pulse) * 0.7 : pct, c.mat);
    }, blk.slab ? '#17110e' : 'rgba(25,18,14,0.9)', blk.slab ? 0.12 : 0.07);
    if (blk.slab) {
      ctx.fillStyle = 'rgba(23,17,14,0.55)';
      const xs = blk.cells.map((c) => c.lx);
      const x0 = Math.min(...xs) - 0.5, w = Math.max(...xs) - Math.min(...xs) + 1;
      ctx.fillRect(x0, -0.5, w, 0.14);
      ctx.fillRect(x0, 0.36, w, 0.14);
    }
    // half-pulled cells look like they are sliding out towards you
    for (const c of blk.cells) {
      if (c.pull <= 0) continue;
      const k = 1 + 0.28 * c.pull;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(c.lx - 0.5, c.ly - 0.5, 1, 1);
      ctx.fillStyle = cellColour(c._pct, c.mat);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 0.06;
      ctx.fillRect(c.lx - k / 2, c.ly - k / 2, k, k);
      ctx.strokeRect(c.lx - k / 2, c.ly - k / 2, k, k);
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  drawPullOverlays() {
    const { ctx, game, s } = this;
    const live = game.state === 'playing';
    const target = game.grab ? game.grab.cell : (live ? this.hover : null);
    if (target && game.cellByHandle.has(target.col.handle)) {
      const ok = game.pullable(target);
      const blk = target.blk;
      this.blockTransform(blk.x, blk.y, blk.rot);
      ctx.strokeStyle = ok ? '#ffffff' : 'rgba(255,255,255,0.25)';
      ctx.lineWidth = ok ? 0.1 : 0.05;
      ctx.strokeRect(target.lx - 0.5, target.ly - 0.5, 1, 1);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (game.grab) {
        const p = game.cellPos(target);
        const w = 2.2 * s, x = this.sx(p.x) - w / 2, y = this.sy(p.y + 0.95);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x, y, w, 7);
        ctx.fillStyle = TEAL;
        ctx.fillRect(x, y, w * target.pull, 7);
      }
    }
    const tap = game.tapInfo;
    if (tap && game.cellByHandle.has(tap.cell.col.handle)) {
      const p = game.cellPos(tap.cell);
      const text = `load ${Math.round(tap.pct * 100)}%`;
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const w = ctx.measureText(text).width + 14;
      ctx.fillStyle = 'rgba(20,15,12,0.9)';
      ctx.fillRect(this.sx(p.x) - w / 2, this.sy(p.y + 0.6) - 20, w, 22);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, this.sx(p.x), this.sy(p.y + 0.6) - 5);
    }
  }

  drawActive() {
    const { ctx, game } = this;
    const a = game.active;
    if (!a) return;
    const cells = a.cells.map(([x, y]) => ({ lx: x + 0.5, ly: y + 0.5, mat: a.mat }));
    const ghostY = game.landingY();
    if (ghostY !== null && a.y - ghostY > 0.3) {
      this.blockTransform(a.col, ghostY, 0);
      ctx.globalAlpha = 0.28;
      this.drawCells(cells, () => 'rgba(242,169,59,0.35)', AMBER, 0.06);
      ctx.globalAlpha = 1;
    }
    this.blockTransform(a.col, a.y, 0);
    this.drawCells(cells, (c) => cellColour(0.05, c.mat), AMBER, 0.11);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  drawPopups() {
    const { ctx, game } = this;
    ctx.textAlign = 'center';
    ctx.font = '700 15px system-ui, sans-serif';
    for (const p of game.popups) {
      const a = Math.max(0, 1 - p.t / 1.6);
      const x = this.sx(p.x), y = this.sy(p.y) - 14 - p.t * 26;
      ctx.globalAlpha = a;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(20,15,12,0.85)';
      ctx.strokeText(p.text, x, y);
      ctx.fillStyle = p.player < 0 ? '#fff' : this.roleColour(p.player);
      ctx.fillText(p.text, x, y);
    }
    ctx.globalAlpha = 1;
  }

  roleColour(player) { return player === this.game.dropper ? AMBER : TEAL; }

  drawMini(desc, cx, cy, size) {
    const { ctx } = this;
    const shape = SHAPES[desc.name];
    const w = Math.max(...shape.map((c) => c[0])) + 1, h = Math.max(...shape.map((c) => c[1])) + 1;
    const cells = shape.map(([x, y]) => ({ lx: x + 0.5 - w / 2, ly: y + 0.5 - h / 2, mat: desc.mat }));
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(cx, cy);
    ctx.scale(size, -size);
    this.drawCells(cells, (c) => cellColour(0.05, c.mat), 'rgba(25,18,14,0.9)');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  drawHud(paused) {
    const { ctx, game, W, H, side, top } = this;
    const live = !!game.world;
    // bars
    ctx.fillStyle = 'rgba(24,18,15,0.92)';
    ctx.fillRect(0, 0, W, top);
    ctx.fillStyle = 'rgba(24,18,15,0.6)';
    ctx.fillRect(0, top, side, H - top);
    ctx.fillRect(W - side, top, side, H - top);
    if (!live) return;

    // players
    for (const p of [0, 1]) {
      const isDropper = p === game.dropper;
      const colour = isDropper ? AMBER : TEAL;
      const x = p === 0 ? 18 : W - 18;
      ctx.textAlign = p === 0 ? 'left' : 'right';
      ctx.fillStyle = '#f3ece4';
      ctx.font = '700 26px system-ui, sans-serif';
      ctx.fillText(`P${p + 1}   ${game.score[p]}`, x, 34);
      ctx.fillStyle = colour;
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillText(isDropper ? 'DROPPER · keyboard' : 'PULLER · mouse', x, 54);
      ctx.fillStyle = '#c9b8a4';
      ctx.font = '12px system-ui, sans-serif';
      const pips = '●'.repeat(game.wins[p]) + '○'.repeat(Math.max(0, 3 - game.wins[p]));
      ctx.fillText(`towers ${pips}`, x, 69);
    }

    // centre: tower number, clock, swap ring
    const cx = W / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#c9b8a4';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText(`TOWER ${game.towerIndex + 1} / ${game.cfg.towersPerMatch}`, cx - 86, 30);
    ctx.fillStyle = '#f3ece4';
    ctx.font = '600 16px system-ui, sans-serif';
    ctx.fillText(`${fmtTime(game.time)} / ${fmtTime(game.cfg.towerCapSeconds)}`, cx - 86, 52);
    ctx.fillStyle = '#c9b8a4';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(`${Math.round(game.towerRows)} rows`, cx - 86, 68);

    const left = Math.max(0, game.phaseLeft);
    const warn = game.state === 'playing' && left <= game.cfg.swapWarnSeconds;
    const r = 24, ry = 38, rx = cx + 40;
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#4a3c2e';
    ctx.beginPath(); ctx.arc(rx, ry, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = warn ? (Math.sin(this.clock * 10) > 0 ? '#fff' : '#e0564a') : '#f3ece4';
    ctx.beginPath();
    ctx.arc(rx, ry, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (left / game.cfg.phaseSeconds));
    ctx.stroke();
    ctx.fillStyle = '#f3ece4';
    ctx.font = '700 16px system-ui, sans-serif';
    ctx.fillText(String(Math.ceil(left)), rx, ry + 6);
    ctx.fillStyle = '#c9b8a4';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('SWAP IN', rx + 34, ry + 4);

    // left panel: queue + hold
    const lx = side / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = AMBER;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText('NEXT', lx, top + 26);
    const mini = side < 150 ? 15 : 20;
    game.queue.slice(0, 3).forEach((d, i) => this.drawMini(d, lx, top + 66 + i * 64, mini));
    ctx.textAlign = 'center';
    ctx.fillStyle = AMBER;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText('HOLD', lx, top + 262);
    if (game.hold) this.drawMini(game.hold, lx, top + 302, mini);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#a8957f';
    ctx.font = '11px system-ui, sans-serif';
    ['A / D  move', 'W / Q  rotate', 'S  soft drop', 'Space  hard drop', 'E  hold', 'Esc  pause'].forEach((t, i) =>
      ctx.fillText(t, lx, H - 96 + i * 15));

    // right panel: bank + log
    const rxp = W - side / 2;
    ctx.fillStyle = TEAL;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText('BANK', rxp, top + 26);
    ctx.fillStyle = '#f3ece4';
    ctx.font = '700 22px system-ui, sans-serif';
    ctx.fillText(`${game.bank[0] + game.bank[1]}`, rxp, top + 54);
    ctx.fillStyle = '#a8957f';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('blocks pulled', rxp, top + 70);
    ctx.fillText(`P1 ${game.bank[0]}  ·  P2 ${game.bank[1]}`, rxp, top + 86);
    ctx.textAlign = 'left';
    ctx.font = '11px system-ui, sans-serif';
    game.log.forEach((l, i) => {
      ctx.globalAlpha = 1 - i * 0.1;
      ctx.fillStyle = this.roleColour(l.player);
      ctx.fillText(`P${l.player + 1} ${l.text}`.slice(0, side < 150 ? 20 : 30), W - side + 10, top + 118 + i * 16);
    });
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#a8957f';
    ['Drag a block sideways', 'to pull it out.', 'Slow is safe, fast shakes.', 'Right-click: test load'].forEach((t, i) =>
      ctx.fillText(t, rxp, H - 66 + i * 15));

    // stress legend
    const lgx = W - side + 12, lgy = H - 110, lw = side - 24;
    const grad = ctx.createLinearGradient(lgx, 0, lgx + lw, 0);
    for (const [p, c] of STOPS) grad.addColorStop(Math.min(1, p), `rgb(${c.join(',')})`);
    ctx.fillStyle = grad;
    ctx.fillRect(lgx, lgy, lw, 8);
    ctx.fillStyle = '#a8957f';
    ctx.textAlign = 'left'; ctx.fillText('light load ×1', lgx, lgy + 21);
    ctx.textAlign = 'right'; ctx.fillText('heavy ×8', lgx + lw, lgy + 21);

    // banners
    let banner = null, sub = null;
    if (paused) { banner = 'PAUSED'; sub = 'Esc to resume'; }
    else if (game.state === 'freeze') { banner = `SWAP!  ${Math.ceil(game.freezeLeft)}`; sub = `P${game.puller + 1} takes the keyboard · P${game.dropper + 1} takes the mouse`; }
    else if (game.state === 'collapse') { banner = 'COLLAPSE'; }
    else if (warn) { sub = `Swap in ${Math.ceil(left)}…`; }
    ctx.textAlign = 'center';
    if (banner) {
      ctx.font = '800 46px system-ui, sans-serif';
      ctx.lineWidth = 8;
      ctx.strokeStyle = 'rgba(20,15,12,0.85)';
      ctx.strokeText(banner, W / 2, top + 70);
      ctx.fillStyle = game.state === 'collapse' ? '#e0564a' : '#fff';
      ctx.fillText(banner, W / 2, top + 70);
    }
    if (sub) {
      ctx.font = '600 15px system-ui, sans-serif';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(20,15,12,0.85)';
      ctx.strokeText(sub, W / 2, top + (banner ? 98 : 34));
      ctx.fillStyle = '#fff';
      ctx.fillText(sub, W / 2, top + (banner ? 98 : 34));
    }
  }
}
