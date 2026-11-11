// Counterweight: rules and physics. No DOM in here, so it also runs under Node
// (see tests/sim.test.mjs). Rendering and input live in render.js and main.js.

import { CONFIG, MATERIALS, SHAPES, STARTER, TIER_NAMES } from './config.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rotateShape(cells, dir) {
  // dir +1 = clockwise on screen (y is up)
  const out = cells.map(([x, y]) => (dir > 0 ? [y, -x] : [-y, x]));
  const minX = Math.min(...out.map((c) => c[0]));
  const minY = Math.min(...out.map((c) => c[1]));
  return out.map(([x, y]) => [x - minX, y - minY]);
}

const shapeWidth = (cells) => Math.max(...cells.map((c) => c[0])) + 1;
const shapeHeight = (cells) => Math.max(...cells.map((c) => c[1])) + 1;

export class Game {
  constructor(RAPIER, opts = {}) {
    this.R = RAPIER;
    this.cfg = { ...CONFIG, ...(opts.config || {}) };
    this.rng = mulberry32(opts.seed ?? (Date.now() & 0xffffffff));
    this.state = 'menu'; // menu | playing | freeze | collapse | result | matchover
    this.world = null;
    this.wins = [0, 0];
    this.matchScore = [0, 0];
    this.towerIndex = 0;
    this.result = null;
    this.popups = [];
    this.log = [];
    this.blocks = new Map();
    this.cellByHandle = new Map();
    this.blockByBody = new Map();
    this.score = [0, 0];
    this.dropper = 0;
  }

  get puller() { return 1 - this.dropper; }
  get foundationTop() { return this.cfg.foundationRows; }
  get towerRows() { return Math.max(0, this.towerTop - this.foundationTop); }

  // ---------------------------------------------------------------- match

  startMatch(firstDropper = 0) {
    this.wins = [0, 0];
    this.matchScore = [0, 0];
    this.towerIndex = 0;
    this.startTower(firstDropper);
  }

  startTower(dropperIdx) {
    const { R, cfg } = this;
    if (this.world) this.world.free();
    this.world = new R.World({ x: 0, y: -cfg.gravity });
    this.world.timestep = cfg.step;
    this.eq = new R.EventQueue(true);
    this.probe = new R.Cuboid(0.46, 0.46);

    this.blocks = new Map();
    this.cellByHandle = new Map();
    this.blockByBody = new Map();
    this.nextId = 1;

    const W = cfg.wellWidth;
    const fixed = (hx, hy, x, y, friction) =>
      this.world.createCollider(R.ColliderDesc.cuboid(hx, hy).setTranslation(x, y).setFriction(friction));
    fixed(80, 1, W / 2, -1, 0.8); // ground
    fixed(W / 2, cfg.foundationRows / 2, W / 2, cfg.foundationRows / 2, 0.8); // foundation
    fixed(0.5, cfg.wallTop / 2, -0.5, cfg.wallTop / 2, 0.3);
    fixed(0.5, cfg.wallTop / 2, W + 0.5, cfg.wallTop / 2, 0.3);

    // Starter rows
    const pieces = new Map();
    STARTER.forEach((row, i) => {
      const y = STARTER.length - 1 - i;
      [...row].forEach((ch, x) => {
        if (!pieces.has(ch)) pieces.set(ch, []);
        pieces.get(ch).push([x, y]);
      });
    });
    for (const cells of pieces.values()) {
      const blk = this.createBlock(
        cells.map(([x, y]) => ({ lx: x + 0.5, ly: y + 0.5, mat: 'wood', noFuse: true })),
        0, this.foundationTop, 0,
      );
      blk.everSettled = true;
    }

    this.dropper = dropperIdx;
    this.score = [0, 0];
    this.time = 0;
    this.phaseLeft = cfg.phaseSeconds;
    this.swapCount = 0;
    this.lastSwapTime = -Infinity;
    this.ledger = [];
    this.pendingPlace = [];
    this.pendingClean = [];
    this.popups = [];
    this.log = [];
    this.bank = [0, 0];
    this.tray = [];
    this.bag = [];
    this.dealt = 0;
    this.lastDealtCube = false;
    this.queue = [];
    this.hold = null;
    this.active = null;
    this.softDrop = false;
    this.spawnWait = 0;
    this.autoSpawn = true;
    this.grab = null;
    this.pointer = { x: 0, y: 0 };
    this.tapLock = 0;
    this.tapInfo = null;
    this.acc = 0;
    this.timers = { zone: 0, fuse: 0, sample: 0 };
    this.fuseSeen = new Set();
    this.towerTop = this.foundationTop + STARTER.length;
    this.zoneTop = this.foundationTop;
    this.milestone = Math.floor(STARTER.length / cfg.milestoneRows);
    this.result = null;
    this.blame = null;

    this.refreshBlocks(0);
    this.updateZone();
    for (let i = 0; i < 3; i++) this.queue.push(this.deal());
    this.spawn();
    this.state = 'playing';
  }

