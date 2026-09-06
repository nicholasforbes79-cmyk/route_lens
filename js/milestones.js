// milestones.js — compiles fractions and lenses into one sorted list of
// things to announce, then decides when each one fires.
//
// Everything here works in METRES along the route, never in fractions. That
// keeps every threshold physical, so the engine behaves identically on a 2 km
// walk and a 200 km drive.

import { lensMilestones } from './lenses.js';

const PRIORITY = { arrival: 3, lens: 2, fraction: 1 };

// ---------------------------------------------------------------- fractions

const NUMERATOR_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

const DENOMINATOR_WORDS = {
  2: ['half', 'halves'], 3: ['third', 'thirds'], 4: ['quarter', 'quarters'],
  5: ['fifth', 'fifths'], 6: ['sixth', 'sixths'], 7: ['seventh', 'sevenths'],
  8: ['eighth', 'eighths'], 9: ['ninth', 'ninths'], 10: ['tenth', 'tenths'],
  11: ['eleventh', 'elevenths'], 12: ['twelfth', 'twelfths'], 13: ['thirteenth', 'thirteenths'],
  14: ['fourteenth', 'fourteenths'], 15: ['fifteenth', 'fifteenths'], 16: ['sixteenth', 'sixteenths'],
  17: ['seventeenth', 'seventeenths'], 18: ['eighteenth', 'eighteenths'],
  19: ['nineteenth', 'nineteenths'], 20: ['twentieth', 'twentieths'],
};

/** Spoken form of k/n — "three fourteenths", "halfway", "30 percent". */
export function fractionSpeech(k, n) {
  if (n === 100 || n === 10 || n === 20 || n === 50) {
    return `${Math.round((k / n) * 100)} percent of the way`;
  }
  if (n === 2 && k === 1) return 'halfway';
  const words = DENOMINATOR_WORDS[n];
  if (words && k <= 20) {
    const num = NUMERATOR_WORDS[k];
    const den = k === 1 ? words[0] : words[1];
    return `${num} ${den} of the way`;
  }
  return `${k} of ${n} of the way`;
}

/** Display form — "3/14". */
export const fractionLabel = (k, n) => `${k}/${n}`;

/**
 * Every k/n for each denominator, deduplicated so that asking for both
 * quarters and every-10% does not announce 50% twice.
 */
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

export function fractionMilestones(denominators, total) {
  const byFraction = new Map();

  for (const n of denominators) {
    for (let k = 1; k < n; k++) {
      // Always reduce: asking for quarters should say "halfway", not "2/4",
      // and it makes 1/2 and 5/10 collapse onto one another naturally.
      const g = gcd(k, n);
      const rk = k / g;
      const rn = n / g;
      const f = k / n;
      if (byFraction.has(f)) continue;
      byFraction.set(f, { k: rk, n: rn, f });
    }
  }

  return [...byFraction.values()].map(({ k, n, f }) => ({
    key: `frac:${n}:${k}`,
    d: f * total,
    fraction: f,
    title: fractionLabel(k, n),
    body: `${Math.round(f * 1000) / 10}% of the way`,
    speech: `You are ${fractionSpeech(k, n)}.`,
    kind: 'fraction',
    priority: PRIORITY.fraction,
  }));
}

// ----------------------------------------------------------------- compile

/**
 * Merge any run of milestones closer together than minSpacingM. The highest
 * priority one becomes the headline; the rest are folded into alsoPassed and
 * get a line on the card rather than an alert of their own. This is what stops
 * a 1.2 km walk with the solar-system lens producing eleven alerts.
 */
function coalesce(sorted, minSpacingM) {
  const out = [];
  let group = [];

  const flush = () => {
    if (!group.length) return;
    const headline = group.reduce((a, b) =>
      (b.priority > a.priority || (b.priority === a.priority && b.d > a.d)) ? b : a);
    out.push({ ...headline, alsoPassed: group.filter((m) => m !== headline) });
    group = [];
  };

  for (const m of sorted) {
    if (group.length && m.d - group[0].d > minSpacingM) flush();
    group.push(m);
  }
  flush();
  return out;
}

/**
 * @param {number} total route length in metres
 * @param {object} plan { denominators?: number[], lens?: object, minSpacingM?: number }
 */
