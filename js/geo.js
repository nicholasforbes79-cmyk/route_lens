// geo.js — pure route geometry. No DOM, no network, no imports.
// Everything else in the app depends on this; it depends on nothing.

const R = 6371008.8;          // IUGG mean Earth radius, metres
const DEG = Math.PI / 180;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Great-circle distance between two lat/lng points, in metres. */
export function haversine(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const a = s1 * s1 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Build the cumulative-distance table that every other lookup runs against.
 * @param {Array<[number,number]>} coordinates GeoJSON order: [lng, lat]
 */
export function buildRoute(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    throw new Error('buildRoute: a route needs at least two coordinates');
  }

  // ORS repeats identical vertices at manoeuvre nodes. Zero-length segments
  // make the interpolation parameter undefined and pollute the binary search,
  // so drop them here rather than guarding against them everywhere else.
  const lats = [];
  const lngs = [];
  for (const c of coordinates) {
    const la = c[1];
    const ln = c[0];
    if (!Number.isFinite(la) || !Number.isFinite(ln)) continue;
    const k = lats.length;
    if (k > 0 && haversine(lats[k - 1], lngs[k - 1], la, ln) < 0.05) continue;
    lats.push(la);
    lngs.push(ln);
  }
  const n = lats.length;
  if (n < 2) throw new Error('buildRoute: route collapsed to a single point');

  const lat = Float64Array.from(lats);
  const lng = Float64Array.from(lngs);
  const cum = new Float64Array(n);
  const segLen = new Float64Array(n - 1);

  for (let i = 1; i < n; i++) {
    const d = haversine(lat[i - 1], lng[i - 1], lat[i], lng[i]);
    segLen[i - 1] = d;
    cum[i] = cum[i - 1] + d;
  }
  // segLen is kept alongside cum deliberately: differencing two ~200,000 m
  // cumulative values loses precision at the far end of a long route.
  return { lat, lng, cum, segLen, count: n, total: cum[n - 1] };
}

/** Largest vertex index i in [0, count-2] whose cumulative distance <= metres. */
export function segmentIndexAt(route, metres) {
  const { cum, count } = route;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= metres) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(lo, count - 2);
}

/** Point at a given distance along the route, interpolated within its segment. */
export function positionAtDistance(route, metres) {
  const { lat, lng, cum, segLen, total } = route;
  const d = clamp(metres, 0, total);
  const i = segmentIndexAt(route, d);
  const len = segLen[i];
  const t = len > 0 ? (d - cum[i]) / len : 0;
  return {
    lat: lat[i] + (lat[i + 1] - lat[i]) * t,
    lng: lng[i] + (lng[i + 1] - lng[i]) * t,
    index: i,
    t,
    distance: d,
    fraction: total > 0 ? d / total : 0,
  };
}

/** Point at a fraction (0..1) of the way along the route. */
export function positionAt(route, fraction) {
  return positionAtDistance(route, clamp(fraction, 0, 1) * route.total);
}

/**
 * Closest point on segment A->B to P, worked in metres via a local
 * equirectangular projection centred on P — accurate well beyond any
 * plausible segment length, and far cheaper than repeated haversines.
 */
export function projectToSegment(pLat, pLng, aLat, aLng, bLat, bLng) {
  const cosLat = Math.cos(pLat * DEG);
  const k = DEG * R;
  const ax = (aLng - pLng) * k * cosLat;
  const ay = (aLat - pLat) * k;
  const bx = (bLng - pLng) * k * cosLat;
  const by = (bLat - pLat) * k;

  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;

  // P is the origin, so (P - A) is (-ax, -ay).
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = clamp(t, 0, 1);

  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return {
    t,
    distance: Math.hypot(cx, cy),
    lat: aLat + (bLat - aLat) * t,
    lng: aLng + (bLng - aLng) * t,
  };
}

/**
 * Nearest point on the route to P, scanning segments [fromIndex, toIndex].
 * Defaults to the whole route. Returns null if the range is empty.
 */
export function snapGlobal(route, pLat, pLng, fromIndex = 0, toIndex = route.count - 2, opts = {}) {
  const { lat, lng, cum, segLen } = route;
  const { expected = null, lambda = 0, lambdaBack = lambda } = opts;
  const lo = Math.max(0, fromIndex);
  const hi = Math.min(route.count - 2, toIndex);
  if (hi < lo) return null;

  let best = null;
  let bestCost = Infinity;

  for (let i = lo; i <= hi; i++) {
    const p = projectToSegment(pLat, pLng, lat[i], lng[i], lat[i + 1], lng[i + 1]);
    const along = cum[i] + p.t * segLen[i];

    // Where two parts of the route sit on top of each other — the two legs of
    // an out-and-back — perpendicular distance alone cannot tell them apart,
    // and the tie gets decided by floating-point noise. Penalising implausible
    // along-track jumps breaks it, but the penalty has to be ASYMMETRIC: at the
    // turnaround the outbound and return legs are exactly mirrored about the
    // expected position, so a symmetric penalty is still a coin flip. Progress
    // along a route runs forwards, so going backwards costs more.
    let cost = p.distance;
    if (expected !== null) {
      cost += along >= expected
        ? lambda * (along - expected)
        : lambdaBack * (expected - along);
    }

    if (cost < bestCost) {
      bestCost = cost;
      best = {
        distance: p.distance,   // the true perpendicular distance, unpenalised
        along,
        index: i,
        t: p.t,
        lat: p.lat,
        lng: p.lng,
      };
    }
  }
  return best;
}

