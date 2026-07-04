// ---------- Pitch Lab — Phase 1: Live Mic Pitch Tracker ----------

const NOTE_STRINGS = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const MIDI_MIN = 40;   // E2 — low end of typical vocal range
const MIDI_MAX = 84;   // C6 — high end of typical vocal range
const WINDOW_MS = 8000; // how many ms of trace history to show at once
const MIN_FREQ = 60;    // ignore anything below this (rumble, not voice)
const MAX_FREQ = 1200;  // ignore anything above this (noise, not voice)

const els = {
  canvas: document.getElementById('pitchCanvas'),
  statusText: document.getElementById('statusText'),
  errorText: document.getElementById('errorText'),
  noteName: document.getElementById('noteName'),
  freqValue: document.getElementById('freqValue'),
  centsValue: document.getElementById('centsValue'),
  meterFill: document.getElementById('meterFill'),
  toggleBtn: document.getElementById('toggleBtn'),
  sessionLog: document.getElementById('sessionLog'),
  clearLogBtn: document.getElementById('clearLogBtn'),
};

const ctx = els.canvas.getContext('2d');

let audioContext = null;
let analyser = null;
let mediaStream = null;
let dataArray = null;
let rafId = null;
let listening = false;

let pitchHistory = [];       // { t: performanceNowMs, midi: number }
let sessionStart = null;
let sessionMinMidi = Infinity;
let sessionMaxMidi = -Infinity;

// ---------- Note / frequency math ----------

function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function midiToNoteName(midi) {
  const rounded = Math.round(midi);
  const name = NOTE_STRINGS[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
}

function centsOffFromMidi(freq, midi) {
  const nearest = Math.round(midi);
  return Math.floor(1200 * Math.log2(freq / midiToFreq(nearest)));
}

function isBlackKey(midi) {
  const n = ((Math.round(midi) % 12) + 12) % 12;
  return [1, 3, 6, 8, 10].includes(n);
}

// ---------- Pitch detection (autocorrelation) ----------

function autoCorrelate(buffer, sampleRate) {
  const SIZE = buffer.length;

  // Bail out on near-silence
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return { freq: -1, rms };

  // Trim leading/trailing near-zero samples to stabilize the window
  let start = 0;
  let end = SIZE - 1;
  const thresh = 0.2;
  for (let i = 0; i < SIZE / 2; i++) {
    if (Math.abs(buffer[i]) >= thresh) { start = i; break; }
  }
  for (let i = 1; i < SIZE / 2; i++) {
    if (Math.abs(buffer[SIZE - i]) >= thresh) { end = SIZE - i; break; }
  }
  const trimmed = buffer.slice(start, end);
  const n = trimmed.length;
  if (n < 8) return { freq: -1, rms };

  // Autocorrelation
  const c = new Array(n).fill(0);
  for (let lag = 0; lag < n; lag++) {
    for (let i = 0; i < n - lag; i++) {
      c[lag] += trimmed[i] * trimmed[i + lag];
    }
  }

  // Find first dip, then the peak after it
  let d = 0;
  while (d < n - 1 && c[d] > c[d + 1]) d++;
  let maxVal = -1;
  let maxPos = -1;
  for (let i = d; i < n; i++) {
    if (c[i] > maxVal) {
      maxVal = c[i];
      maxPos = i;
    }
  }
  if (maxPos <= 0) return { freq: -1, rms };

  // Parabolic interpolation for sub-sample accuracy
  let T0 = maxPos;
  const x1 = c[T0 - 1] ?? c[T0];
  const x2 = c[T0];
  const x3 = c[T0 + 1] ?? c[T0];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a !== 0) T0 = T0 - b / (2 * a);

  const freq = sampleRate / T0;
  return { freq, rms };
}

// ---------- Canvas setup ----------

function setupCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = els.canvas.getBoundingClientRect();
  els.canvas.width = Math.round(rect.width * dpr);
  els.canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderCanvas(rect.width, rect.height);
}

function midiToY(midi, height) {
  const clamped = Math.min(Math.max(midi, MIDI_MIN), MIDI_MAX);
  const ratio = (clamped - MIDI_MIN) / (MIDI_MAX - MIDI_MIN);
  return height - ratio * height;
}

function renderCanvas(widthOverride, heightOverride) {
  const rect = els.canvas.getBoundingClientRect();
  const width = widthOverride || rect.width;
  const height = heightOverride || rect.height;

  ctx.clearRect(0, 0, width, height);

  // Piano-roll style shading + gridlines
  for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
    const yTop = midiToY(midi + 0.5, height);
    const yBottom = midiToY(midi - 0.5, height);
    if (isBlackKey(midi)) {
      ctx.fillStyle = 'rgba(255,255,255,0.02)';
      ctx.fillRect(0, yTop, width, yBottom - yTop);
    }
    if (midi % 12 === 0) {
      // Bold line + label at each C
      ctx.strokeStyle = '#2a3244';
      ctx.beginPath();
      ctx.moveTo(0, yBottom);
      ctx.lineTo(width, yBottom);
      ctx.stroke();
      ctx.fillStyle = '#6b7686';
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.fillText(midiToNoteName(midi), 6, yBottom - 3);
    }
  }

  if (pitchHistory.length < 2) return;

  const now = pitchHistory[pitchHistory.length - 1].t;
  const cutoff = now - WINDOW_MS;

  ctx.lineWidth = 2;
  ctx.strokeStyle = '#39ffa0';
  ctx.shadowColor = 'rgba(57,255,160,0.6)';
  ctx.shadowBlur = 8;
  ctx.beginPath();

  let started = false;
  let lastPoint = null;
  for (const point of pitchHistory) {
    if (point.t < cutoff) continue;
    const x = width - ((now - point.t) / WINDOW_MS) * width;
    const y = midiToY(point.midi, height);

    // Break the line if there's a gap (silence) between points
    if (lastPoint && point.t - lastPoint.t > 200) {
      started = false;
    }

    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
    lastPoint = point;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Highlight dot at the most recent point
  const last = pitchHistory[pitchHistory.length - 1];
  const lx = width - ((now - last.t) / WINDOW_MS) * width;
  const ly = midiToY(last.midi, height);
  ctx.fillStyle = '#ffb13d';
  ctx.shadowColor = 'rgba(255,177,61,0.8)';
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
}