  // ---------------------------------------------------------------- blocks

  createBlock(cells, x, y, rot, from = null) {
    const { R } = this;
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(x, y).setRotation(rot)
        .setLinearDamping(this.cfg.linearDamping).setAngularDamping(this.cfg.angularDamping),
    );
    const blk = {
      id: this.nextId++, body, cells: [], slab: false,
      placedBy: from ? from.placedBy : -1,
      calm: from ? from.calm : 0,
      settled: from ? from.settled : false,
      everSettled: from ? from.everSettled : false,
      hist: from ? from.hist.slice() : [],
      x, y, rot, cos: Math.cos(rot), sin: Math.sin(rot),
    };
    this.blocks.set(blk.id, blk);
    this.blockByBody.set(body.handle, blk);
    for (const c of cells) this.addCell(blk, c);
    return blk;
  }

  addCell(blk, { lx, ly, mat, noFuse = false, load = 0, pull = 0 }) {
    const { R } = this;
    const m = MATERIALS[mat];
    const desc = R.ColliderDesc.cuboid(0.495, 0.495)
      .setTranslation(lx, ly)
      .setDensity(m.density)
      .setFriction(m.friction)
      .setRestitution(this.cfg.restitution)
      .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(0);
    if (mat === 'ice') desc.setFrictionCombineRule(R.CoefficientCombineRule.Min);
    const col = this.world.createCollider(desc, blk.body);
    const cell = { col, lx, ly, mat, noFuse, load, pull, acc: 0, blk };
    blk.cells.push(cell);
    this.cellByHandle.set(col.handle, cell);
    return cell;
  }

  dropCell(cell) {
    this.cellByHandle.delete(cell.col.handle);
    this.world.removeCollider(cell.col, true);
    const i = cell.blk.cells.indexOf(cell);
    if (i >= 0) cell.blk.cells.splice(i, 1);
  }

  removeBlock(blk) {
    for (const c of blk.cells.slice()) this.dropCell(c);
    this.blockByBody.delete(blk.body.handle);
    this.world.removeRigidBody(blk.body);
    this.blocks.delete(blk.id);
  }

  // Remove cells from a block. Whatever is left stays welded where it still
  // touches edge to edge; pieces that come apart become separate bodies.
  removeCells(blk, doomed) {
    for (const c of doomed) this.dropCell(c);
    if (blk.cells.length === 0) { this.removeBlock(blk); return; }

    const rest = blk.cells.slice();
    const groups = [];
    while (rest.length) {
      const group = [rest.pop()];
      for (let i = 0; i < group.length; i++) {
        for (let j = rest.length - 1; j >= 0; j--) {
          const d = Math.abs(rest[j].lx - group[i].lx) + Math.abs(rest[j].ly - group[i].ly);
          if (Math.abs(d - 1) < 1e-3) group.push(rest.splice(j, 1)[0]);
        }
      }
      groups.push(group);
    }
    if (groups.length === 1) { blk.body.wakeUp(); return; }

    groups.sort((a, b) => b.length - a.length);
    const t = blk.body.translation();
    const rot = blk.body.rotation();
    const lv = blk.body.linvel();
    const av = blk.body.angvel();
    for (const group of groups.slice(1)) {
      const specs = group.map((c) => ({ lx: c.lx, ly: c.ly, mat: c.mat, noFuse: c.noFuse, load: c.load, pull: c.pull }));
      const wasGrabbed = this.grab ? group.indexOf(this.grab.cell) : -1;
      for (const c of group) this.dropCell(c);
      const nb = this.createBlock(specs, t.x, t.y, rot, blk);
      nb.body.setLinvel(lv, true);
      nb.body.setAngvel(av, true);
      if (wasGrabbed >= 0) this.grab.cell = nb.cells[wasGrabbed];
    }
    blk.body.wakeUp();
  }

  cellPos(cell) {
    const b = cell.blk;
    return {
      x: b.x + cell.lx * b.cos - cell.ly * b.sin,
      y: b.y + cell.lx * b.sin + cell.ly * b.cos,
    };
  }

  refreshBlocks(dt) {
    const W = this.cfg.wellWidth;
    let top = this.foundationTop;
    for (const blk of this.blocks.values()) {
      const t = blk.body.translation();
      blk.x = t.x; blk.y = t.y;
      blk.rot = blk.body.rotation();
      blk.cos = Math.cos(blk.rot); blk.sin = Math.sin(blk.rot);
      const v = blk.body.linvel();
      const quiet = Math.hypot(v.x, v.y) < 0.2 && Math.abs(blk.body.angvel()) < 0.2;
      blk.calm = quiet ? blk.calm + dt : 0;
      blk.settled = blk.body.isSleeping() || blk.calm > 0.4;
      if (blk.settled) {
        blk.everSettled = true;
        for (const c of blk.cells) {
          const p = this.cellPos(c);
          if (p.x > 0 && p.x < W && p.y + 0.5 > top) top = p.y + 0.5;
        }
      }
    }
    this.towerTop = top;
  }

  // ---------------------------------------------------------------- stress

  stress(cell) {
    const p = this.cellPos(cell);
    const share = Math.max(2, this.towerTop - p.y);
    return Math.min(1.5, cell.load / (this.cfg.stressShare * share));
  }

  tier(pct) {
    const t = this.cfg.stressThresholds;
    return pct < t[0] ? 0 : pct < t[1] ? 1 : pct < t[2] ? 2 : 3;
  }

  stepPhysics(dt) {
    const { cfg } = this;
    this.acc += dt;
    let n = 0;
    while (this.acc >= cfg.step && n < 10) {
      this.world.step(this.eq);
      this.eq.drainContactForceEvents((e) => {
        const f = e.totalForceMagnitude();
        const a = this.cellByHandle.get(e.collider1());
        const b = this.cellByHandle.get(e.collider2());
        if (a) a.acc += f;
        if (b) b.acc += f;
      });
      this.acc -= cfg.step;
      n++;
    }
    if (n === 10) this.acc = 0;
    if (n === 0) return;
    const alpha = 1 - Math.exp(-(n * cfg.step) / 0.25);
    for (const blk of this.blocks.values()) {
      const asleep = blk.body.isSleeping();
      for (const c of blk.cells) {
        // A sleeping body reports no contact forces; keep its last reading.
        if (!asleep) c.load += alpha * (c.acc / n / (2 * cfg.gravity) - c.load);
        c.acc = 0;
      }
    }
  }

  // ---------------------------------------------------------------- dropper

  deal() {
    if (this.tray.length && !this.lastDealtCube) {
      this.lastDealtCube = true;
      return { name: 'cube', mat: this.tray.shift() };
    }
    this.lastDealtCube = false;
    if (!this.bag.length) {
      this.bag = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
    }
    this.dealt++;
    const special = this.dealt % this.cfg.specialEvery === 0;
    const mat = special ? this.cfg.specials[Math.floor(this.rng() * this.cfg.specials.length)] : 'wood';
    return { name: this.bag.pop(), mat };
  }

  spawn(desc = null, held = false) {
    const d = desc || this.queue.shift();
    if (!desc) this.queue.push(this.deal());
    const cells = SHAPES[d.name].map((c) => c.slice());
    const col = Math.floor((this.cfg.wellWidth - shapeWidth(cells)) / 2);
    // Spawn a fixed distance above the settled tower, not above pieces still in flight.
    let y = Math.ceil(this.towerTop) + this.cfg.spawnClearance;
    while (this.hits(cells, col, y)) y += 1;
    this.active = { name: d.name, mat: d.mat, cells, col, y, held };
  }

  hits(cells, col, y) {
    if (col < 0 || col + shapeWidth(cells) > this.cfg.wellWidth) return true;
    for (const [cx, cy] of cells) {
      if (this.world.intersectionWithShape({ x: col + cx + 0.5, y: y + cy + 0.5 }, 0, this.probe)) return true;
    }
    return false;
  }

  moveActive(dx) {
    const a = this.active;
    if (this.state !== 'playing' || !a) return false;
    if (this.hits(a.cells, a.col + dx, a.y)) return false;
    a.col += dx;
    return true;
  }

  rotateActive(dir) {
    const a = this.active;
    if (this.state !== 'playing' || !a) return false;
    const cells = rotateShape(a.cells, dir);
    const shift = Math.round((shapeWidth(a.cells) - shapeWidth(cells)) / 2);
    for (const kick of [0, -1, 1, -2, 2]) {
      const col = a.col + shift + kick;
      if (!this.hits(cells, col, a.y)) { a.cells = cells; a.col = col; return true; }
    }
    return false;
  }

  holdActive() {
    const a = this.active;
    if (this.state !== 'playing' || !a || a.held) return false;
    const prev = this.hold;
    this.hold = { name: a.name, mat: a.mat };
    if (prev) this.spawn(prev, true);
    else { this.spawn(); this.active.held = true; }
    return true;
  }

  hardDrop() {
    if (this.state !== 'playing' || !this.active) return false;
    this.releaseActive(this.cfg.hardDropSpeed, true);
    return true;
  }

  // Where the active piece would come to rest if nothing moved (for the ghost).
  landingY() {
    const a = this.active;
    if (!a) return null;
    let y = a.y;
    for (let i = 0; i < 400 && !this.hits(a.cells, a.col, y - 0.25); i++) y -= 0.25;
    return y;
  }

  releaseActive(speed, hard) {
    const a = this.active;
    const blk = this.createBlock(
      a.cells.map(([x, y]) => ({ lx: x + 0.5, ly: y + 0.5, mat: a.mat })),
      a.col, a.y, 0,
    );
    blk.placedBy = this.dropper;
    blk.body.setLinvel({ x: 0, y: -speed }, true);
    const heavy = a.mat === 'lead' ? 1.8 : 1;
    this.ledger.push({
      t: this.time, player: this.dropper, kind: 'drop',
      w: (hard ? 1.0 : 0.4) * heavy * (a.cells.length / 4 + 0.25),
      label: `${hard ? 'hard-dropped ' : 'placed '}${a.mat === 'wood' ? '' : a.mat + ' '}${a.name === 'cube' ? 'cube' : a.name + ' piece'}`,
    });
    this.pendingPlace.push({ id: blk.id, t: this.time + 3, player: this.dropper });
    // Give the released piece time to fall clear before the next one appears.
    this.active = null;
    this.spawnWait = 0.25;
  }

  // ---------------------------------------------------------------- puller

  cellAt(x, y) {
    for (const blk of this.blocks.values()) {
      const dx = x - blk.x, dy = y - blk.y;
      const lx = dx * blk.cos + dy * blk.sin;
      const ly = -dx * blk.sin + dy * blk.cos;
      for (const c of blk.cells) {
        if (Math.abs(lx - c.lx) <= 0.5 && Math.abs(ly - c.ly) <= 0.5) return c;
      }
    }
    return null;
  }

  pullable(cell) {
    return !!cell && !cell.blk.slab && this.cellPos(cell).y < this.zoneTop;
  }

  updateZone() {
    this.zoneTop = this.foundationTop + this.cfg.pullZoneFraction * this.towerRows;
  }

  setPointer(x, y) { this.pointer.x = x; this.pointer.y = y; }

  pointerDown(x, y) {
    this.setPointer(x, y);
    if (this.state !== 'playing' || this.tapLock > 0) return false;
    const cell = this.cellAt(x, y);
    if (!this.pullable(cell)) return false;
    this.grab = { cell, x0: x, base: cell.pull, maxSpeed: 0 };
    return true;
  }

  pointerUp() { this.grab = null; }

  tap(x, y) {
    if (this.state !== 'playing' || this.tapLock > 0 || this.grab) return false;
    const cell = this.cellAt(x, y);
    if (!this.pullable(cell)) return false;
    this.tapLock = this.cfg.tapLockout;
    this.tapInfo = { cell, pct: this.stress(cell), until: this.time + 1.5 };
    cell.blk.body.applyImpulse({ x: (this.rng() - 0.5) * 0.4, y: 0 }, true);
    return true;
  }

  neighbours(cell) {
    const out = new Set();
    this.world.contactPairsWith(cell.col, (other) => {
      const parent = other.parent();
      const blk = parent && this.blockByBody.get(parent.handle);
      if (blk && blk !== cell.blk) out.add(blk);
    });
    return out;
  }

  updateGrab(dt) {
    const g = this.grab;
    if (!g) return;
    const { cfg } = this;
    const cell = g.cell;
    if (!this.cellByHandle.has(cell.col.handle)) { this.grab = null; return; }
    const dx = this.pointer.x - g.x0;
    const p = Math.min(1, g.base + Math.abs(dx) / cfg.pullDistance);
    if (p <= cell.pull) return;
    const dp = p - cell.pull;
    const speed = dp / Math.max(dt, 1e-3);
    g.maxSpeed = Math.max(g.maxSpeed, speed);
    // Anything faster than the safe speed drags the neighbours sideways.
    const jolt = Math.max(0, dp - cfg.safePullSpeed * dt) * cfg.yankImpulse * (1 + 2 * Math.min(1, this.stress(cell)));
    if (jolt > 0) {
      const dir = Math.sign(dx) || 1;
      for (const nb of this.neighbours(cell)) {
        const m = nb.body.mass();
        nb.body.applyImpulse({ x: dir * jolt * m, y: 0.15 * jolt * m }, true);
      }
      const m = cell.blk.body.mass();
      cell.blk.body.applyImpulse({ x: dir * jolt * m * 0.5, y: 0 }, true);
    }
    cell.pull = p;
    if (p >= 1) this.extract(cell, g.maxSpeed);
  }

  extract(cell, maxSpeed = 0) {
    const { cfg } = this;
    const pct = this.stress(cell);
    const tier = this.tier(pct);
    const pos = this.cellPos(cell);
    const pts = cfg.score.pull * cfg.stressMultipliers[tier];
    const player = this.puller;
    this.addScore(player, pts, pos, `+${pts} ${TIER_NAMES[tier]} pull`);
    this.ledger.push({
      t: this.time, player, kind: 'pull',
      w: 1 + 2 * Math.min(1, pct) + Math.min(2, maxSpeed / 3),
      label: `pulled a ${TIER_NAMES[tier]} block`,
    });
    const snaps = [...this.neighbours(cell)].map((b) => ({ id: b.id, x: b.x, y: b.y }));
    this.pendingClean.push({ t: this.time + 1, player, snaps, pos });
    for (const nb of this.neighbours(cell)) nb.body.wakeUp();
    this.tray.push(cell.mat);
    this.bank[player]++;
    if (this.tapInfo && this.tapInfo.cell === cell) this.tapInfo = null;
    this.grab = null;
    this.removeCells(cell.blk, [cell]);
  }

  // ---------------------------------------------------------------- scoring

  addScore(player, pts, pos, text) {
    this.score[player] += pts;
    if (pos) this.popups.push({ x: pos.x, y: pos.y, text: text || `${pts > 0 ? '+' : ''}${pts}`, player, t: 0 });
    if (text) {
      this.log.unshift({ player, text, t: this.time });
      this.log.length = Math.min(this.log.length, 8);
    }
  }

  checkPending() {
    const W = this.cfg.wellWidth;
    while (this.pendingPlace.length && this.pendingPlace[0].t <= this.time) {
      const p = this.pendingPlace.shift();
      const blk = this.blocks.get(p.id);
      if (p.fused) this.addScore(p.player, this.cfg.score.placed, null);
      else if (blk && blk.settled && blk.x > -1 && blk.x < W + 1 && blk.y > this.foundationTop - 0.5) {
        this.addScore(p.player, this.cfg.score.placed, { x: blk.x + 0.5, y: blk.y + 0.5 });
      }
    }
    while (this.pendingClean.length && this.pendingClean[0].t <= this.time) {
      const p = this.pendingClean.shift();
      const clean = p.snaps.every((s) => {
        const blk = this.blocks.get(s.id);
        return !blk || Math.hypot(blk.x - s.x, blk.y - s.y) <= 0.2;
      });
      if (clean) this.addScore(p.player, this.cfg.score.clean, { x: p.pos.x, y: p.pos.y + 0.6 }, `+${this.cfg.score.clean} clean pull`);
    }
    const m = Math.floor(this.towerRows / this.cfg.milestoneRows);
    if (m > this.milestone) {
      this.milestone = m;
      const pts = this.cfg.score.milestone;
      const pos = { x: this.cfg.wellWidth / 2, y: this.towerTop + 1 };
      this.addScore(0, pts, null, `+${pts} height ${m * this.cfg.milestoneRows} rows`);
      this.addScore(1, pts, null, `+${pts} height ${m * this.cfg.milestoneRows} rows`);
      this.popups.push({ ...pos, text: `${m * this.cfg.milestoneRows} ROWS  +${pts} each`, player: -1, t: 0 });
    }
  }

  // A complete, level, resting row fuses into one unpullable slab.
  checkFusion() {
    const W = this.cfg.wellWidth;
    const rows = new Map();
    for (const blk of this.blocks.values()) {
      if (blk.slab || !blk.settled) continue;
      if (Math.abs(Math.sin(2 * blk.rot)) > 0.15) continue;
      for (const c of blk.cells) {
        if (c.noFuse) continue;
        const p = this.cellPos(c);
        const r = Math.floor(p.y), col = Math.floor(p.x);
        if (col < 0 || col >= W) continue;
        if (Math.abs(p.y - (r + 0.5)) > 0.2 || Math.abs(p.x - (col + 0.5)) > 0.3) continue;
        if (!rows.has(r)) rows.set(r, new Map());
        rows.get(r).set(col, c);
      }
    }
    const seen = new Set();
    for (const [r, cols] of rows) {
      if (cols.size < W) continue;
      seen.add(r);
      if (this.fuseSeen.has(r)) { this.fuse([...cols.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])); seen.delete(r); }
    }
    this.fuseSeen = seen;
  }

  fuse(cells) {
    const W = this.cfg.wellWidth;
    const ys = cells.map((c) => this.cellPos(c).y);
    const y = ys.reduce((a, b) => a + b, 0) / ys.length;
    const specs = cells.map((c, i) => ({ lx: i + 0.5 - W / 2, ly: 0, mat: c.mat, noFuse: true, load: c.load }));
    const byBlock = new Map();
    for (const c of cells) {
      if (!byBlock.has(c.blk)) byBlock.set(c.blk, []);
      byBlock.get(c.blk).push(c);
    }
    if (this.grab && cells.includes(this.grab.cell)) this.grab = null;
    for (const [blk, doomed] of byBlock) {
      // A piece that went into a slab still counts as placed.
      for (const p of this.pendingPlace) if (p.id === blk.id) p.fused = true;
      this.removeCells(blk, doomed);
    }
    const slab = this.createBlock(specs, W / 2, y, 0);
    slab.slab = true;
    slab.settled = true;
    slab.everSettled = true;
    const pts = this.cfg.score.row;
    this.addScore(this.dropper, pts, { x: W / 2, y }, `+${pts} row fused`);
  }

  // ---------------------------------------------------------------- collapse

  hotPotatoWindow() {
    const { cfg } = this;
    const extra = Math.floor(Math.max(0, this.towerRows - 10) / 5) * cfg.hotPotatoPer5Rows;
    return Math.min(cfg.hotPotatoCap, cfg.hotPotatoBase + extra);
  }

  sampleCollapse() {
    const { cfg } = this;
    const W = cfg.wellWidth;
    const keep = Math.round(cfg.collapseWindow / 0.25) + 1;
    let fallen = 0;
    const lost = [];
    for (const blk of this.blocks.values()) {
      if (blk.everSettled) {
        blk.hist.push(blk.y);
        if (blk.hist.length > keep) blk.hist.shift();
        if (blk.hist[0] - blk.y > cfg.collapseDrop) fallen += blk.cells.length;
      }
      // Anything lying on the ground outside the walls has left the tower.
      const pts = blk.cells.map((c) => this.cellPos(c));
      if (pts.every((p) => p.x < -1 || p.x > W + 1) && pts.some((p) => p.y < 1)) lost.push(blk);
    }
    if (fallen >= cfg.collapseCells) { this.triggerCollapse(); return; }
    for (const blk of lost) {
      // A piece that never came to rest on the tower was simply misdropped.
      if (!blk.everSettled && blk.placedBy >= 0) {
        this.addScore(blk.placedBy, -cfg.score.lost, { x: Math.max(-3.5, Math.min(W + 3.5, blk.x)), y: 1.5 }, `-${cfg.score.lost} piece fell off`);
      }
      this.removeBlock(blk);
    }
  }

  computeBlame() {
    const { cfg } = this;
    const now = this.time;
    // Hot potato: right after a swap, only what happened before it counts.
    const protect = this.swapCount > 0 && now - this.lastSwapTime < this.hotPotatoWindow();
    const w = [0, 0];
    const top = [null, null];
    for (const a of this.ledger) {
      const age = now - a.t;
      if (age > cfg.blameWindow) continue;
      if (protect && a.t > this.lastSwapTime) continue;
      const weight = a.w * Math.pow(0.5, age / cfg.blameHalfLife);
      w[a.player] += weight;
      if (!top[a.player] || weight > top[a.player].weight) top[a.player] = { ...a, weight };
    }
    const total = w[0] + w[1];
    const share = total > 0 ? [w[0] / total, w[1] / total] : [0.5, 0.5];
    const pct = [Math.round(share[0] * 100), 0];
    pct[1] = 100 - pct[0];
    return { pct, top, protect };
  }

  triggerCollapse() {
    if (this.state !== 'playing' && this.state !== 'freeze') return;
    const { cfg } = this;
    this.blame = this.computeBlame();
    for (const p of [0, 1]) {
      const pen = Math.round((cfg.score.collapse * this.blame.pct[p]) / 100);
      if (pen) this.addScore(p, -pen, null, `-${pen} collapse (${this.blame.pct[p]}% blame)`);
    }
    this.active = null;
    this.grab = null;
    this.state = 'collapse';
    this.collapseLeft = cfg.collapseSeconds;
  }

  endTower(reason) {
    const { cfg } = this;
    if (reason === 'cap') {
      for (const p of [0, 1]) this.addScore(p, cfg.score.survive, null, `+${cfg.score.survive} tower survived`);
      this.active = null;
      this.grab = null;
    }
    const s = this.score;
    const blamePct = this.blame ? this.blame.pct : [0, 0];
    let winner = s[0] > s[1] ? 0 : s[1] > s[0] ? 1 : -1;
    if (winner < 0 && blamePct[0] !== blamePct[1]) winner = blamePct[0] < blamePct[1] ? 0 : 1;
    if (winner >= 0) this.wins[winner]++;
    this.matchScore[0] += s[0];
    this.matchScore[1] += s[1];
    const need = Math.floor(cfg.towersPerMatch / 2) + 1;
    const over = this.wins[0] >= need || this.wins[1] >= need || this.towerIndex + 1 >= cfg.towersPerMatch;
    let matchWinner = -1;
    if (over) {
      if (this.wins[0] !== this.wins[1]) matchWinner = this.wins[0] > this.wins[1] ? 0 : 1;
      else if (this.matchScore[0] !== this.matchScore[1]) matchWinner = this.matchScore[0] > this.matchScore[1] ? 0 : 1;
    }
    this.result = {
      reason, score: s.slice(), winner, blame: this.blame, rows: Math.round(this.towerRows),
      time: this.time, over, matchWinner,
      // The loser of a tower picks their starting role for the next one.
      chooser: winner >= 0 ? 1 - winner : this.puller,
    };
    this.state = over ? 'matchover' : 'result';
  }

  nextTower(chooserRole) {
    if (this.state !== 'result') return;
    const c = this.result.chooser;
    this.towerIndex++;
    this.startTower(chooserRole === 'dropper' ? c : 1 - c);
  }

  swapRoles() {
    this.dropper = 1 - this.dropper;
    this.swapCount++;
    this.lastSwapTime = this.time;
    this.phaseLeft = this.cfg.phaseSeconds;
    this.grab = null;
    this.state = 'playing';
  }

  // ---------------------------------------------------------------- frame

  update(dt) {
    const { cfg } = this;
    for (const p of this.popups) p.t += dt;
    this.popups = this.popups.filter((p) => p.t < 1.6);
    if (!this.world || this.state === 'menu') return;

    if (this.state === 'result' || this.state === 'matchover') {
      this.stepPhysics(dt * cfg.collapseSlowMo);
      this.refreshBlocks(dt);
      return;
    }

    if (this.state === 'collapse') {
      this.stepPhysics(dt * cfg.collapseSlowMo);
      this.refreshBlocks(dt * cfg.collapseSlowMo);
      this.collapseLeft -= dt;
      if (this.collapseLeft <= 0) this.endTower('collapse');
      return;
    }

    if (this.state === 'freeze') {
      const sdt = dt * cfg.freezeTimeScale;
      this.stepPhysics(sdt);
      this.refreshBlocks(sdt);
      this.timers.sample += sdt;
      if (this.timers.sample >= 0.25) { this.timers.sample = 0; this.sampleCollapse(); }
      if (this.state !== 'freeze') return;
      this.freezeLeft -= dt;
      if (this.freezeLeft <= 0) this.swapRoles();
      return;
    }

    // playing
    this.time += dt;
    this.phaseLeft -= dt;
    this.tapLock = Math.max(0, this.tapLock - dt);
    if (this.tapInfo && this.tapInfo.until < this.time) this.tapInfo = null;

    const a = this.active;
    if (!a && this.autoSpawn) {
      this.spawnWait -= dt;
      if (this.spawnWait <= 0) this.spawn();
    } else if (a) {
      const speed = this.softDrop ? cfg.softDropSpeed : cfg.fallSpeed;
      const ny = a.y - speed * dt;
      if (this.hits(a.cells, a.col, ny)) this.releaseActive(speed, false);
      else a.y = ny;
    }
    this.updateGrab(dt);
    this.stepPhysics(dt);
    this.refreshBlocks(dt);

    this.timers.zone += dt;
    if (this.timers.zone >= 1) { this.timers.zone = 0; this.updateZone(); }
    this.timers.fuse += dt;
    if (this.timers.fuse >= 0.5) { this.timers.fuse = 0; this.checkFusion(); }
    this.checkPending();
    this.timers.sample += dt;
    if (this.timers.sample >= 0.25) { this.timers.sample = 0; this.sampleCollapse(); }
    if (this.state !== 'playing') return;

    if (this.time >= cfg.towerCapSeconds) { this.endTower('cap'); return; }
    if (this.phaseLeft <= 0) {
      this.state = 'freeze';
      this.freezeLeft = cfg.freezeSeconds;
      this.grab = null;
    }
  }
}
