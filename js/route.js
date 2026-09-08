// route.js — the OpenRouteService boundary.
//
// This is the ONLY module that sees GeoJSON [lng, lat] order. It converts once,
// here, and everything downstream works in {lat, lng}. Getting this wrong puts
// your route in the Indian Ocean, so it is deliberately confined to one file.

import { buildRoute } from './geo.js';
import { loadApiKey } from './storage.js';

const BASE = 'https://api.openrouteservice.org';

export const PROFILES = [
  { id: 'foot-walking', label: 'Walking' },
  { id: 'cycling-regular', label: 'Cycling' },
  { id: 'driving-car', label: 'Driving' },
];

export class OrsError extends Error {
  constructor(kind, message) { super(message); this.name = 'OrsError'; this.kind = kind; }
}

// The free tier allows roughly 40 requests a minute. A local floor keeps a
// stuck retry loop from burning the day's quota in a few seconds.
let lastCall = 0;
const MIN_GAP_MS = 1200;
async function throttle() {
  const wait = MIN_GAP_MS - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

function mapError(status, body) {
  if (status === 401 || status === 403) {
    return new OrsError('auth', 'That API key was rejected. Check it in Settings.');
  }
  if (status === 429) {
    return new OrsError('quota', 'OpenRouteService rate limit hit. Wait a minute and try again.');
  }
  const code = body && body.error && body.error.code;
  if (code === 2010 || code === 2009) {
    return new OrsError('noroute', 'No route found between those points for this travel mode.');
  }
  const msg = (body && body.error && (body.error.message || body.error)) || `HTTP ${status}`;
  return new OrsError('bad', String(msg));
}

/**
 * Fetch a route. Returns a geometry built by geo.js plus display metadata.
 *
 * Note the endpoint: /geojson. Without that suffix ORS returns an *encoded
 * polyline string*, not a LineString, which fails in a confusing place.
 */
export async function directions({ start, end, via = [], profile = 'foot-walking', signal }) {
  const key = loadApiKey();
  if (!key) throw new OrsError('auth', 'No OpenRouteService API key set. Add one in Settings.');

  // Start, any points along the way, then end. A loop is start and end at the
  // same place with at least one point in between — without that, there is
  // nothing to distinguish it from standing still.
  const points = [start, ...via, end];
  if (points.length > 50) throw new OrsError('bad', 'Too many points — 50 is the limit.');

  await throttle();
  let res;
  try {
    res = await fetch(`${BASE}/v2/directions/${profile}/geojson`, {
      method: 'POST',
      signal,
      headers: {
        Authorization: key,
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/geo+json',
      },
      body: JSON.stringify({
        coordinates: points.map((p) => [p.lng, p.lat]),
        instructions: false,
      }),
    });
  } catch (err) {
    throw new OrsError('network', `Could not reach OpenRouteService: ${err.message}`);
  }

  let body = null;
  try { body = await res.json(); } catch { /* fall through to status handling */ }
  if (!res.ok) throw mapError(res.status, body);

  const feature = body && body.features && body.features[0];
  if (!feature || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) {
    throw new OrsError('bad', 'OpenRouteService returned no route geometry.');
  }

  const geometry = buildRoute(feature.geometry.coordinates);
  const summary = (feature.properties && feature.properties.summary) || {};

  return {
    geometry,
    coordinates: feature.geometry.coordinates,
    profile,
    start,
    end,
    via,
    // Our own total is authoritative for every fraction calculation. ORS sums
    // on a slightly different model and differs by a few tenths of a percent,
    // which would otherwise make the 100% milestone fire at 99.6%.
    distance: geometry.total,
    orsDistance: summary.distance ?? null,
    duration: summary.duration ?? null,
  };
}

/** Type-ahead place search. Debounce callers to protect the quota. */
export async function geocode(text, { near = null, size = 6, signal } = {}) {
  const key = loadApiKey();
  if (!key) throw new OrsError('auth', 'No OpenRouteService API key set.');
  if (!text || text.trim().length < 3) return [];

  // Geocoding is Pelias behind the same account but takes the key as a query
  // parameter rather than an Authorization header — unlike directions above.
  const params = new URLSearchParams({ api_key: key, text: text.trim(), size: String(size) });
  if (near) {
    params.set('focus.point.lon', String(near.lng));
    params.set('focus.point.lat', String(near.lat));
  }

  await throttle();
  const res = await fetch(`${BASE}/geocode/autocomplete?${params}`, { signal });
  if (!res.ok) throw mapError(res.status, await res.json().catch(() => null));

  const body = await res.json();
  return (body.features || []).map((f) => ({
    label: f.properties.label,
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0],
  }));
}

/**
 * Straight lines between the points, so the app is usable with no API key.
 * With points in between it traces those legs, which is what makes a loop
 * measurable rather than collapsing to nothing.
 */
export function straightLineRoute({ start, end, via = [] }) {
  const points = [start, ...via, end];
  const perLeg = Math.max(8, Math.round(96 / (points.length - 1)));
  const coords = [];

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    for (let s = 0; s < perLeg; s++) {
      const t = s / perLeg;
      coords.push([a.lng + (b.lng - a.lng) * t, a.lat + (b.lat - a.lat) * t]);
    }
  }
  coords.push([end.lng, end.lat]);

  const geometry = buildRoute(coords);
  return {
    geometry,
    coordinates: coords,
    profile: 'straight-line',
    start,
    end,
    via,
    distance: geometry.total,
    orsDistance: null,
    duration: null,
    approximate: true,
  };
}
