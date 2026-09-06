// app.js — bootstrap and screen wiring.

import { positionAt } from './geo.js';
import {
  loadBuiltinLenses, crowdingReport, crowdingMessage, domainValueAt,
  lensMilestones, validateLens,
} from './lenses.js';
import { compileMilestones, createMilestoneEngine } from './milestones.js';
import { createTracker, formatDistance, formatDuration } from './tracker.js';
import { directions, straightLineRoute, PROFILES, OrsError } from './route.js';
import {
  loadSettings, saveSettings, loadApiKey, saveApiKey, requestPersistence,
  put, del, all, uid,
} from './storage.js';
import {
  unlock, speak, vibrate, pickVoice, canSpeak, canVibrate, VIBRATION,
  acquireWakeLock, releaseWakeLock, keepWakeLock, stopSpeaking,
} from './alerts.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: loadSettings(),
  lenses: [],           // built-ins plus the user's own
  builtinLenses: [],
  arming: 'start',
  start: null,
  end: null,
  route: null,
  milestones: [],
  markers: { start: null, end: null },
  line: null,
  ticks: [],
};

// ------------------------------------------------------------------ screens

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('is-active', s.id === id);
  if (id === 'screen-plan' && map) setTimeout(() => map.invalidateSize(), 0);
}

// --------------------------------------------------------------------- map

let map = null;

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([51.505, -0.12], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  map.on('click', (e) => setPoint(state.arming, { lat: e.latlng.lat, lng: e.latlng.lng }));
}

function setPoint(role, point) {
  state[role] = point;

  const colour = role === 'start' ? '#4ade80' : '#ff5c8a';
  if (state.markers[role]) map.removeLayer(state.markers[role]);
  state.markers[role] = L.circleMarker([point.lat, point.lng], {
    radius: 9, color: colour, weight: 3, fillColor: colour, fillOpacity: 0.5,
  }).addTo(map);

  $(`${role}-label`).textContent = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;

  // Setting the start arms the end next — the common order when out walking.
  if (role === 'start' && !state.end) arm('end');
  refreshPlanButton();
}

function arm(role) {
  state.arming = role;
  $('pick-start').classList.toggle('is-armed', role === 'start');
  $('pick-end').classList.toggle('is-armed', role === 'end');
}

function refreshPlanButton() {
  $('get-route').disabled = !(state.start && state.end);
}

function drawRoute(route) {
  if (state.line) map.removeLayer(state.line);
  const latlngs = route.coordinates.map((c) => [c[1], c[0]]);
  state.line = L.polyline(latlngs, { color: '#6c5ce7', weight: 5, opacity: 0.9 }).addTo(map);
  map.fitBounds(state.line.getBounds(), { padding: [30, 30] });
}

function drawTicks(milestones, route) {
  for (const t of state.ticks) map.removeLayer(t);
  state.ticks = milestones.map((m) => {
    const p = positionAt(route.geometry, m.fraction);
    return L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: '', html: '<div class="tick"></div>', iconSize: [10, 10] }),
    }).addTo(map).bindTooltip(m.title);
  });
}

// ---------------------------------------------------------------- geolocate

function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser has no geolocation.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (err) => reject(new Error(
        err.code === err.PERMISSION_DENIED
          ? 'Location permission denied. Note that geolocation needs an HTTPS page.'
          : `Could not get a location fix (${err.message}).`)),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
  });
}

// ------------------------------------------------------------------ routing

async function fetchRoute() {
  const status = $('plan-status');
  status.className = 'status';
  status.textContent = 'Fetching route…';
  $('get-route').disabled = true;

  const profile = $('profile').value;
  try {
    let route;
    if (loadApiKey()) {
      route = await directions({ start: state.start, end: state.end, profile });
    } else {
      route = straightLineRoute({ start: state.start, end: state.end });
      status.textContent = 'No API key — using a straight line. Add a key in Settings for a real route.';
    }
    state.route = route;
    drawRoute(route);
    saveSettings({ profile });
    openSetup();
  } catch (err) {
    status.className = 'status is-error';
    status.textContent = err instanceof OrsError ? err.message : `Something went wrong: ${err.message}`;
  } finally {
    $('get-route').disabled = false;
  }
}

