// Tuning values for the turn-based 3D game. World units: one cell is 1 wide,
// 1 deep and 0.6 tall. The tower stands on a plinth whose top is y = 0.

export const CFG = {
  size: 3, // the tower footprint is size × size cells
  cellHeight: 0.6,
  gravity: 20,
  step: 1 / 120,
  friction: 0.6,

  towers: 3, // towers per game
  roundsPerTower: 12, // one round = one drop, then one pull
  swapEvery: 3, // rounds between role swaps
  topLocked: 2, // the Puller may not take from this many top layers

  pullSpeed: 2.4, // cells per second
  settleQuiet: 0.5, // seconds of stillness that end a move
  settleTimeout: 7,

  score: { cell: 1, layer: 3, pull: [1, 2, 4], knock: 2, collapse: 10 },
  collapseBlocks: 3, // this many blocks hitting the table is a collapse
  tierLimits: [0.7, 1.4], // carried load ÷ fair share: light | medium | heavy
};

// Flat pieces, one cell tall. Coordinates are [x, z] cells.
export const SHAPES = {
  plank: [[0, 0], [1, 0], [2, 0]],
  half: [[0, 0], [1, 0]],
  corner: [[0, 0], [1, 0], [0, 1]],
  slab: [[0, 0], [1, 0], [0, 1], [1, 1]],
  cube: [[0, 0]],
};

// How often each shape comes out of the sky (relative weights).
export const SUPPLY = { plank: 3, half: 3, corner: 3, slab: 1, cube: 2 };

const A = [
  ['plank', [[0, 0], [1, 0], [2, 0]]],
  ['plank', [[0, 1], [1, 1], [2, 1]]],
  ['plank', [[0, 2], [1, 2], [2, 2]]],
];
const B = [
  ['plank', [[0, 0], [0, 1], [0, 2]]],
  ['plank', [[1, 0], [1, 1], [1, 2]]],
  ['plank', [[2, 0], [2, 1], [2, 2]]],
];
const C = [
  ['slab', [[0, 0], [1, 0], [0, 1], [1, 1]]],
  ['plank', [[2, 0], [2, 1], [2, 2]]],
  ['half', [[0, 2], [1, 2]]],
];
const C2 = [
  ['slab', [[1, 1], [2, 1], [1, 2], [2, 2]]],
  ['plank', [[0, 0], [0, 1], [0, 2]]],
  ['half', [[1, 0], [2, 0]]],
];

// The tower every game starts with, bottom layer first.
export const START_LAYERS = [A, B, C, A, B, C2, A, B];

export const TIER_NAMES = ['light', 'medium', 'heavy'];