export function compileMilestones(total, plan = {}) {
  const items = [];

  if (plan.denominators && plan.denominators.length) {
    items.push(...fractionMilestones(plan.denominators, total));
  }

  if (plan.lens) {
    for (const m of lensMilestones(plan.lens)) {
      // Skip the waypoint sitting exactly at the start — nothing to announce.
      if (m.fraction <= 0) continue;
      items.push({
        key: m.key,
        d: m.fraction * total,
        fraction: m.fraction,
        trueFraction: m.trueFraction,
        title: m.title,
        body: m.body,
        speech: `You are now passing ${m.title}. ${m.body}`,
        atLabel: m.atLabel,
        lensTitle: m.lensTitle,
        kind: 'lens',
        priority: PRIORITY.lens,
      });
    }
  }

  items.push({
    key: 'arrival',
    d: Math.max(0, total - 25),
    fraction: 1,
    title: 'Arrived',
    body: 'You have reached the end of your route.',
    speech: 'You have arrived. That is the whole route.',
    kind: 'arrival',
    priority: PRIORITY.arrival,
  });

  items.sort((a, b) => a.d - b.d || b.priority - a.priority);
  const spacing = plan.minSpacingM ?? Math.max(150, total / 60);
  return coalesce(items, spacing);
}

// ------------------------------------------------------------------ engine

export const ENGINE_DEFAULTS = {
  rearmM: null,        // computed from route length if left null
  blockedGraceMs: 60000,
};

/**
 * Arm / fire state machine. A milestone re-arms only if you drop well behind
 * it — a hysteresis band, not a timer, so GPS jitter can never re-announce.
 */
export function createMilestoneEngine(milestones, total, options = {}) {
  const opts = { ...ENGINE_DEFAULTS, ...options };
  const rearmM = opts.rearmM ?? Math.max(100, total * 0.004);
  const state = new Map(milestones.map((m) => [m.key, { fired: false, blockedSince: 0 }]));

  function announce(crossed) {
    const headline = crossed[crossed.length - 1];
    const skipped = crossed.slice(0, -1);
    let speech = '';

    if (skipped.length) {
      const names = skipped.map((m) => m.title);
      const shown = names.slice(0, 3);
      const extra = names.length - shown.length;
      let list = shown.length === 1 ? shown[0]
        : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
      if (extra > 0) list += ` and ${extra} more`;
      speech += `You have passed ${list}. `;
    }
    speech += headline.speech;

    return { headline, skipped, speech, all: crossed };
  }

  return {
    milestones,
    get fired() {
      return milestones.filter((m) => state.get(m.key).fired);
    },
    get remaining() {
      return milestones.filter((m) => !state.get(m.key).fired);
    },
    nextAfter(d) {
      return milestones.find((m) => !state.get(m.key).fired && m.d > d) || null;
    },

    /** Mark everything behind `d` as already passed, without announcing it. */
    seedAt(d) {
      const passed = [];
      for (const m of milestones) {
        if (m.d <= d) { state.get(m.key).fired = true; passed.push(m); }
      }
      return passed;
    },

    serialize() {
      const out = {};
      for (const [k, v] of state) if (v.fired) out[k] = true;
      return out;
    },

    restore(saved = {}) {
      for (const key of Object.keys(saved)) {
        if (state.has(key)) state.get(key).fired = true;
      }
    },

    /**
     * @param {number} progressD monotone metres travelled along the route
     * @param {object} meta { confident: boolean, now: number }
     * @returns {null | {headline, skipped, speech, all}}
     */
    update(progressD, meta = {}) {
      const now = meta.now ?? Date.now();
      const confident = meta.confident !== false;
      const crossed = [];

      for (const m of milestones) {
        const s = state.get(m.key);
        if (!s.fired && progressD >= m.d) {
          // A low-confidence fix delays an alert rather than losing it, but
          // only for so long — after the grace period, announce anyway.
          if (!confident) {
            if (!s.blockedSince) s.blockedSince = now;
            if (now - s.blockedSince < opts.blockedGraceMs) continue;
          }
          s.fired = true;
          s.blockedSince = 0;
          crossed.push(m);
        } else if (s.fired && progressD < m.d - rearmM) {
          s.fired = false;
        }
      }

      return crossed.length ? announce(crossed) : null;
    },
  };
}
