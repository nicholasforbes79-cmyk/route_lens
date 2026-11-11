// Counterweight, turn-based 3D: rules and physics. No DOM and no rendering in
// here, so it also runs under Node (tests/game.test.mjs).

import { CFG, SHAPES, SUPPLY, START_LAYERS, TIER_NAMES } from './config.js';

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

// Rotate vector v by quaternion q.
function rotate(q, v) {
  const { x, y, z, w } = q;
  const ix = w * v.x + y * v.z - z * v.y;
  const iy = w * v.y + z * v.x - x * v.z;
  const iz = w * v.z + x * v.y - y * v.x;
  const iw = -x * v.x - y * v.y - z * v.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
}

// Split a set of [x, z] cells into rectangles: whole shape if it is one
// rectangle, otherwise one strip per row.
export function runs(cells) {
  const xs = cells.map((c) => c[0]), zs = cells.map((c) => c[1]);
  const x0 = Math.min(...xs), z0 = Math.min(...zs);
  const w = Math.max(...xs) - x0 + 1, d = Math.max(...zs) - z0 + 1;
  if (w * d === cells.length) return [{ x: x0, z: z0, w, d }];
  const out = [];
  for (const z of [...new Set(zs)].sort((a, b) => a - b)) {
    const row = cells.filter((c) => c[1] === z).map((c) => c[0]).sort((a, b) => a - b);
    let start = row[0], prev = row[0];
    for (const x of row.slice(1).concat([Infinity])) {
      if (x !== prev + 1) { out.push({ x: start, z, w: prev - start + 1, d: 1 }); start = x; }
      prev = x;
    }
  }
  return out;
}

const DIRS = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];

export class Game {
  constructor(RAPIER, opts = {}) {
    this.R = RAPIER;
    this.cfg = { ...CFG, ...(opts.config || {}) };
    this.rng = mulberry32(opts.seed ?? (Date.now() & 0xffffffff));
    this.state = 'menu'; // menu | aim | dropping | pulling | choose | settle | towerEnd | gameOver
    this.world = null;
    this.blocks = new Map();
    this.total = [0, 0];
    this.score = [0, 0];
    this.towerIndex = 0;
    this.dropper = 0;
    this.round = 1;
    this.messages = [];
    this.removed = []; // block ids removed since the view last looked
  }

  get puller() { return 1 - this.dropper; }
  // Whose move it is right now.
  get mover() { return this.role === 'drop' ? this.dropper : this.puller; }

  // ------------------------------------------------------------ set-up

  startGame() {
    this.total = [0, 0];
    this.towerIndex = 0;
    this.startTower(0);
  }

  startTower(firstDropper) {
    const { R, cfg } = this;
    if (this.world) this.world.free();
    for (const id of this.blocks.keys()) this.removed.push(id);
    this.world = new R.World({ x: 0, y: -cfg.gravity, z: 0 });
    this.world.timestep = cfg.step;
    this.eq = new R.EventQueue(true);
    this.blocks = new Map();
    this.byCollider = new Map();
    this.nextId = 1;

    const c = cfg.size / 2;
    const fixed = (hx, hy, hz, x, y, z) => this.world.createCollider(
      R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(0.8));
    fixed(60, 0.5, 60, c, -2, c); // table, top at y = -1.5
    fixed(c + 0.35, 0.75, c + 0.35, c, -0.75, c); // plinth, top at y = 0

    START_LAYERS.forEach((layer, k) => {
      for (const [kind, cells] of layer) this.createBlock(kind, cells, (k + 0.5) * cfg.cellHeight, -1);
    });

    this.dropper = firstDropper;
    this.score = [0, 0];
    this.round = 1;
    this.role = 'drop';
    this.acc = 0;
    this.pending = null;
    this.pull = null;
    this.result = null;
    this.messages = [];
    this.piece = this.draw();
    this.next = this.draw();
    this.aim = { ix: 0, iz: 0 };
    this.refresh(0);
    this.clampAim();
    this.state = 'aim';
  }

