// Headless checks of the turn-based rules. Run with:
//   node counterweight/tests/game.test.mjs
import RAPIER from '../vendor/rapier3d-compat.mjs';
import { Game } from '../js/game.js';

await RAPIER.init();

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
}
const run = (g, seconds) => { for (let i = 0; i < seconds * 60; i++) g.update(1 / 60); };
const until = (g, states, max = 20) => { for (let i = 0; i < max * 60 && !states.includes(g.state); i++) g.update(1 / 60); };
const fresh = (config) => { const g = new Game(RAPIER, { seed: 11, config }); g.startGame(); return g; };
const drop = (g) => { g.beginDrop(); g.place(); until(g, ['choose', 'aim', 'towerEnd', 'gameOver']); };
const at = (g, x, y, z) => [...g.blocks.values()].find((b) => b.cells.some((c) => {
  const p = g.cellPos(b, c); return Math.abs(p.x - x) < 0.4 && Math.abs(p.y - y) < 0.25 && Math.abs(p.z - z) < 0.4;
}));

{
  const g = fresh();
  run(g, 3);
  check('starting tower stands', g.state === 'aim' && Math.abs(g.topY - 4.8) < 0.1, `top=${g.topY.toFixed(3)}`);
  check('starting tower has 8 layers', g.topLayer === 7 && g.blocks.size === 24);
  const tiers = [...g.blocks.values()].filter((b) => g.layerOf(b) <= 4).map((b) => g.tier(b));
  check('lower blocks read as carrying a fair load', tiers.filter((t) => t === 1).length >= tiers.length * 0.6, `tiers=${tiers.join('')}`);
  const base = at(g, 0.5, 0.3, 0.5), top = at(g, 0.5, 4.5, 0.5);
  check('bottom block carries more than top block', g.carried(base) > g.carried(top) + 2, `${g.carried(base).toFixed(1)} vs ${g.carried(top).toFixed(1)}`);
}

{
  // A drop lands on top, scores, and hands over to the Puller.
  const g = fresh();
  run(g, 1);
  const cells = g.piece.cells.length, kind = g.piece.kind;
  const y = g.landingY();
  check('piece would land on top of the tower', Math.abs(y - 5.1) < 0.12, `y=${y.toFixed(3)}`);
  drop(g);
  check('drop scores one point per cell', g.score[0] === cells, `${kind}: score=${g.score}`);
  check('then it is the Puller\'s move', g.state === 'choose' && g.role === 'pull' && g.mover === 1);
  check('tower grew by a layer', g.topLayer === 8);
}

{
  // Pull rules: not from the top two layers, and only along a clear path.
  const g = fresh();
  run(g, 1);
  drop(g);
  const topBlock = at(g, 0.5, 4.5, 0.5); // layer 7 of 0..8
  const edge = at(g, 0.5, 0.3, 0.5); // edge plank in the bottom layer
  const middle = at(g, 1.5, 0.3, 1.5); // middle plank in the bottom layer
  check('top layers are locked', !g.canPull(topBlock));
  check('edge plank can be pulled', g.canPull(edge));
  check('middle plank can only slide along its length', (() => {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([x, z]) => g.clearDir(middle, { x, z }));
    return dirs.length === 2 && dirs.every(([x, z]) => z === 0);
  })());
  const slabLayer = at(g, 0.5, 1.5, 0.5); // slab in layer 2, boxed by a plank and a half
  check('slab is boxed in on two sides', (() => {
    const d = g.pullDir(slabLayer, { x: 1, z: 0 });
    return d && !(d.x === 1) && !g.clearDir(slabLayer, { x: 1, z: 0 }) && !g.clearDir(slabLayer, { x: 0, z: 1 });
  })());
  const before = g.blocks.size;
  check('pull starts', g.startPull(middle, { x: 1, z: 0 }));
  until(g, ['aim', 'towerEnd', 'gameOver']);
  check('block is gone and the tower stands', g.blocks.size === before - 1 && g.state === 'aim', `state=${g.state} top=${g.topY.toFixed(2)}`);
  check('puller scored', g.score[1] >= 1, `score=${g.score}`);
  check('round advanced', g.round === 2 && g.role === 'drop' && g.dropper === 0);
}

{
  // Roles swap after three rounds; the tower ends after the last round.
  const g = fresh({ roundsPerTower: 4 });
  run(g, 1);
  for (let r = 0; r < 4 && g.state !== 'towerEnd'; r++) {
    drop(g);
    if (g.state === 'choose') {
      const blk = [...g.blocks.values()].filter((b) => g.canPull(b)).sort((a, b) => g.layerOf(b) - g.layerOf(a))[0];
      g.startPull(blk, { x: 0, z: 1 });
      until(g, ['aim', 'towerEnd', 'gameOver']);
    }
    if (r === 2) check('roles swap after round 3', g.dropper === 1 && g.round === 4, `dropper=${g.dropper} round=${g.round}`);
  }
  check('tower ends after the last round', g.state === 'towerEnd' && g.result.reason === 'rounds', `state=${g.state}`);
  g.nextTower();
  check('next tower starts with P2 dropping', g.state === 'aim' && g.towerIndex === 1 && g.dropper === 1 && g.total[0] + g.total[1] > 0);
}

{
  // Gutting the bottom of the tower brings it down on the Puller.
  const g = fresh();
  run(g, 1);
  drop(g);
  for (const blk of [at(g, 0.5, 0.3, 0.5), at(g, 0.5, 0.3, 1.5)]) g.removeBlock(blk);
  for (const blk of [at(g, 1.5, 0.9, 0.5), at(g, 2.5, 0.9, 0.5)]) g.removeBlock(blk);
  const last = at(g, 0.5, 0.9, 0.5);
  const scoreBefore = g.score[1];
  g.startPull(last, { x: 0, z: 1 });
  until(g, ['aim', 'towerEnd', 'gameOver'], 30);
  check('collapse ends the tower', g.state === 'towerEnd' && g.result.reason === 'collapse', `state=${g.state}`);
  check('the Puller is the culprit and loses 10', g.result.culprit === 1 && g.score[1] === scoreBefore - 10, `score=${g.score}`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