// ------------------------------------------------------------- setup screen

const FRACTION_PRESETS = [
  { n: 2, label: 'Halves' },
  { n: 3, label: 'Thirds' },
  { n: 4, label: 'Quarters' },
  { n: 10, label: 'Every 10%' },
  { n: 20, label: 'Every 5%' },
];

function openSetup() {
  const r = state.route;
  const km = (r.distance / 1000).toFixed(2);
  const mins = r.duration ? ` · about ${Math.round(r.duration / 60)} min` : '';
  $('route-summary').innerHTML =
    `<b>${km} km</b>${mins}${r.approximate ? ' · straight-line estimate' : ''}`;

  renderFractionChips();
  renderLenses();
  recompile();
  show('screen-setup');
}

function renderFractionChips() {
  const wrap = $('fraction-chips');
  wrap.innerHTML = '';
  const chosen = new Set(state.settings.denominators);
  const shown = [...new Set([...FRACTION_PRESETS.map((p) => p.n), ...chosen])].sort((a, b) => a - b);

  for (const n of shown) {
    const preset = FRACTION_PRESETS.find((p) => p.n === n);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chip${chosen.has(n) ? ' is-on' : ''}`;
    btn.textContent = preset ? preset.label : `Every 1/${n}`;
    btn.onclick = () => {
      const set = new Set(state.settings.denominators);
      set.has(n) ? set.delete(n) : set.add(n);
      state.settings = saveSettings({ denominators: [...set].sort((a, b) => a - b) });
      renderFractionChips();
      recompile();
    };
    wrap.append(btn);
  }
}

function renderLenses() {
  const wrap = $('lens-list');
  wrap.innerHTML = '';

  const none = document.createElement('button');
  none.type = 'button';
  none.className = `lens${state.settings.lensId ? '' : ' is-on'}`;
  none.innerHTML = '<b>No lens</b><span>Fractions only</span>';
  none.onclick = () => { state.settings = saveSettings({ lensId: null }); renderLenses(); recompile(); };
  wrap.append(none);

  for (const lens of state.lenses) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `lens${state.settings.lensId === lens.id ? ' is-on' : ''}`;
    btn.innerHTML =
      `<b>${escapeHtml(lens.title)}${lens.custom ? '<span class="badge">yours</span>' : ''}</b>` +
      `<span>${escapeHtml(lens.subtitle || '')}</span>`;
    btn.onclick = () => {
      state.settings = saveSettings({ lensId: lens.id });
      renderLenses();
      recompile();
    };
    wrap.append(btn);

    if (lens.custom) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'lens-edit';
      edit.textContent = `Edit “${lens.title}”`;
      edit.onclick = () => openLensEditor(lens);
      wrap.append(edit);
    }
  }

  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'ghost-btn';
  create.textContent = '+  Write your own lens';
  create.onclick = () => openLensEditor(null);
  wrap.append(create);
}

function activeLens() {
  const lens = state.lenses.find((l) => l.id === state.settings.lensId);
  if (!lens) return null;
  const override = state.settings.lensScales[lens.id];
  return override ? { ...lens, scale: override } : lens;
}

function recompile() {
  if (!state.route) return;
  const lens = activeLens();
  state.milestones = compileMilestones(state.route.distance, {
    denominators: state.settings.denominators,
    lens,
    minSpacingM: state.settings.minSpacingM ?? undefined,
  });

  renderPreview();
  renderCrowding(lens);
  drawTicks(state.milestones, state.route);
}

function renderCrowding(lens) {
  const box = $('crowding');
  if (!lens || (lens.scale || 'linear') !== 'linear') { box.hidden = true; return; }

  const report = crowdingReport(lens);
  if (!report.crowded) { box.hidden = true; return; }

  box.hidden = false;
  box.innerHTML =
    `<div>${escapeHtml(crowdingMessage(report))} That is the honest spacing — but you can even it out.</div>`;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost-btn';
  btn.textContent = 'Even out the pacing';
  btn.onclick = () => {
    const scales = { ...state.settings.lensScales, [lens.id]: 'power' };
    state.settings = saveSettings({ lensScales: scales });
    recompile();
  };
  box.append(btn);
}

function renderPreview() {
  const list = $('milestone-preview');
  list.innerHTML = '';
  const total = state.route.distance;

  $('milestone-count').textContent = state.milestones.length
    ? `${state.milestones.length} alerts, on average ${Math.round(total / state.milestones.length)} m apart.`
    : 'No milestones chosen yet.';

  for (const m of state.milestones) {
    const li = document.createElement('li');
    const at = m.d >= 1000 ? `${(m.d / 1000).toFixed(2)} km` : `${Math.round(m.d)} m`;
    const also = m.alsoPassed && m.alsoPassed.length
      ? `<span class="also">with ${m.alsoPassed.map((a) => a.title).join(', ')}</span>` : '';
    li.innerHTML = `<span class="at">${at}</span><span>${m.title}${also}</span>`;
    list.append(li);
  }
}

// ----------------------------------------------------------------- settings

function openSettings() {
  $('api-key').value = loadApiKey();
  $('opt-speech').checked = state.settings.speech;
  $('opt-vibrate').checked = state.settings.vibrate;
  $('opt-wakelock').checked = state.settings.wakeLock;
  $('key-status').textContent = loadApiKey() ? 'A key is saved on this device.' : '';
  show('screen-settings');
}

// ------------------------------------------------------------- lens editor

const editor = { id: null, isNew: true };

function blankLens() {
  return {
    id: `user-${uid()}`,
    title: '',
    subtitle: '',
    unit: '',
    unitShort: '',
    scale: 'linear',
    custom: true,
    domain: { from: 0, to: 100, startLabel: '', endLabel: '' },
    waypoints: [{ at: 50, name: '', body: '' }],
  };
}

function waypointRow(w = { at: '', name: '', body: '' }) {
  const row = document.createElement('div');
  row.className = 'wp';
  row.innerHTML = `
    <input class="wp-at" type="number" step="any" placeholder="0" value="${w.at ?? ''}">
    <input class="wp-name" type="text" placeholder="What is here?" value="${escapeAttr(w.name || '')}">
    <button class="wp-del" type="button" aria-label="Remove">&#10005;</button>
    <textarea class="wp-body" rows="2" placeholder="Say something interesting about it">${escapeHtml(w.body || '')}</textarea>
    <div class="wp-hint"></div>`;
  row.querySelector('.wp-del').onclick = () => { row.remove(); renderEditorPreview(); };
  for (const input of row.querySelectorAll('input, textarea')) {
    input.oninput = renderEditorPreview;
  }
  return row;
}

const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;');

function openLensEditor(lens) {
  const l = lens || blankLens();
  editor.id = l.id;
  editor.isNew = !lens;

  $('ed-title').value = l.title || '';
  $('ed-subtitle').value = l.subtitle || '';
  $('ed-unit').value = l.unit || '';
  $('ed-unit-short').value = l.unitShort || '';
  $('ed-from').value = l.domain.from ?? 0;
  $('ed-to').value = l.domain.to ?? '';
  $('ed-start-label').value = l.domain.startLabel || '';
  $('ed-end-label').value = l.domain.endLabel || '';
  $('ed-scale').value = l.scale || 'linear';

  const wrap = $('ed-waypoints');
  wrap.innerHTML = '';
  for (const w of l.waypoints) wrap.append(waypointRow(w));

  $('ed-delete').hidden = editor.isNew;
  $('ed-status').textContent = '';
  $('ed-status').className = 'status';
  $('ed-json').hidden = true;
  $('ed-load').hidden = true;

  renderEditorPreview();
  show('screen-lens-editor');
}

/** Read the form back into a lens object. Never throws — validation is separate. */
function readEditorLens() {
  const waypoints = [...$('ed-waypoints').children].map((row) => ({
    at: parseFloat(row.querySelector('.wp-at').value),
    name: row.querySelector('.wp-name').value.trim(),
    body: row.querySelector('.wp-body').value.trim(),
  })).filter((w) => w.name || Number.isFinite(w.at));

  return {
    id: editor.id,
    custom: true,
    title: $('ed-title').value.trim(),
    subtitle: $('ed-subtitle').value.trim(),
    unit: $('ed-unit').value.trim(),
    unitShort: $('ed-unit-short').value.trim(),
    scale: $('ed-scale').value,
    domain: {
      from: parseFloat($('ed-from').value) || 0,
      to: parseFloat($('ed-to').value),
      startLabel: $('ed-start-label').value.trim(),
      endLabel: $('ed-end-label').value.trim(),
    },
    waypoints,
  };
}

function renderEditorPreview() {
  const lens = readEditorLens();
  const list = $('ed-preview');
  const note = $('ed-preview-note');
  list.innerHTML = '';

  let ms;
  try {
    ms = lensMilestones(lens);
  } catch (err) {
    note.textContent = err.message;
    return;
  }

  // Preview against the loaded route where there is one, so the numbers are
  // the actual distances you would walk.
  const total = state.route ? state.route.distance : null;
  const report = crowdingReport(lens);
  note.textContent = total
    ? `${ms.length} stops on your ${(total / 1000).toFixed(2)} km route.`
    : `${ms.length} stops. Load a route to see real distances.`;
  if (report.crowded) note.textContent += ` ${crowdingMessage(report)}`;

  for (const m of ms) {
    const li = document.createElement('li');
    const at = total
      ? (m.fraction * total >= 1000
        ? `${((m.fraction * total) / 1000).toFixed(2)} km`
        : `${Math.round(m.fraction * total)} m`)
      : `${(m.fraction * 100).toFixed(1)}%`;
    li.innerHTML = `<span class="at">${at}</span><span>${escapeHtml(m.title)}</span>`;
    list.append(li);
  }

  // Flag blurbs long enough to be cut off mid-sentence by the speech engine.
  for (const row of $('ed-waypoints').children) {
    const body = row.querySelector('.wp-body').value;
    row.querySelector('.wp-hint').textContent =
      body.length > 200 ? `${body.length} characters — likely to be cut off when spoken` : '';
  }
}

async function saveLens() {
  const lens = readEditorLens();
  const status = $('ed-status');

  if (!lens.title) { fail('Give the lens a title.'); return; }
  try {
    validateLens(lens);
  } catch (err) {
    fail(err.message.replace(/^lens "[^"]*": /, ''));
    return;
  }

  await put('lenses', { ...lens, updatedAt: Date.now() });
  await refreshLenses();
  status.className = 'status is-ok';
  status.textContent = 'Saved.';
  editor.isNew = false;
  $('ed-delete').hidden = false;

  function fail(msg) { status.className = 'status is-error'; status.textContent = msg; }
}

async function deleteLens() {
  await del('lenses', editor.id);
  if (state.settings.lensId === editor.id) state.settings = saveSettings({ lensId: null });
  await refreshLenses();
  show('screen-setup');
  if (state.route) recompile();
}

/** Built-ins plus anything the user has written. */
async function refreshLenses() {
  const custom = await all('lenses');
  // A stored lens can be malformed — saved by an older build, or hand-edited.
  // Skip it rather than letting one bad record take down the lens picker.
  const usable = (custom || []).filter((l) => {
    if (!l) return false;
    try { validateLens(l); return true; } catch (err) {
      console.warn(`Skipping stored lens "${l.id}": ${err.message}`);
      return false;
    }
  });
  state.lenses = [...state.builtinLenses, ...usable];
  if (state.route) { renderLenses(); recompile(); }
}

// ------------------------------------------------------------- the journey

const journey = {
  tracker: null,
  engine: null,
  map: null,
  marker: null,
  accuracyRing: null,
  doneLine: null,
  lens: null,
  timer: 0,
  lastAnnouncement: null,
  alertTimer: 0,
  muted: false,
};

function initJourneyMap() {
  if (journey.map) { journey.map.invalidateSize(); return; }
  journey.map = L.map('journey-map', { zoomControl: false, attributionControl: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(journey.map);

  const latlngs = state.route.coordinates.map((c) => [c[1], c[0]]);
  L.polyline(latlngs, { color: '#2a2a45', weight: 7 }).addTo(journey.map);
  journey.doneLine = L.polyline([], { color: '#6c5ce7', weight: 6 }).addTo(journey.map);
  journey.map.fitBounds(L.latLngBounds(latlngs), { padding: [24, 24] });
}

function drawRibbonTicks() {
  const ribbon = $('ribbon');
  for (const el of ribbon.querySelectorAll('.ribbon-tick')) el.remove();
  for (const m of state.milestones) {
    const tick = document.createElement('div');
    tick.className = `ribbon-tick${m.kind === 'lens' ? ' tick-lens' : ''}`;
    tick.style.left = `${(m.d / state.route.distance) * 100}%`;
    tick.dataset.key = m.key;
    ribbon.append(tick);
  }
}

function showAlert(event) {
  journey.lastAnnouncement = event;
  const { headline, skipped } = event;

  $('alert-kicker').textContent = headline.kind === 'lens'
    ? (headline.lensTitle || 'Milestone')
    : (headline.kind === 'arrival' ? 'Journey complete' : 'Fraction');
  $('alert-title').textContent = headline.title;
  $('alert-body').textContent = headline.body || '';

  const alsoParts = [];
  if (skipped.length) alsoParts.push(`Also passed: ${skipped.map((m) => m.title).join(', ')}.`);
  if (headline.alsoPassed && headline.alsoPassed.length) {
    alsoParts.push(`With ${headline.alsoPassed.map((m) => m.title).join(', ')}.`);
  }
  if (headline.atLabel) alsoParts.push(headline.atLabel);
  $('alert-also').textContent = alsoParts.join(' ');

  $('alert-card').hidden = false;
  clearTimeout(journey.alertTimer);
  journey.alertTimer = setTimeout(() => { $('alert-card').hidden = true; }, 14000);

  if (!journey.muted) {
    if (state.settings.speech) speak(event.speech, { rate: state.settings.speechRate });
    if (state.settings.vibrate) vibrate(VIBRATION[headline.kind] || VIBRATION.fraction);
  }

  for (const m of event.all) {
    const tick = $('ribbon').querySelector(`[data-key="${CSS.escape(m.key)}"]`);
    if (tick) tick.classList.add('done');
  }
}

function setBanner(text, bad) {
  const el = $('journey-banner');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('is-bad', !!bad);
}

function renderJourney(fix) {
  const total = state.route.distance;
  const pct = fix.fraction * 100;

  $('big-fraction').textContent = `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
  $('ribbon-fill').style.width = `${pct}%`;

  // The nearest chosen fraction, so "5/14" is visible as well as the percentage.
  const nearest = nearestFractionLabel(fix.fraction);
  const lens = journey.lens;
  if (lens) {
    const value = domainValueAt(lens, fix.fraction);
    $('lens-readout').textContent =
      `${formatLensValue(value)} ${lens.unitShort || lens.unit || ''} from ${lens.domain.startLabel || 'the start'}`;
    // A non-linear scale changes WHEN you hear about things; the app never
    // pretends the pacing is proportional, so show the honest number too.
    $('true-readout').textContent = (lens.scale || 'linear') === 'linear'
      ? (nearest ? `about ${nearest}` : '')
      : `${Math.round((value / (lens.domain.to - lens.domain.from)) * 100)}% of the real distance`;
  } else {
    $('lens-readout').textContent = nearest ? `about ${nearest} of the way` : '';
    $('true-readout').textContent = '';
  }

  $('stat-done').textContent = formatDistance(fix.along);
  $('stat-left').textContent = formatDistance(Math.max(0, total - fix.along));
  $('stat-time').textContent = formatDuration(fix.elapsedMs);

  const next = journey.engine.nextAfter(fix.along);
  $('next-title').textContent = next ? next.title : 'Nothing left';
  $('next-distance').textContent = next ? formatDistance(next.d - fix.along) : '';

  if (journey.map) {
    const here = [fix.lat, fix.lng];
    if (!journey.marker) {
      journey.marker = L.circleMarker(here, {
        radius: 8, color: '#fff', weight: 3, fillColor: '#6c5ce7', fillOpacity: 1,
      }).addTo(journey.map);
      journey.accuracyRing = L.circle(here, {
        radius: fix.accuracy, color: '#6c5ce7', weight: 1, fillOpacity: 0.08,
      }).addTo(journey.map);
    } else {
      journey.marker.setLatLng(here);
      journey.accuracyRing.setLatLng(here).setRadius(fix.accuracy);
    }
    journey.doneLine.setLatLngs(sliceRoute(fix.along));
    journey.map.panTo(here, { animate: true, duration: 0.5 });
  }

  if (fix.offRoute) {
    setBanner(`Off route — ${formatDistance(fix.distanceFromRoute)} from the line. Progress is paused.`, true);
  } else if (journey.tracker.status === 'stale') {
    setBanner('Waiting for a GPS fix…');
  } else {
    setBanner('');
  }
}

/** The travelled part of the route, for drawing in the accent colour. */
function sliceRoute(along) {
  const { geometry } = state.route;
  const out = [];
  for (let i = 0; i < geometry.count; i++) {
    if (geometry.cum[i] > along) break;
    out.push([geometry.lat[i], geometry.lng[i]]);
  }
  const head = positionAt(geometry, along / geometry.total);
  out.push([head.lat, head.lng]);
  return out;
}

function formatLensValue(v) {
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-GB', { maximumFractionDigits: 0 });
  if (Math.abs(v) >= 10) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(1);
  return v.toPrecision(2);
}

function nearestFractionLabel(fraction) {
  let best = null;
  for (const n of state.settings.denominators) {
    const k = Math.round(fraction * n);
    if (k <= 0 || k > n) continue;
    const err = Math.abs(fraction - k / n);
    if (err < 0.5 / n && (!best || err < best.err)) {
      const g = gcdSmall(k, n);
      best = { err, label: `${k / g}/${n / g}` };
    }
  }
  return best ? best.label : null;
}

const gcdSmall = (a, b) => (b === 0 ? a : gcdSmall(b, a % b));

async function startJourney() {
  // Speech must be unlocked from inside the tap that started the journey.
  unlock();
  await pickVoice();

  journey.lens = activeLens();
  journey.engine = createMilestoneEngine(state.milestones, state.route.distance);
  journey.muted = false;
  journey.lastAnnouncement = null;

  show('screen-journey');
  initJourneyMap();
  drawRibbonTicks();
  setBanner('Waiting for a GPS fix…');

  journey.tracker = createTracker(state.route.geometry, {
    onFix: (fix) => {
      if (!fix.accepted && fix.reason === 'accuracy') return;
      renderJourney(fix);
      if (fix.offRoute) return;                 // no alerts while off the line
      const event = journey.engine.update(fix.along, { confident: fix.confident });
      if (event) showAlert(event);
    },
    onStatus: (status, detail) => {
      if (status === 'error') setBanner(detail || 'Location unavailable.', true);
    },
  });

  journey.tracker.start();

  if (state.settings.wakeLock) { await acquireWakeLock(); keepWakeLock(); }

  clearInterval(journey.timer);
  journey.timer = setInterval(() => {
    if (journey.tracker && journey.tracker.startedAt && !journey.tracker.paused) {
      $('stat-time').textContent = formatDuration(Date.now() - journey.tracker.startedAt);
    }
  }, 1000);
}

function endJourney() {
  if (journey.tracker) journey.tracker.stop();
  clearInterval(journey.timer);
  clearTimeout(journey.alertTimer);
  stopSpeaking();
  releaseWakeLock();
  journey.marker = null;
  journey.accuracyRing = null;
  $('alert-card').hidden = true;
  show('screen-plan');
  if (map) setTimeout(() => map.invalidateSize(), 0);
}

// ------------------------------------------- launcher shortcuts and sharing

/** Pull a lat/lng out of a geo: URI, a "51.5,-0.12" string, or a maps URL. */
export function parseSharedLocation(text) {
  if (!text) return null;
  const s = String(text);

  const geo = s.match(/geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i);
  if (geo) return { lat: +geo[1], lng: +geo[2] };

  // Google Maps and OSM both put coordinates after an @ or a q=/query= param.
  const at = s.match(/[@=](-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (at) return { lat: +at[1], lng: +at[2] };

  const bare = s.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (bare) return { lat: +bare[1], lng: +bare[2] };

  return null;
}

async function handleLaunchParams() {
  const params = new URLSearchParams(location.search);
  const status = $('plan-status');

  const shared = parseSharedLocation(params.get('text') || params.get('url') || '');
  if (shared) {
    setPoint(state.start ? 'end' : 'start', shared);
    map.setView([shared.lat, shared.lng], 15);
    status.textContent = 'Set from the location you shared.';
  }

  const action = params.get('action');
  if (action === 'set-end') {
    arm('end');
    status.textContent = 'Tap the map to set your destination.';
  } else if (action === 'start-here') {
    status.textContent = 'Getting a fix…';
    try {
      const p = await currentPosition();
      setPoint('start', p);
      map.setView([p.lat, p.lng], 16);
      arm('end');
      status.textContent = `Start set to ±${Math.round(p.accuracy)} m. Now pick a destination.`;
    } catch (err) {
      status.className = 'status is-error';
      status.textContent = err.message;
    }
  }

  // Keep the URL clean so a reload does not repeat the action.
  if (location.search) history.replaceState(null, '', location.pathname);
}

// --------------------------------------------------------------------- boot

async function boot() {
  initMap();

  const sel = $('profile');
  for (const p of PROFILES) {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.label;
    sel.append(opt);
  }
  sel.value = state.settings.profile;

  $('pick-start').onclick = () => arm('start');
  $('pick-end').onclick = () => arm('end');
  $('get-route').onclick = fetchRoute;
  $('open-settings').onclick = openSettings;
  $('settings-back').onclick = () => show('screen-plan');
  $('setup-back').onclick = () => show('screen-plan');

  $('use-location').onclick = async () => {
    const status = $('plan-status');
    status.className = 'status';
    status.textContent = 'Getting a fix…';
    try {
      const p = await currentPosition();
      setPoint(state.arming, p);
      map.setView([p.lat, p.lng], 16);
      status.textContent = `Fix to ±${Math.round(p.accuracy)} m.`;
    } catch (err) {
      status.className = 'status is-error';
      status.textContent = err.message;
    }
  };

  $('add-denominator').onclick = () => {
    const n = parseInt($('custom-denominator').value, 10);
    if (!Number.isInteger(n) || n < 2 || n > 100) return;
    const set = new Set(state.settings.denominators).add(n);
    state.settings = saveSettings({ denominators: [...set].sort((a, b) => a - b) });
    $('custom-denominator').value = '';
    renderFractionChips();
    recompile();
  };

  $('save-key').onclick = () => {
    saveApiKey($('api-key').value);
    const s = $('key-status');
    s.className = 'status is-ok';
    s.textContent = loadApiKey() ? 'Key saved on this device.' : 'Key cleared.';
  };

  for (const [id, key] of [['opt-speech', 'speech'], ['opt-vibrate', 'vibrate'], ['opt-wakelock', 'wakeLock']]) {
    $(id).onchange = (e) => { state.settings = saveSettings({ [key]: e.target.checked }); };
  }

  $('test-voice').onclick = async () => {
    const s = $('voice-status');
    unlock();                                   // must happen inside the gesture
    await pickVoice();
    const spoke = speak('Route Lens is ready. You are one third of the way.', {
      rate: state.settings.speechRate,
    });
    const buzzed = vibrate(VIBRATION.lens);
    s.className = 'status';
    s.textContent = [
      canSpeak() ? (spoke ? 'Speech sent.' : 'Speech blocked.') : 'No speech support.',
      canVibrate() ? (buzzed ? 'Vibration sent.' : 'Vibration blocked.') : 'No vibration support.',
    ].join(' ');
  };

  $('start-journey').onclick = startJourney;
  $('alert-close').onclick = () => { $('alert-card').hidden = true; };
  $('ctl-end').onclick = endJourney;

  $('ctl-mute').onclick = () => {
    journey.muted = !journey.muted;
    if (journey.muted) stopSpeaking();
    const btn = $('ctl-mute');
    btn.classList.toggle('is-off', journey.muted);
    btn.firstElementChild.textContent = journey.muted ? '🔇' : '🔊';
  };

  $('ctl-repeat').onclick = () => {
    if (!journey.lastAnnouncement) return;
    showAlert(journey.lastAnnouncement);
  };

  $('ctl-pause').onclick = () => {
    const t = journey.tracker;
    if (!t) return;
    const btn = $('ctl-pause');
    if (t.paused) {
      t.resume();
      btn.classList.remove('is-off');
      btn.firstElementChild.textContent = '⏸';
      setBanner('');
    } else {
      t.pause();
      btn.classList.add('is-off');
      btn.firstElementChild.textContent = '▶';
      setBanner('Paused — no tracking or alerts.');
    }
  };

  $('editor-back').onclick = () => show('screen-setup');
  $('editor-save').onclick = saveLens;
  $('ed-delete').onclick = deleteLens;
  $('ed-add').onclick = () => {
    $('ed-waypoints').append(waypointRow());
    renderEditorPreview();
  };
  for (const id of ['ed-title', 'ed-subtitle', 'ed-unit', 'ed-unit-short',
    'ed-from', 'ed-to', 'ed-start-label', 'ed-end-label', 'ed-scale']) {
    $(id).oninput = renderEditorPreview;
    $(id).onchange = renderEditorPreview;
  }

  $('ed-export').onclick = async () => {
    const json = JSON.stringify(readEditorLens(), null, 2);
    const status = $('ed-status');
    try {
      await navigator.clipboard.writeText(json);
      status.className = 'status is-ok';
      status.textContent = 'Copied to the clipboard.';
    } catch {
      // Clipboard access needs a secure context and permission; show it instead.
      $('ed-json').hidden = false;
      $('ed-json').value = json;
      status.className = 'status';
      status.textContent = 'Copy it from the box below.';
    }
  };

  $('ed-import').onclick = () => {
    $('ed-json').hidden = false;
    $('ed-json').value = '';
    $('ed-load').hidden = false;
    $('ed-json').focus();
  };

  $('ed-load').onclick = () => {
    const status = $('ed-status');
    try {
      const parsed = JSON.parse($('ed-json').value);
      validateLens(parsed);
      // Imported lenses always become a new lens of yours, so pasting one can
      // never overwrite a built-in or silently clobber something else.
      openLensEditor({ ...parsed, id: `user-${uid()}`, custom: true });
      editor.isNew = true;
      $('ed-delete').hidden = true;
      $('ed-status').className = 'status is-ok';
      $('ed-status').textContent = 'Loaded. Tap Save to keep it.';
    } catch (err) {
      status.className = 'status is-error';
      status.textContent = `That is not a valid lens: ${err.message}`;
    }
  };

  state.builtinLenses = await loadBuiltinLenses();
  await refreshLenses();
  requestPersistence();

  // Add ?debug=1 to drive the app from the console — handy for testing a
  // journey without going outside, and for the simulator in later phases.
  if (new URLSearchParams(location.search).has('debug')) {
    window.RouteLens = {
      state, journey, map, setPoint, fetchRoute, recompile, openSetup, show,
      startJourney, endJourney,

      /** Replay a synthetic walk through the live screen, at `speedUp` × real time. */
      async simulate({ speedMps = 1.4, intervalS = 5, noiseM = 6, stepMs = 30 } = {}) {
        const { simulateFixes } = await import('./simulator.js');
        const fixes = simulateFixes(state.route.geometry, { speedMps, intervalS, noiseM, seed: 3 });
        const fired = [];
        const realShow = showAlert;
        for (const f of fixes) {
          const before = journey.engine.fired.length;
          journey.tracker.ingest({ lat: f.lat, lng: f.lng, accuracy: f.accuracy, speed: f.speed });
          const after = journey.engine.fired;
          if (after.length > before) fired.push(...after.slice(before).map((m) => m.title));
          if (stepMs) await new Promise((r) => setTimeout(r, stepMs));
        }
        return fired;
      },
    };
  }

  await handleLaunchParams();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

boot();