  draw() {
    const kinds = Object.keys(SUPPLY);
    let r = this.rng() * kinds.reduce((s, k) => s + SUPPLY[k], 0);
    let kind = kinds[0];
    for (const k of kinds) { r -= SUPPLY[k]; if (r < 0) { kind = k; break; } }
    return { kind, cells: SHAPES[kind].map((p) => p.slice()) };
  }

  // ------------------------------------------------------------ blocks

  createBlock(kind, cells, y, player) {
    const { R, cfg } = this;
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(0, y, 0).setAngularDamping(0.6));
    const blk = {
      id: this.nextId++, kind, body, cells: [], colliders: [], player,
      pos: { x: 0, y, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 },
      load: 0, acc: 0, calm: 0, tone: this.rng(),
    };
    blk.cells = cells.map(([x, z]) => ({ lx: x + 0.5, lz: z + 0.5 }));
    // One smooth-edged box per straight run of cells. Separate boxes per cell
    // would catch on each other's inner edges when a block slides out.
    const r = 0.03;
    for (const run of runs(cells)) {
      const desc = R.ColliderDesc.roundCuboid(run.w / 2 - 0.004 - r, cfg.cellHeight / 2 - 0.004 - r, run.d / 2 - 0.004 - r, r)
        .setTranslation(run.x + run.w / 2, 0, run.z + run.d / 2)
        .setDensity(1)
        .setFriction(cfg.friction)
        .setRestitution(0)
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(0);
      const col = this.world.createCollider(desc, body);
      blk.colliders.push(col);
      this.byCollider.set(col.handle, blk);
    }
    blk.cellMass = body.mass() / blk.cells.length;
    this.blocks.set(blk.id, blk);
    return blk;
  }

  removeBlock(blk) {
    for (const col of blk.colliders) this.byCollider.delete(col.handle);
    this.world.removeRigidBody(blk.body);
    this.blocks.delete(blk.id);
    this.removed.push(blk.id);
  }

  cellPos(blk, cell) {
    const v = rotate(blk.rot, { x: cell.lx, y: 0, z: cell.lz });
    return { x: blk.pos.x + v.x, y: blk.pos.y + v.y, z: blk.pos.z + v.z };
  }

  centre(blk) {
    let x = 0, y = 0, z = 0;
    for (const c of blk.cells) { const p = this.cellPos(blk, c); x += p.x; y += p.y; z += p.z; }
    const n = blk.cells.length;
    return { x: x / n, y: y / n, z: z / n };
  }

  layerOf(blk) { return Math.round(this.centre(blk).y / this.cfg.cellHeight - 0.5); }

  refresh(dt) {
    let top = 0, topLayer = -1, moving = false;
    for (const blk of this.blocks.values()) {
      const t = blk.body.translation(), q = blk.body.rotation();
      blk.pos = { x: t.x, y: t.y, z: t.z };
      blk.rot = { x: q.x, y: q.y, z: q.z, w: q.w };
      if (this.pull && this.pull.block === blk) continue;
      const v = blk.body.linvel(), w = blk.body.angvel();
      const quiet = blk.body.isSleeping() ||
        (Math.hypot(v.x, v.y, v.z) < 0.05 && Math.hypot(w.x, w.y, w.z) < 0.05);
      blk.calm = quiet ? blk.calm + dt : 0;
      if (blk.calm < this.cfg.settleQuiet && !blk.body.isSleeping()) moving = true;
      const c = this.centre(blk);
      if (c.y > -0.3) {
        top = Math.max(top, c.y + this.cfg.cellHeight / 2);
        topLayer = Math.max(topLayer, this.layerOf(blk));
      }
    }
    this.topY = top;
    this.topLayer = topLayer;
    this.moving = moving;
  }

  // ------------------------------------------------------------ load

  // How many cell-weights this block carries on top of itself.
  carried(blk) { return Math.max(0, blk.load - blk.cells.length / 2); }

  tier(blk) {
    const c = this.centre(blk);
    let above = 0;
    for (const other of this.blocks.values()) {
      if (other !== blk && this.centre(other).y > c.y + this.cfg.cellHeight / 2) above += other.cells.length;
    }
    const share = Math.max(0.5, (above * blk.cells.length) / (this.cfg.size * this.cfg.size));
    const ratio = this.carried(blk) / share;
    const [a, b] = this.cfg.tierLimits;
    return ratio < a ? 0 : ratio < b ? 1 : 2;
  }

  stepPhysics(dt) {
    const { cfg } = this;
    this.acc += dt;
    let n = 0;
    while (this.acc >= cfg.step && n < 10) {
      this.world.step(this.eq);
      this.eq.drainContactForceEvents((e) => {
        const f = e.totalForceMagnitude();
        const a = this.byCollider.get(e.collider1());
        const b = this.byCollider.get(e.collider2());
        if (a) a.acc += f;
        if (b && b !== a) b.acc += f;
      });
      this.acc -= cfg.step;
      n++;
    }
    if (n === 10) this.acc = 0;
    if (!n) return;
    const alpha = 1 - Math.exp(-(n * cfg.step) / 0.3);
    for (const blk of this.blocks.values()) {
      // A sleeping body reports no forces; keep its last reading.
      if (!blk.body.isSleeping()) blk.load += alpha * (blk.acc / n / (2 * cfg.gravity * blk.cellMass) - blk.load);
      blk.acc = 0;
    }
  }

  // ------------------------------------------------------------ dropping

  pieceSize() {
    const xs = this.piece.cells.map((c) => c[0]), zs = this.piece.cells.map((c) => c[1]);
    return { w: Math.max(...xs) + 1, d: Math.max(...zs) + 1 };
  }

  clampAim() {
    const { w, d } = this.pieceSize();
    this.aim.ix = Math.max(0, Math.min(this.cfg.size - w, this.aim.ix));
    this.aim.iz = Math.max(0, Math.min(this.cfg.size - d, this.aim.iz));
  }

  // Aim the piece so its middle is as near as possible to world point (x, z).
  aimAt(x, z) {
    if (this.state !== 'aim') return;
    const { w, d } = this.pieceSize();
    this.aim.ix = Math.round(x - w / 2);
    this.aim.iz = Math.round(z - d / 2);
    this.clampAim();
  }

  nudgeAim(dx, dz) {
    if (this.state !== 'aim') return;
    this.aim.ix += dx; this.aim.iz += dz;
    this.clampAim();
  }

  rotatePiece() {
    if (this.state !== 'aim') return;
    const cells = this.piece.cells.map(([x, z]) => [-z, x]);
    const minX = Math.min(...cells.map((c) => c[0])), minZ = Math.min(...cells.map((c) => c[1]));
    this.piece.cells = cells.map(([x, z]) => [x - minX, z - minZ]);
    this.clampAim();
  }

  aimedCells() { return this.piece.cells.map(([x, z]) => [x + this.aim.ix, z + this.aim.iz]); }

  // Height (block centre) at which the aimed piece would touch down.
  landingY() {
    const { R, cfg } = this;
    const shape = new R.Cuboid(0.44, cfg.cellHeight / 2 - 0.01, 0.44);
    const startY = this.topY + 4;
    let drop = Infinity;
    for (const [x, z] of this.aimedCells()) {
      const hit = this.world.castShape({ x: x + 0.5, y: startY, z: z + 0.5 }, { x: 0, y: 0, z: 0, w: 1 },
        { x: 0, y: -1, z: 0 }, shape, 0, 200, true);
      if (hit) drop = Math.min(drop, hit.time_of_impact);
    }
    return Number.isFinite(drop) ? startY - drop + 0.01 : cfg.cellHeight / 2;
  }

  // The view calls beginDrop, plays the hand animation, then calls place.
  beginDrop() {
    if (this.state !== 'aim') return null;
    this.state = 'dropping';
    return { cells: this.aimedCells(), y: this.landingY() };
  }

  place() {
    if (this.state !== 'dropping') return null;
    const blk = this.createBlock(this.piece.kind, this.aimedCells(), this.landingY() + 0.03, this.dropper);
    this.pending = { type: 'drop', id: blk.id, player: this.dropper, t: 0, before: this.standing() };
    this.piece = this.next;
    this.next = this.draw();
    this.state = 'settle';
    return blk;
  }

  // ------------------------------------------------------------ pulling

  clearDir(blk, dir) {
    const { R, cfg } = this;
    const shape = new R.Cuboid(0.4, cfg.cellHeight / 2 - 0.06, 0.4);
    for (const cell of blk.cells) {
      const hit = this.world.castShape(this.cellPos(blk, cell), blk.rot, { x: dir.x, y: 0, z: dir.z }, shape,
        0, cfg.size + 1, true, undefined, undefined, undefined, blk.body);
      if (hit) return false;
    }
    return true;
  }

  // The way this block would slide out: the clear direction that points most
  // towards `prefer` (normally the camera), or null if it is boxed in.
  pullDir(blk, prefer = { x: 0, z: 1 }) {
    let best = null, bestDot = -Infinity;
    for (const d of DIRS) {
      const dot = d.x * prefer.x + d.z * prefer.z;
      if (dot > bestDot && this.clearDir(blk, d)) { best = d; bestDot = dot; }
    }
    return best;
  }

  inPullLayers(blk) {
    return this.centre(blk).y > -0.3 && this.layerOf(blk) <= this.topLayer - this.cfg.topLocked;
  }

  canPull(blk) { return this.inPullLayers(blk) && !!this.pullDir(blk); }

  anyPullable() {
    for (const blk of this.blocks.values()) if (this.canPull(blk)) return true;
    return false;
  }

  startPull(blk, prefer) {
    if (this.state !== 'choose' || !this.inPullLayers(blk)) return false;
    const dir = this.pullDir(blk, prefer);
    if (!dir) return false;
    const tier = this.tier(blk);
    for (const b of this.blocks.values()) b.body.wakeUp();
    blk.body.setBodyType(this.R.RigidBodyType.KinematicVelocityBased, true);
    blk.body.setLinvel({ x: dir.x * this.cfg.pullSpeed, y: 0, z: dir.z * this.cfg.pullSpeed }, true);
    blk.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.pull = { block: blk, dir, dist: 0, tier, player: this.puller };
    this.state = 'pulling';
    return true;
  }

  // ------------------------------------------------------------ turns

  // Ids of the blocks that are on the tower (not lying on the table).
  standing() {
    const ids = new Set();
    for (const blk of this.blocks.values()) if (this.centre(blk).y > -0.3) ids.add(blk.id);
    return ids;
  }

  say(text, player = -1) { this.messages.push({ text, player }); }

  completesLayer(blk) {
    const { cfg } = this;
    const layer = this.layerOf(blk);
    const filled = new Set();
    for (const other of this.blocks.values()) {
      if (this.layerOf(other) !== layer) continue;
      for (const cell of other.cells) {
        const p = this.cellPos(other, cell);
        if (Math.abs(p.y - (layer + 0.5) * cfg.cellHeight) > 0.2) continue;
        const ix = Math.floor(p.x), iz = Math.floor(p.z);
        if (ix >= 0 && ix < cfg.size && iz >= 0 && iz < cfg.size) filled.add(ix * 10 + iz);
      }
    }
    return filled.size === cfg.size * cfg.size;
  }

  resolve() {
    const { cfg } = this;
    const p = this.pending;
    this.pending = null;
    const who = p.player;

    // Anything that was standing before the move and is on the table now fell.
    const fallen = [];
    for (const blk of this.blocks.values()) {
      if (this.centre(blk).y <= -0.3) fallen.push(blk);
    }
    const knocked = fallen.filter((b) => p.before.has(b.id) || b.id === p.id).length;
    const collapse = knocked >= cfg.collapseBlocks;

    if (collapse) {
      this.score[who] -= cfg.score.collapse;
      this.say(`The tower fell! P${who + 1} loses ${cfg.score.collapse} points.`, who);
      this.endTower('collapse', who);
      return;
    }

    if (p.type === 'drop') {
      const blk = this.blocks.get(p.id);
      if (blk && !fallen.includes(blk)) {
        let pts = blk.cells.length * cfg.score.cell;
        let text = `P${who + 1} placed a ${blk.kind}: +${pts}`;
        if (this.completesLayer(blk)) { pts += cfg.score.layer; text += `, layer complete +${cfg.score.layer}`; }
        this.score[who] += pts;
        this.say(text, who);
      }
    } else {
      const pts = cfg.score.pull[p.tier];
      this.score[who] += pts;
      this.say(`P${who + 1} pulled a ${TIER_NAMES[p.tier]} block: +${pts}`, who);
    }
    if (knocked) {
      this.score[who] -= knocked * cfg.score.knock;
      this.say(`${knocked} block${knocked > 1 ? 's' : ''} knocked off: -${knocked * cfg.score.knock}`, who);
    }
    for (const blk of fallen) this.removeBlock(blk);
    this.refresh(0);
    this.advance(p.type);
  }

  advance(justDid) {
    const { cfg } = this;
    if (justDid === 'drop') {
      if (this.anyPullable()) { this.role = 'pull'; this.state = 'choose'; return; }
      this.say('Nothing can be pulled, so the pull is skipped.');
    }
    // The round is over.
    if (this.round >= cfg.roundsPerTower) { this.endTower('rounds', -1); return; }
    this.round++;
    if ((this.round - 1) % cfg.swapEvery === 0) {
      this.dropper = 1 - this.dropper;
      this.say(`Roles swap: P${this.dropper + 1} now drops, P${this.puller + 1} pulls.`);
    }
    this.role = 'drop';
    this.clampAim();
    this.state = 'aim';
  }

  endTower(reason, culprit) {
    const { cfg } = this;
    this.total[0] += this.score[0];
    this.total[1] += this.score[1];
    const last = this.towerIndex + 1 >= cfg.towers;
    this.result = {
      reason, culprit, score: this.score.slice(), total: this.total.slice(), last,
      winner: this.total[0] === this.total[1] ? -1 : this.total[0] > this.total[1] ? 0 : 1,
    };
    this.state = last ? 'gameOver' : 'towerEnd';
  }

  nextTower() {
    if (this.state !== 'towerEnd') return;
    this.towerIndex++;
    this.startTower(this.towerIndex % 2); // players take turns to drop first
  }

  // ------------------------------------------------------------ frame

  update(dt) {
    if (!this.world || this.state === 'menu') return;
    this.stepPhysics(dt);
    this.refresh(dt);

    if (this.state === 'pulling') {
      const pl = this.pull;
      pl.dist += this.cfg.pullSpeed * dt;
      if (pl.dist > this.cfg.size + 1.2) {
        this.pending = { type: 'pull', tier: pl.tier, player: pl.player, t: 0, before: this.standing(), id: -1 };
        this.pending.before.delete(pl.block.id);
        this.removeBlock(pl.block);
        this.pull = null;
        this.state = 'settle';
      }
      return;
    }

    if (this.state === 'settle') {
      this.pending.t += dt;
      if (this.pending.t > 0.4 && (!this.moving || this.pending.t > this.cfg.settleTimeout)) this.resolve();
    }
  }
}
