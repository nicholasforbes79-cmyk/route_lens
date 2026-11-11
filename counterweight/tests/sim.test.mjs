// Headless checks of the Counterweight rules. Run with:
//   node counterweight/tests/sim.test.mjs
import RAPIER from '../vendor/rapier2d-compat.mjs';
import { Game } from '../js/sim.js';

await RAPIER.init();

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
}
const run = (g, seconds) => { for (let i = 0; i < seconds * 60; i++) g.update(1 / 60); };
const cellCount = (g) => [...g.blocks.values()].reduce((n, b) => n + b.cells.length, 0);
const fresh = (config) => { const g = new Game(RAPIER, { seed: 7, config }); g.startMatch(0); return g; };
// Park the falling piece so it stays out of the way.
const park = (g) => { g.active = null; g.autoSpawn = false; };

{
  const g = fresh();
  park(g);
  run(g, 3);
  check('starter rows stand still', g.state === 'playing' && Math.abs(g.towerTop - 7) < 0.05, `top=${g.towerTop.toFixed(3)}`);
  check('starter has 40 cells', cellCount(g) === 40);
  check('pull zone is the bottom half', Math.abs(g.zoneTop - 5) < 0.05, `zoneTop=${g.zoneTop.toFixed(2)}`);
  const bottom = g.cellAt(0.5, 3.5), top = g.cellAt(0.5, 6.5);
  check('bottom cell carries more than top cell', bottom.load > top.load + 1, `${bottom.load.toFixed(1)} vs ${top.load.toFixed(1)}`);
  check('bottom cell is pullable, top cell is not', g.pullable(bottom) && !g.pullable(top));
}

{
  // Slow pull of one cell: scores, banks a cube, leaves the tower up.
  const g = fresh();
  park(g);
  run(g, 2);
  check('grab succeeds in the zone', g.pointerDown(4.5, 3.5));
  for (let i = 0; i <= 150; i++) { g.setPointer(4.5 + (i / 150) * 2.6, 3.5); g.update(1 / 60); }
  g.pointerUp();
  check('cell extracted', cellCount(g) === 39 && g.cellAt(4.5, 3.5) === null);
  check('puller scored', g.score[1] >= 10 && g.score[0] === 0, `score=${g.score}`);
  check('cube returned to the tray or queue', g.tray.length === 1 || g.queue.some((q) => q.name === 'cube'));
  run(g, 3);
  check('tower survives a slow pull', g.state === 'playing');
}

{
  // Pulling the middle of a straight piece splits it into two bodies.
  const g = fresh();
  park(g);
  run(g, 1);
  const before = g.blocks.size;
  g.extract(g.cellAt(1.5, 6.5));
  check('I piece splits in two', g.blocks.size === before + 1, `${before} -> ${g.blocks.size}`);
}

{
  // Dropping pieces: fill one row completely and it fuses.
  const g = fresh();
  g.active = null;
  for (const col of [0, 4]) {
    g.active = { name: 'I', mat: 'wood', cells: [[0, 0], [1, 0], [2, 0], [3, 0]], col, y: 7.2, held: false };
    g.releaseActive(1.5, false);
  }
  g.active = { name: 'O', mat: 'wood', cells: [[0, 0], [1, 0], [0, 1], [1, 1]], col: 8, y: 7.2, held: false };
  g.releaseActive(1.5, false);
  park(g);
  run(g, 5);
  const slabs = [...g.blocks.values()].filter((b) => b.slab);
  check('complete row fuses into a slab', slabs.length === 1 && slabs[0].cells.length === 10);
  check('dropper scored fusion, 3 placements and the milestone', g.score[0] === 50 + 30 + 25, `score=${g.score}`);
  check('slab is not pullable', !g.pullable(slabs[0].cells[0]));
  check('tower still up', g.state === 'playing');
}

{
  // Ripping out the three bottom rows at once brings the tower down, blamed on the puller.
  const g = fresh();
  park(g);
  run(g, 1);
  for (let r = 0; r < 3; r++) {
    for (let x = 0; x < 10; x++) { const c = g.cellAt(x + 0.5, 3.5 + r); if (c) g.extract(c); }
  }
  run(g, 6);
  check('collapse detected', g.state === 'result', `state=${g.state}`);
  check('puller takes all the blame', g.result.blame.pct[1] === 100, `blame=${g.result.blame.pct}`);
  check('collapse penalty applied', g.log.some((l) => l.player === 1 && l.text.startsWith('-150 collapse')));
  check('tower winner recorded', g.wins[0] + g.wins[1] === 1);
  const chooser = g.result.chooser;
  check('the loser chooses the next starting role', chooser === 1 - g.result.winner);
  g.nextTower('dropper');
  check('next tower starts with the chooser as Dropper', g.state === 'playing' && g.towerIndex === 1 && g.dropper === chooser);
}

{
  // Roles swap after the phase timer and a short freeze.
  const g = fresh({ phaseSeconds: 2, freezeSeconds: 1 });
  park(g);
  run(g, 2.1);
  check('freeze begins when the phase ends', g.state === 'freeze');
  run(g, 1.1);
  check('roles swapped', g.state === 'playing' && g.dropper === 1 && g.swapCount === 1);
  check('hot-potato window scales with height', (() => {
    const lo = g.hotPotatoWindow(); g.towerTop = 3 + 22; const hi = g.hotPotatoWindow(); g.towerTop = 3 + 60;
    return lo === 2 && hi === 3 && g.hotPotatoWindow() === 5;
  })());
}

{
  // The time cap ends the tower with a survival bonus.
  const g = fresh({ towerCapSeconds: 2, phaseSeconds: 60 });
  park(g);
  run(g, 2.2);
  check('time cap ends the tower', g.state === 'result' && g.result.reason === 'cap');
  check('both players get the survival bonus', g.score[0] === 100 && g.score[1] === 100, `score=${g.score}`);
}

{
  // Normal play: falling pieces land and the next one spawns.
  const g = fresh();
  g.hardDrop();
  check('nothing spawns inside the piece just dropped', g.active === null);
  run(g, 0.5);
  g.moveActive(-3);
  g.rotateActive(1);
  g.hardDrop();
  run(g, 4);
  check('hard-dropped pieces join the tower', cellCount(g) >= 48 && g.state === 'playing', `cells=${cellCount(g)}`);
  check('a new piece is falling', !!g.active);
  check('placements scored', g.score[0] >= 20, `score=${g.score}`);
}

{
  // A piece dropped onto the ground outside the walls is removed and costs 10.
  const g = fresh();
  park(g);
  const blk = g.createBlock([{ lx: 0.5, ly: 0.5, mat: 'wood' }], -4, 2, 0);
  blk.placedBy = 0;
  run(g, 3);
  check('a misdropped piece is removed, not a collapse', g.state === 'playing' && !g.blocks.has(blk.id));
  check('misdrop costs the Dropper 10', g.score[0] === -10, `score=${g.score}`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