export const SNAP_DEFAULTS = {
  backWindow: 100,        // m of route searched behind the last fix
  baseAhead: 150,         // m searched ahead before allowing for speed
  slack: 3,               // multiplier on how far you could plausibly have got
  maxAhead: 5000,         // cap on the forward window
  lambda: 0.2,            // penalty per metre of implausible forward jump
  lambdaBack: 0.6,        // heavier penalty per metre of going backwards
  offRouteMetres: 50,     // perpendicular distance that counts as off-route
  maxAccuracy: 30,        // m — fixes vaguer than this are discarded
  reverseTolerance: 60,   // m of backward slip tolerated before it is believed
  regressFixes: 3,        // consecutive backward fixes before believing them
  offRouteFixes: 3,       // consecutive bad fixes before declaring off-route
  confirmJumpFixes: 2,    // consecutive agreeing fixes before a global jump
  jumpAgreement: 100,     // m — how close two fixes must be to agree
  maxGapS: 45,            // s — beyond this the window is not trustworthy
  speedFloor: 1.4,        // m/s — assume at least walking pace
};

/**
 * Stateful snapper. A naive global search teleports you onto the return leg of
 * any out-and-back route, so we search a forward-biased window around the last
 * accepted position, and only fall back to a global search — confirmed over
 * two fixes — when the window cannot explain where we are.
 */
export function createSnapper(route, options = {}) {
  const opts = { ...SNAP_DEFAULTS, ...options };

  let along = null;      // last accepted distance along the route
  let index = 0;
  let offCount = 0;
  let regressCount = 0;
  let offRoute = false;
  let pending = null;    // candidate global jump awaiting confirmation
  let lastTime = null;   // performance.now() of the last accepted fix

  /**
   * Monotonic progress rule. Standing still with 12 m of GPS noise regularly
   * throws a fix 25 m back down the route, so a single backward reading is
   * held, not applied; only a sustained run of them is believed as a genuine
   * turn-around.
   */
  function advance(candidate, accuracy) {
    const tolerance = Math.max(opts.reverseTolerance, accuracy * 2);
    if (candidate < along - tolerance) {
      regressCount += 1;
      if (regressCount >= opts.regressFixes) { regressCount = 0; return candidate; }
      return along;
    }
    regressCount = 0;
    return Math.max(along, candidate);
  }

  /** Seconds since the last accepted fix, for sizing the search window. */
  function elapsed(dt) {
    if (typeof dt === 'number' && Number.isFinite(dt)) return clamp(dt, 0, 300);
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const gap = lastTime === null ? 0 : (now - lastTime) / 1000;
    lastTime = now;
    return clamp(gap, 0, 300);
  }

  function result(extra) {
    return {
      along,
      fraction: along === null || route.total === 0 ? 0 : clamp(along / route.total, 0, 1),
      index,
      offRoute,
      ...extra,
    };
  }

  return {
    get state() { return result({}); },

    reset() {
      along = null; index = 0; offCount = 0; regressCount = 0;
      offRoute = false; pending = null; lastTime = null;
    },

    /** Seed at a known distance — used when resuming a journey. */
    seed(metres) {
      along = clamp(metres, 0, route.total);
      index = segmentIndexAt(route, along);
      offCount = 0; regressCount = 0; offRoute = false; pending = null; lastTime = null;
    },

    /**
     * @param {number} lat
     * @param {number} lng
     * @param {number} [accuracy] metres
     * @param {number} [speed] m/s, if the fix reports it
     * @param {number} [dt] seconds since the last fix; measured if omitted
     */
    update(lat, lng, accuracy = 0, speed = 0, dt) {
      if (accuracy > opts.maxAccuracy) {
        return result({ accepted: false, reason: 'accuracy', distance: null });
      }
      const gap = elapsed(dt);

      // First fix: nothing to anchor to, so search everywhere.
      if (along === null) {
        const g = snapGlobal(route, lat, lng);
        if (!g) return result({ accepted: false, reason: 'empty', distance: null });
        along = g.along;
        index = g.index;
        offRoute = g.distance > opts.offRouteMetres;
        return result({ accepted: true, distance: g.distance, jumped: false });
      }

      // How far ahead could we plausibly have got since the last fix? After a
      // long gap the window means nothing, so fall straight through to global.
      const v = Math.max(speed || 0, opts.speedFloor);
      const ahead = Math.min(opts.baseAhead + v * gap * opts.slack, opts.maxAhead);
      const expected = along + v * gap;

      const from = segmentIndexAt(route, Math.max(0, along - opts.backWindow));
      const to = segmentIndexAt(route, Math.min(route.total, along + ahead));
      const local = gap > opts.maxGapS
        ? null
        : snapGlobal(route, lat, lng, from, to,
            { expected, lambda: opts.lambda, lambdaBack: opts.lambdaBack });

      if (local && local.distance <= opts.offRouteMetres) {
        pending = null;
        offCount = 0;
        offRoute = false;
        along = advance(local.along, accuracy);
        index = segmentIndexAt(route, along);
        return result({ accepted: true, distance: local.distance, jumped: false });
      }

      // The window cannot explain this fix. Is the route elsewhere nearby?
      const far = snapGlobal(route, lat, lng);
      if (far && far.distance <= opts.offRouteMetres) {
        if (pending && Math.abs(pending.along - far.along) <= opts.jumpAgreement) {
          pending.count += 1;
        } else {
          pending = { along: far.along, count: 1 };
        }
        if (pending.count >= opts.confirmJumpFixes) {
          along = far.along;           // a confirmed jump overrides monotonicity
          index = far.index;
          pending = null;
          offCount = 0;
          offRoute = false;
          return result({ accepted: true, distance: far.distance, jumped: true });
        }
      } else {
        pending = null;
      }

      offCount += 1;
      if (offCount >= opts.offRouteFixes) offRoute = true;
      return result({
        accepted: false,
        reason: 'off-route',
        distance: far ? far.distance : (local ? local.distance : null),
      });
    },
  };
}
