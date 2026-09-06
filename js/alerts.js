// alerts.js — speech, vibration and the audio-unlock dance.
//
// Chrome on Android silently swallows the first speechSynthesis.speak() unless
// it happens after a user gesture, with no error of any kind. Everything here
// is built around that fact.

let unlocked = false;
let voice = null;
let voicesReady = null;
let keepalive = 0;

export const canSpeak = () => typeof speechSynthesis !== 'undefined';
export const canVibrate = () => typeof navigator !== 'undefined' && 'vibrate' in navigator;
export const isUnlocked = () => unlocked;

export const VIBRATION = {
  lens: [80, 60, 80, 60, 220],
  fraction: [220],
  arrival: [300, 120, 300],
  offRoute: [60, 60, 60, 60, 60],
};

/** getVoices() is empty on the first call; it fills in asynchronously. */
export function loadVoices() {
  if (!canSpeak()) return Promise.resolve([]);
  if (voicesReady) return voicesReady;
  voicesReady = new Promise((resolve) => {
    const got = speechSynthesis.getVoices();
    if (got.length) return resolve(got);
    const onChange = () => {
      speechSynthesis.removeEventListener('voiceschanged', onChange);
      resolve(speechSynthesis.getVoices());
    };
    speechSynthesis.addEventListener('voiceschanged', onChange);
    setTimeout(() => resolve(speechSynthesis.getVoices()), 2000);
  });
  return voicesReady;
}

/**
 * MUST be called synchronously inside a user-gesture handler (the Start button).
 * Speaks an inaudible utterance purely to open the audio path.
 */
export function unlock() {
  if (unlocked || !canSpeak()) return unlocked;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0.01;
    u.rate = 2;
    speechSynthesis.speak(u);
    unlocked = true;
  } catch { /* stays locked; callers fall back to card + vibrate */ }
  if (canVibrate()) { try { navigator.vibrate(0); } catch { /* ignore */ } }
  return unlocked;
}

export async function pickVoice(preferredLang = 'en-GB') {
  const voices = await loadVoices();
  voice = voices.find((v) => v.lang === preferredLang)
       || voices.find((v) => v.lang && v.lang.startsWith(preferredLang.slice(0, 2)))
       || voices[0] || null;
  return voice;
}

/**
 * Chrome cuts utterances off after roughly fifteen seconds unless nudged, and
 * its queue can wedge after the page is backgrounded — hence the cancel() and
 * the pause/resume heartbeat. The 200-character cap on lens blurbs exists so
 * this rarely matters.
 */
export function speak(text, { rate = 1, volume = 1 } = {}) {
  if (!unlocked || !canSpeak() || !text) return false;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = rate;
    u.volume = volume;
    u.onstart = () => {
      clearInterval(keepalive);
      keepalive = setInterval(() => {
        if (!speechSynthesis.speaking) return clearInterval(keepalive);
        speechSynthesis.pause();
        speechSynthesis.resume();
      }, 10000);
    };
    u.onend = u.onerror = () => clearInterval(keepalive);
    speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

export function vibrate(pattern) {
  if (!canVibrate()) return false;
  try { return navigator.vibrate(pattern); } catch { return false; }
}

export function stopSpeaking() {
  clearInterval(keepalive);
  if (canSpeak()) { try { speechSynthesis.cancel(); } catch { /* ignore */ } }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', stopSpeaking);
}

// ------------------------------------------------------------- screen wake

let sentinel = null;

export async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return { ok: false, reason: 'unsupported' };
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => { sentinel = null; });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.name };
  }
}

export const wakeLockHeld = () => !!sentinel;

export async function releaseWakeLock() {
  try { await (sentinel && sentinel.release()); } catch { /* ignore */ }
  sentinel = null;
}

/** Android drops the lock whenever the document hides, so take it again. */
export function keepWakeLock() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !sentinel) acquireWakeLock();
  });
}