// ---------- Status / readout helpers ----------

function setStatus(text, isListening) {
  els.statusText.textContent = text;
  els.statusText.classList.toggle('is-listening', !!isListening);
}

function setError(message) {
  els.errorText.textContent = message || '';
}

function updateReadout(freq, midi) {
  if (freq == null) {
    els.noteName.textContent = '—';
    els.freqValue.textContent = '— Hz';
    els.centsValue.textContent = '— ¢';
    els.centsValue.className = '';
    return;
  }
  const cents = centsOffFromMidi(freq, midi);
  els.noteName.textContent = midiToNoteName(midi);
  els.freqValue.textContent = `${freq.toFixed(1)} Hz`;
  els.centsValue.textContent = `${cents > 0 ? '+' : ''}${cents} \u00A2`;

  const abs = Math.abs(cents);
  els.centsValue.className = abs <= 10 ? 'in-tune' : abs <= 25 ? 'close' : 'off';
}

// ---------- Mic error handling ----------

function describeMicError(err) {
  switch (err.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Microphone permission denied. Allow mic access in your browser settings and try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone found on this device.';
    case 'NotReadableError':
      return 'Microphone is already in use by another app.';
    default:
      return `Microphone error: ${err.message || err.name}`;
  }
}

// ---------- Start / stop ----------

async function startListening() {
  setError('');

  if (!window.isSecureContext) {
    setError('Microphone access requires HTTPS (GitHub Pages is fine) or localhost.');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setError('This browser does not support microphone access.');
    return;
  }

  setStatus('REQUESTING MIC…');

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
  } catch (err) {
    setStatus('STANDBY');
    setError(describeMicError(err));
    return;
  }

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  const source = audioContext.createMediaStreamSource(mediaStream);
  source.connect(analyser);
  dataArray = new Float32Array(analyser.fftSize);

  listening = true;
  sessionStart = performance.now();
  sessionMinMidi = Infinity;
  sessionMaxMidi = -Infinity;
  pitchHistory = [];

  els.toggleBtn.textContent = 'STOP';
  els.toggleBtn.classList.add('active');
  setStatus('LISTENING', true);

  tick();
}

function stopListening() {
  listening = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  if (audioContext) audioContext.close();

  els.toggleBtn.textContent = 'START';
  els.toggleBtn.classList.remove('active');
  setStatus('STANDBY', false);
  els.meterFill.style.width = '0%';
  updateReadout(null, null);

  saveSession();
  renderLog();
}

function tick() {
  if (!listening) return;
  rafId = requestAnimationFrame(tick);

  analyser.getFloatTimeDomainData(dataArray);
  const { freq, rms } = autoCorrelate(dataArray, audioContext.sampleRate);

  els.meterFill.style.width = `${Math.min(rms * 300, 100)}%`;

  if (freq > MIN_FREQ && freq < MAX_FREQ) {
    const midi = freqToMidi(freq);
    const now = performance.now();
    pitchHistory.push({ t: now, midi });
    const cutoff = now - WINDOW_MS;
    pitchHistory = pitchHistory.filter((p) => p.t >= cutoff);

    sessionMinMidi = Math.min(sessionMinMidi, midi);
    sessionMaxMidi = Math.max(sessionMaxMidi, midi);

    updateReadout(freq, midi);
  } else {
    updateReadout(null, null);
  }

  renderCanvas();
}

// ---------- Session log (localStorage) ----------

function saveSession() {
  if (!sessionStart || pitchHistory.length === 0) return;
  const durationSec = Math.round((performance.now() - sessionStart) / 1000);
  if (durationSec < 2) return;

  const sessions = JSON.parse(localStorage.getItem('pitchlab_sessions') || '[]');
  sessions.unshift({
    date: new Date().toISOString(),
    duration: durationSec,
    minNote: sessionMinMidi !== Infinity ? midiToNoteName(sessionMinMidi) : '—',
    maxNote: sessionMaxMidi !== -Infinity ? midiToNoteName(sessionMaxMidi) : '—',
  });
  localStorage.setItem('pitchlab_sessions', JSON.stringify(sessions.slice(0, 10)));
}

function renderLog() {
  const sessions = JSON.parse(localStorage.getItem('pitchlab_sessions') || '[]');
  els.sessionLog.innerHTML = '';

  if (sessions.length === 0) {
    els.sessionLog.innerHTML = '<li class="log-empty">No sessions yet</li>';
    return;
  }

  for (const s of sessions) {
    const d = new Date(s.date);
    const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const li = document.createElement('li');
    li.innerHTML = `<span>${dateStr} ${timeStr}</span> · ${s.duration}s · range ${s.minNote}–${s.maxNote}`;
    els.sessionLog.appendChild(li);
  }
}

function clearLog() {
  localStorage.removeItem('pitchlab_sessions');
  renderLog();
}

// ---------- Event wiring ----------

els.toggleBtn.addEventListener('click', () => {
  listening ? stopListening() : startListening();
});

els.clearLogBtn.addEventListener('click', clearLog);

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat) {
    e.preventDefault();
    listening ? stopListening() : startListening();
  }
});

window.addEventListener('resize', setupCanvas);

// ---------- Init ----------

setupCanvas();
renderLog();
