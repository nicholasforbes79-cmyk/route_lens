// lenses.js — loading, validating and scaling lenses.
// A lens reframes your route as some other journey. It knows nothing about
// maps or GPS: it just turns waypoints into fractions of the way along.

import { clamp } from './geo.js';

export const BUILTIN_LENS_IDS = [
  'solar-system',
  'hydrogen-atom',
  'blood-cell',
  'ocean-depth',
  'earth-history',
  'atmosphere',
  'everest',
  'apollo-11',
  'mount-doom',
  'marathon',
];

/** Throws with a readable message if the lens is malformed. Returns the lens. */
export function validateLens(lens) {
  const fail = (msg) => { throw new Error(`lens "${lens && lens.id || '?'}": ${msg}`); };

  if (!lens || typeof lens !== 'object') fail('not an object');
  if (!lens.id) fail('missing id');
  if (!lens.title) fail('missing title');
  // Number.isFinite, not typeof: an empty number field parses to NaN, which is
  // of type "number" and slips past every comparison below without complaint.
  if (!lens.domain || !Number.isFinite(lens.domain.from) || !Number.isFinite(lens.domain.to)) {
    fail('needs a start and end value for the journey it maps onto');
  }
  if (lens.domain.to <= lens.domain.from) fail('the end value must be greater than the start value');

  const scale = lens.scale || 'linear';
  if (!SCALES.includes(scale)) fail(`unknown scale "${scale}"`);

  if (!Array.isArray(lens.waypoints) || lens.waypoints.length === 0) fail('needs at least one waypoint');
  lens.waypoints.forEach((w, i) => {
    if (typeof w.at !== 'number' || !Number.isFinite(w.at)) fail(`waypoint ${i} has a non-numeric "at"`);
    if (!w.name) fail(`waypoint ${i} has no name`);
  });
  return lens;
}

export const SCALES = ['linear', 'power', 'log', 'rank'];

/**
 * Where a domain value falls on the route, as a fraction 0..1.
 *
 * "rank" ignores domain values entirely and spreads waypoints evenly, so it is
 * handled in lensMilestones rather than here; asking for a single value under
 * it falls back to linear.
 *
 * The log form uses log1p so a domain starting at zero needs no special case —
 * `epsilon` sets how much of the near end gets stretched.
 */
export function scalePosition(lens, at) {
  const { from, to } = lens.domain;
  const span = to - from;
  const p = clamp(at - from, 0, span);

  switch (lens.scale || 'linear') {
    case 'power': {
      const k = (lens.power && lens.power.exponent) || 0.5;
      return clamp((p / span) ** k, 0, 1);
    }
    case 'log': {
      const eps = (lens.log && lens.log.epsilon) || span / 1000;
      return clamp(Math.log1p(p / eps) / Math.log1p(span / eps), 0, 1);
    }
    default:
      return clamp(p / span, 0, 1);
  }
}

/** Inverse of scalePosition — the domain value at a fraction of the route. */
export function domainValueAt(lens, fraction) {
  const { from, to } = lens.domain;
  const span = to - from;
  const f = clamp(fraction, 0, 1);

  switch (lens.scale || 'linear') {
    case 'power': {
      const k = (lens.power && lens.power.exponent) || 0.5;
      return from + span * f ** (1 / k);
    }
    case 'log': {
      const eps = (lens.log && lens.log.epsilon) || span / 1000;
      return from + eps * (Math.expm1(f * Math.log1p(span / eps)));
    }
    default:
      return from + f * span;
  }
}

/**
 * Turn a lens into milestone entries. Waypoints outside the domain are dropped
 * rather than clamped, so a typo cannot silently pile everything onto 0 or 1.
 * `trueFraction` is always the honest linear position, so the UI can show how
 * much a non-linear scale is distorting the pacing.
 */
export function lensMilestones(lens) {
  validateLens(lens);
  const { from, to } = lens.domain;
  const span = to - from;

  const kept = lens.waypoints
    .filter((w) => w.at >= from && w.at <= to)
    .sort((a, b) => a.at - b.at);

  const isRank = (lens.scale || 'linear') === 'rank';

  return kept.map((w, i) => ({
    // Rank spreads across (0, 1] rather than [0, 1]: a waypoint at exactly 0
    // would be treated as already passed and never announced.
    fraction: isRank ? (i + 1) / kept.length : scalePosition(lens, w.at),
    trueFraction: clamp((w.at - from) / span, 0, 1),
    title: w.name,
    body: w.body || '',
    kind: 'lens',
    key: `lens:${lens.id}:${w.id || slug(w.name)}`,
    source: `lens:${lens.id}`,
    lensTitle: lens.title,
    at: w.at,
    atLabel: w.atLabel || `${formatNumber(w.at)} ${lens.unitShort || lens.unit || ''}`.trim(),
    unit: lens.unit || '',
  }));
}

/**
 * How badly a scale bunches waypoints up, so the UI can offer a better one.
 * headShare = proportion of stops landing in the first 5% of the route.
 */
export function crowdingReport(lens) {
  const ms = lensMilestones(lens);
  if (ms.length < 2) return { headShare: 0, maxGap: 1, crowded: false };

  let maxGap = ms[0].fraction;
  for (let i = 1; i < ms.length; i++) maxGap = Math.max(maxGap, ms[i].fraction - ms[i - 1].fraction);

  const headShare = ms.filter((m) => m.fraction <= 0.05).length / ms.length;
  const bunched = headShare > 0.3;
  const gappy = maxGap > 0.25;
  return { headShare, maxGap, bunched, gappy, crowded: bunched || gappy, count: ms.length };
}

/**
 * Plain-English version of a crowding report. The two conditions are quite
 * different problems, so the message has to say which one actually fired —
 * otherwise a lens with one long empty stretch is described as "bunched up",
 * with 0% of its stops in the first 5%.
 */
export function crowdingMessage(report) {
  if (!report || !report.crowded) return '';
  const head = Math.round(report.headShare * report.count);
  const gap = Math.round(report.maxGap * 100);

  if (report.bunched && report.gappy) {
    return `${head} of ${report.count} stops land in the first 5%, and there is a ${gap}% stretch with nothing in it.`;
  }
  if (report.bunched) {
    return `${head} of ${report.count} stops land in the first 5% of the route.`;
  }
  return `There is a ${gap}% stretch of the route with nothing to announce.`;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function formatNumber(n) {
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-GB', { maximumFractionDigits: 1 });
  if (Math.abs(n) >= 1) return String(Math.round(n * 10) / 10);
  return String(n);
}

/** Fetch and validate the built-in lenses that ship as JSON files. */
export async function loadBuiltinLenses(ids = BUILTIN_LENS_IDS) {
  const loaded = await Promise.all(ids.map(async (id) => {
    try {
      const res = await fetch(`lenses/${id}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return validateLens(await res.json());
    } catch (err) {
      console.warn(`Could not load lens "${id}":`, err.message);
      return null;
    }
  }));
  return loaded.filter(Boolean);
}
