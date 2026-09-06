// tracker.js — turns a stream of GPS fixes into progress along the route.
//
// The platform-specific bits (watchPosition) are confined here so that a
// Capacitor wrapper, or the simulator, can feed the same pipeline.

import { createSnapper } from './geo.js';

export const TRACKER_DEFAULTS = {
  highAccuracy: true,
  maximumAge: 2000,
  timeout: 20000,
  staleAfterMs: 20000,     // no fix for this long and the reading is suspect
  confidentAccuracy: 50,   // m — above this, milestones wait for a better fix
};

/**
 * @param {object} geometry from buildRoute()
 * @param {object} handlers { onFix, onStatus }
 */
export function createTracker(geometry, handlers = {}, options = {}) {
  const opts = { ...TRACKER_DEFAULTS, ...options };
  const snapper = createSnapper(geometry, options.snap);

  let watchId = null;
  let paused = false;
  let startedAt = null;
  let lastFixAt = null;
  let status = 'idle';     // idle | acquiring | tracking | offroute | stale | error
  let last = null;
  let staleTimer = 0;

  function setStatus(next, detail) {
    if (status === next) return;
    status = next;
    if (handlers.onStatus) handlers.onStatus(status, detail);
  }

  /** Feed one position — from the browser, or from the simulator. */
  function ingest({ lat, lng, accuracy = 0, speed = 0, timestamp }) {
    if (paused) return null;

    const now = timestamp ?? Date.now();
    lastFixAt = now;

    const snap = snapper.update(lat, lng, accuracy, speed || 0);
    const confident = accuracy > 0 && accuracy <= opts.confidentAccuracy;

    const fix = {
      lat,
      lng,
      accuracy,
      speed: speed || 0,
      along: snap.along ?? 0,
      fraction: snap.fraction,
      offRoute: snap.offRoute,
      distanceFromRoute: snap.distance,
      accepted: snap.accepted !== false,
      reason: snap.reason,
      confident: confident && !snap.offRoute,
      elapsedMs: startedAt ? now - startedAt : 0,
      at: now,
    };
    last = fix;

    setStatus(snap.offRoute ? 'offroute' : 'tracking');
    if (handlers.onFix) handlers.onFix(fix);
    return fix;
  }

  function onError(err) {
    setStatus('error', err && err.message);
  }

  return {
    get status() { return status; },
    get last() { return last; },
    get snapper() { return snapper; },
    get startedAt() { return startedAt; },

    /** Seed progress when resuming a journey already under way. */
    seed(metres) { snapper.seed(metres); },

    start() {
      if (watchId !== null) return true;
      startedAt = Date.now();
      setStatus('acquiring');

      if (!navigator.geolocation) {
        onError(new Error('This browser has no geolocation.'));
        return false;
      }
      watchId = navigator.geolocation.watchPosition(
        (p) => ingest({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: p.coords.accuracy,
          speed: p.coords.speed || 0,
          // position.timestamp is unreliable on some Android devices, so it is
          // never used for timing maths — only Date.now().
          timestamp: Date.now(),
        }),
        onError,
        {
          enableHighAccuracy: opts.highAccuracy,
          maximumAge: opts.maximumAge,
          timeout: opts.timeout,
        },
      );

      staleTimer = setInterval(() => {
        if (paused || lastFixAt === null) return;
        if (Date.now() - lastFixAt > opts.staleAfterMs) setStatus('stale');
      }, 5000);

      return true;
    },

    stop() {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      clearInterval(staleTimer);
      setStatus('idle');
    },

    pause() { paused = true; setStatus('idle'); },
    resume() { paused = false; setStatus('acquiring'); },
    get paused() { return paused; },

    ingest,
  };
}

/** Metres formatted for display. */
export function formatDistance(m) {
  if (!Number.isFinite(m)) return '–';
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

/** Seconds formatted as h:mm:ss or m:ss. */
export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}
