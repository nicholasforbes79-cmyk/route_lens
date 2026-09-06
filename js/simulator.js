// simulator.js — a fake GPS that walks a route, so the tracker can be tested
// indoors. Also powers the debug "simulate journey" mode in the app.

import { positionAtDistance } from './geo.js';

const DEG = Math.PI / 180;
const R = 6371008.8;

/** Box–Muller, seeded so a failing test is reproducible. */
function makeRandom(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function gaussian(rand) {
  const u = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Offset a lat/lng by metres east and north. */
export function offsetMetres(lat, lng, east, north) {
  return {
    lat: lat + north / (R * DEG),
    lng: lng + east / (R * DEG * Math.cos(lat * DEG)),
  };
}

/**
 * Generate a sequence of synthetic fixes travelling along a route.
 *
 * @param {object} route      from buildRoute()
 * @param {object} opts
 *   speedMps    travel speed (default 1.4, a walk)
 *   intervalS   seconds between fixes (default 1)
 *   noiseM      standard deviation of positional noise (default 0)
 *   accuracyM   reported accuracy (default max(5, noiseM * 2))
 *   startD      metres along to start at (default 0)
 *   endD        metres along to stop at (default route total)
 *   seed        RNG seed
 *   stationary  { atD, seconds }  stand still for a while
 *   excursion   { atD, metres, fixes }  wander off perpendicular to the route
 * @returns {Array<{lat,lng,accuracy,speed,t}>}
 */
export function simulateFixes(route, opts = {}) {
  const {
    speedMps = 1.4,
    intervalS = 1,
    noiseM = 0,
    startD = 0,
    endD = route.total,
    seed = 1,
    stationary = null,
    excursion = null,
  } = opts;
  const accuracyM = opts.accuracyM ?? Math.max(5, noiseM * 2);

  const rand = makeRandom(seed);
  const fixes = [];
  let t = 0;
  let d = startD;
  let didStationary = false;
  let didExcursion = false;

  const push = (dist, east = 0, north = 0, extraAcc = 0) => {
    const p = positionAtDistance(route, dist);
    const jE = east + (noiseM ? gaussian(rand) * noiseM : 0);
    const jN = north + (noiseM ? gaussian(rand) * noiseM : 0);
    const o = offsetMetres(p.lat, p.lng, jE, jN);
    fixes.push({
      lat: o.lat, lng: o.lng,
      accuracy: accuracyM + extraAcc,
      speed: speedMps,
      t,
      trueD: dist,
    });
    t += intervalS;
  };

  const step = speedMps * intervalS;
  const MAX_FIXES = 200000;   // a stalled loop would hang the page, so cap it

  while (d <= endD && fixes.length < MAX_FIXES) {
    if (stationary && !didStationary && d >= stationary.atD) {
      didStationary = true;
      const n = Math.round(stationary.seconds / intervalS);
      for (let i = 0; i < n; i++) push(d, 0, 0, stationary.extraAccuracy || 0);
    }

    if (excursion && !didExcursion && d >= excursion.atD) {
      didExcursion = true;
      // Step sideways off the route, linger, then come back.
      const n = excursion.fixes || 5;
      for (let i = 1; i <= n; i++) {
        const away = excursion.metres * Math.sin((i / n) * Math.PI);
        push(d, away, 0);
      }
    }

    push(d);

    // Standing still is a legitimate request (the jitter test), but it must
    // not turn the loop into a spin: emit the stationary burst and stop.
    if (step <= 0) break;
    d += step;
  }

  return fixes;
}

/**
 * Build an out-and-back coordinate list from a one-way one: the killer case
 * for route snapping, because the return leg is zero metres away in space but
 * half a route away in distance.
 */
export function outAndBack(coordinates) {
  const back = coordinates.slice(0, -1).reverse();
  return [...coordinates, ...back];
}

/** A straight east–west line of `points` vertices spanning `lengthM`. */
export function straightLine(lat, lng, lengthM, points = 21) {
  const out = [];
  for (let i = 0; i < points; i++) {
    const o = offsetMetres(lat, lng, (lengthM * i) / (points - 1), 0);
    out.push([o.lng, o.lat]);
  }
  return out;
}
