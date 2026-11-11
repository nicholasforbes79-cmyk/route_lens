// Every balancing lever from the design spec (docs/counterweight-design-spec.md §14)
// lives here so it can be tuned in one place.

export const CONFIG = {
  // Playfield (world units are cells, y points up, the ground is y = 0)
  wellWidth: 10,
  foundationRows: 3, // static base, never pullable
  wallTop: 11, // side walls cover the first 8 rows above the foundation; above that the tower stands free
  gravity: 20,
  step: 1 / 120,
  restitution: 0,
  linearDamping: 0,
  angularDamping: 1,

  // Match structure
  phaseSeconds: 60,
  swapWarnSeconds: 10,
  freezeSeconds: 3,
  freezeTimeScale: 0.25,
  towerCapSeconds: 360,
  towersPerMatch: 5,

  // Dropper
  fallSpeed: 1.5, // cells per second
  softDropSpeed: 10,
  hardDropSpeed: 6, // release speed; the fall adds the rest, so higher drops hit harder
  spawnClearance: 6,
  specialEvery: 8,
  specials: ['lead', 'ice'],

  // Puller
  pullZoneFraction: 0.5,
  pullDistance: 2.5, // cells of mouse travel for a full extraction
  safePullSpeed: 0.6, // extraction progress per second that disturbs nothing
  yankImpulse: 2.5, // how hard a too-fast pull drags the neighbours
  tapLockout: 0.75,

  // Stress: a cell carrying `stressShare` times its column's share reads 100%
  stressShare: 2,
  stressThresholds: [0.3, 0.6, 0.8],
  stressMultipliers: [1, 2, 4, 8],

  score: { placed: 10, lost: 10, row: 50, pull: 10, clean: 5, milestone: 25, collapse: 150, survive: 100 },
  milestoneRows: 5,

  // Blame
  blameWindow: 20,
  blameHalfLife: 6,
  hotPotatoBase: 2,
  hotPotatoPer5Rows: 0.5,
  hotPotatoCap: 5,

  // Collapse detection
  collapseCells: 10, // settled cells that must fall for it to count as a collapse
  collapseDrop: 2,
  collapseWindow: 1.5,
  collapseSlowMo: 0.3,
  collapseSeconds: 2.5,
};

export const MATERIALS = {
  wood: { density: 1, friction: 0.6 },
  lead: { density: 3, friction: 0.6 },
  ice: { density: 1, friction: 0.05 },
};

// Cell coordinates, y up, normalised so the smallest x and y are 0.
export const SHAPES = {
  I: [[0, 0], [1, 0], [2, 0], [3, 0]],
  O: [[0, 0], [1, 0], [0, 1], [1, 1]],
  T: [[0, 0], [1, 0], [2, 0], [1, 1]],
  S: [[0, 0], [1, 0], [1, 1], [2, 1]],
  Z: [[1, 0], [2, 0], [0, 1], [1, 1]],
  J: [[0, 0], [1, 0], [2, 0], [0, 1]],
  L: [[0, 0], [1, 0], [2, 0], [2, 1]],
  cube: [[0, 0]],
};

// Loose rows that sit on the foundation at the start of a tower, so the Puller
// has something to work on from the first second. Each letter is one piece.
// Listed top row first.
export const STARTER = [
  'AAAABBCCCC',
  'DDFFBBHHJJ',
  'DEEFGGHIIJ',
  'DEEFGGHIIJ',
];

export const TIER_NAMES = ['blue', 'green', 'yellow', 'red'];
