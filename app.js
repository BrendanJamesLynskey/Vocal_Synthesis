/**
 * Vocal Synthesis — Explorer UI Controller
 *
 * Drives the interchangeable engines in vocal-voices.js. Lets you A/B every
 * technique on the SAME pitch + vowel while a note or phrase sustains, so the
 * timbral difference between (say) a 1939 vocoder and a 2020 DDSP model is
 * audible on a single held tone.
 *
 * Exposes a global `engine` with ctx / isPlaying / getAnalyserData() /
 * getFrequencyData() so the shared test harness can smoke-test the audio.
 */

// ── Per-technique history (name / era / description / key names & dates) ─────
const TECH_INFO = {
    vocoder: {
        title: 'Channel Vocoder / VODER',
        era: '1938–1939 · Bell Labs',
        who: 'Homer Dudley',
        body: 'The first electrical voice synthesizer. Dudley split a buzz (a pulse train at the pitch) and a hiss (noise) through a bank of band-pass filters, each scaled by the loudness in that band. Reverse the analysis and you can drive those bands by hand: the VODER, demonstrated at the 1939 World\'s Fair, was literally played on a keyboard by trained operators. Here the band gains are set from the chosen vowel\'s formant envelope.'
    },
    formant: {
        title: 'Formant Filter (source–filter)',
        era: '1953–1980 · Edinburgh / Stockholm',
        who: 'Walter Lawrence (PAT) · Gunnar Fant (OVE)',
        body: 'The source–filter model made explicit: a glottal-pulse oscillator (the "source") passed through a set of parallel resonant band-pass filters tuned to the vowel\'s formants (the "filter", i.e. the vocal tract). PAT (Parametric Artificial Talker, 1953) used parallel resonators; Fant\'s OVE used a cascade. This is the workhorse of classic formant speech and singing synthesis.'
    },
    klatt: {
        title: 'Klatt Cascade Formant Synth',
        era: '1980 · MIT',
        who: 'Dennis Klatt (KLSYN → DECtalk)',
        body: 'Klatt\'s synthesizer refined the cascade: a carefully modelled voicing source plus aspiration and frication noise, driven through a cascade of formant resonators for vowels (whose series product gives the correct relative formant amplitudes automatically) and a parallel branch for consonants. It became DECtalk — and so the voice of Stephen Hawking.'
    },
    tract: {
        title: 'Articulatory Vocal-Tract Waveguide',
        era: '1961–1962 · Bell Labs',
        who: 'Kelly & Lochbaum · (later Pink Trombone, 2017)',
        body: 'Instead of modelling the sound, model the tube. The Kelly–Lochbaum digital waveguide treats the vocal tract as a ladder of cylindrical sections; the vowel is an area function and the acoustics fall out of the physics. On an IBM 704 in 1961 it sang "Daisy Bell" — the first singing computer, and the scene Kubrick gave to HAL 9000.'
    },
    lpc: {
        title: 'Linear Predictive Coding (LPC)',
        era: '1971–1978 · Bell Labs / TI',
        who: 'Atal & Hanauer · Itakura · TI Speak & Spell',
        body: 'LPC represents the vocal tract as an all-pole filter whose coefficients are predicted from the signal, excited by a pulse train (voiced) or noise (unvoiced). Cheap enough to put on a single chip: the TI Speak & Spell (1978, TMS5100) is the iconic robotic voice of a generation. Here an all-pole resonator bank driven by a bright impulse train recreates that grit.'
    },
    fof: {
        title: 'FOF / CHANT',
        era: '1979–1984 · IRCAM',
        who: 'Rodet, Potard & Barrière',
        body: 'Fonction d\'Onde Formantique: build the voice from overlapping formant grains — one short exponentially-decaying burst per glottal period, per formant. Each grain\'s decay sets the formant bandwidth; their overlap re-creates the resonance. CHANT produced the most convincingly sung synthetic voices of its era, including IRCAM\'s famous synthetic choir. It is the default engine across this collection\'s early-music apps.'
    },
    additive: {
        title: 'Additive / Sinusoidal (SMS)',
        era: '1986–1990 · MIT / Stanford',
        who: 'McAulay–Quatieri · Serra & Smith (SMS)',
        body: 'Model the voice as a sum of sinusoids. The harmonics of the pitch are given amplitudes that trace the vowel\'s formant envelope, rebuilt as the pitch moves so the formants stay put. Spectral Modelling Synthesis (SMS) adds a stochastic residual (filtered noise) for breathiness — the deterministic-plus-stochastic split that underlies much later analysis/synthesis.'
    },
    ddsp: {
        title: 'DDSP — Harmonic + Filtered Noise',
        era: '2020 · Google Magenta',
        who: 'Engel, Hantrakul, Gu & Roberts',
        body: 'Differentiable DSP puts a classic harmonic-plus-noise synthesizer inside a neural network: a harmonic oscillator bank and a time-varying filtered-noise generator are driven by loudness and pitch envelopes a network predicts. The synthesis itself is fully interpretable and runs in real time — the bridge from a century of signal models to the neural era. This demo runs the DSP half live.'
    }
};

// A little melody (semitone offsets from the base) + vowels, for phrase mode.
const PHRASE = [
    { d: 0, v: 'a' }, { d: 2, v: 'e' }, { d: 4, v: 'i' }, { d: 5, v: 'o' },
    { d: 7, v: 'u' }, { d: 9, v: 'o' }, { d: 7, v: 'i' }, { d: 5, v: 'e' },
    { d: 4, v: 'a' }, { d: 2, v: 'e' }, { d: 0, v: 'a' }, { d: 0, v: 'a' }
];

// ── The audio engine ─────────────────────────────────────────────────────────
class VocalExplorer {
    constructor() {
        this.ctx = null;
        this.isPlaying = false;
        this.analyser = null;
        this.voice = null;
        this.technique = 'fof';
        this.vowel = 'a';
        this.pitch = 196.0;          // G3
        this.mode = 'sustain';       // 'sustain' | 'phrase'
        this.phraseTimer = null;
        this.phraseStep = 0;
    }

    _buildGraph() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.voiceBus = this.ctx.createGain(); this.voiceBus.gain.value = 0;
        this.limiter = this.ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -10; this.limiter.knee.value = 12;
        this.limiter.ratio.value = 12; this.limiter.attack.value = 0.003; this.limiter.release.value = 0.2;
        this.masterGain = this.ctx.createGain(); this.masterGain.gain.value = 0.9;
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0.82;
        this.voiceBus.connect(this.limiter);
        this.limiter.connect(this.masterGain);
        this.masterGain.connect(this.ctx.destination);
        this.masterGain.connect(this.analyser);
    }

    async begin() {
        if (!this.ctx) this._buildGraph();
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        await VocalVoices.init(this.ctx);
        this.isPlaying = true;
        this.phraseStep = 0;
        this.buildVoice();
        // Click-free fade-in of the whole voice bus.
        const t = this.ctx.currentTime;
        this.voiceBus.gain.cancelScheduledValues(t);
        this.voiceBus.gain.setValueAtTime(this.voiceBus.gain.value, t);
        this.voiceBus.gain.linearRampToValueAtTime(1, t + 0.08);
        if (this.mode === 'phrase') this._startPhrase();
    }

    // (Re)create the current technique's voice and gate it on. Called on start
    // AND whenever the technique changes mid-play → instant A/B on the same note.
    buildVoice() {
        const t = this.ctx.currentTime;
        if (this.voice) {
            try { this.voice.setLevel(0, t); } catch (e) {}
            const old = this.voice;
            setTimeout(() => { try { old.dispose(); } catch (e) {} }, 150);
        }
        this.voice = VocalVoices.create(this.ctx, {
            technique: this.technique, vowel: this.vowel, breath: 0.06, vibDepth: 0.006
        });
        this.voice.output.connect(this.voiceBus);
        this.voice.setFrequency(this.pitch, t, 0);
        this.voice.setVowel(this.vowel, t);
        this.voice.setLevel(1, t + 0.01);
    }

    _startPhrase() {
        this._stopPhrase();
        const stepDur = 620;   // ms per note
        const tick = () => {
            if (!this.isPlaying || !this.voice) return;
            const s = PHRASE[this.phraseStep % PHRASE.length];
            const f = this.pitch * Math.pow(2, s.d / 12);
            const t = this.ctx.currentTime;
            this.voice.setFrequency(f, t, 0.08);
            this.voice.setVowel(s.v, t);
            this.phraseStep++;
        };
        tick();
        this.phraseTimer = setInterval(tick, stepDur);
    }

    _stopPhrase() { if (this.phraseTimer) { clearInterval(this.phraseTimer); this.phraseTimer = null; } }

    end() {
        this._stopPhrase();
        if (this.ctx && this.voiceBus) {
            const t = this.ctx.currentTime;
            this.voiceBus.gain.cancelScheduledValues(t);
            this.voiceBus.gain.setValueAtTime(this.voiceBus.gain.value, t);
            this.voiceBus.gain.linearRampToValueAtTime(0, t + 0.12);
        }
        const old = this.voice; this.voice = null;
        setTimeout(() => { if (old) { try { old.setLevel(0, this.ctx.currentTime); old.dispose(); } catch (e) {} } }, 200);
        this.isPlaying = false;
    }

    setTechnique(id) {
        this.technique = id;
        if (this.isPlaying) this.buildVoice();     // A/B swap, note keeps sounding
    }

    setVowel(v) {
        this.vowel = v;
        if (this.isPlaying && this.voice && this.mode === 'sustain') {
            this.voice.setVowel(v, this.ctx.currentTime);
        }
    }

    setPitch(hz) {
        this.pitch = hz;
        if (this.isPlaying && this.voice && this.mode === 'sustain') {
            this.voice.setFrequency(hz, this.ctx.currentTime, 0.06);
        }
    }

    setMode(m) {
        this.mode = m;
        if (!this.isPlaying) return;
        if (m === 'phrase') { this.phraseStep = 0; this._startPhrase(); }
        else {
            this._stopPhrase();
            if (this.voice) { this.voice.setFrequency(this.pitch, this.ctx.currentTime, 0.06); this.voice.setVowel(this.vowel, this.ctx.currentTime); }
        }
    }

    getAnalyserData() {
        if (!this.analyser) return null;
        const d = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteTimeDomainData(d);
        return d;
    }
    getFrequencyData() {
        if (!this.analyser) return null;
        const d = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(d);
        return d;
    }
}

const engine = new VocalExplorer();
if (typeof window !== 'undefined') window.engine = engine;
let animationId = null;

// ── Transport ────────────────────────────────────────────────────────────────
async function toggleChant() {
    const btn = document.getElementById('btnChant');
    const icon = document.getElementById('mainIcon');
    if (!engine.isPlaying) {
        await engine.begin();
        btn.classList.add('playing');
        btn.querySelector('.btn-text').textContent = 'Silence';
        btn.querySelector('.btn-icon').textContent = '■';
        if (icon) icon.classList.add('active');
        startVisualization();
    } else {
        engine.end();
        btn.classList.remove('playing');
        btn.querySelector('.btn-text').textContent = 'Give Voice';
        btn.querySelector('.btn-icon').textContent = '♪';
        if (icon) icon.classList.remove('active');
        stopVisualization();
    }
}

// ── Controls ─────────────────────────────────────────────────────────────────
function selectTechnique(id) {
    document.querySelectorAll('.tech-btn').forEach(b => b.classList.toggle('active', b.dataset.tech === id));
    engine.setTechnique(id);
    renderInfo(id);
}
function selectVowel(v) {
    document.querySelectorAll('.vowel-btn').forEach(b => b.classList.toggle('active', b.dataset.vowel === v));
    engine.setVowel(v);
}
function selectPitch(hz, el) {
    document.querySelectorAll('.pitch-btn').forEach(b => b.classList.remove('active'));
    if (el) el.classList.add('active');
    engine.setPitch(parseFloat(hz));
}
function selectMode(m) {
    document.querySelectorAll('.transport-mode .mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
    engine.setMode(m);
}

function renderInfo(id) {
    const info = TECH_INFO[id];
    if (!info) return;
    document.getElementById('infoTitle').textContent = info.title;
    document.getElementById('infoEra').textContent = info.era;
    document.getElementById('infoWho').textContent = info.who;
    document.getElementById('infoBody').textContent = info.body;
}

// Build technique + vowel + pitch buttons from the library / tables.
function buildControls() {
    const techWrap = document.getElementById('techButtons');
    VocalVoices.TECHNIQUES.forEach((t, i) => {
        const b = document.createElement('button');
        b.className = 'tech-btn' + (t.id === engine.technique ? ' active' : '');
        b.dataset.tech = t.id;
        b.innerHTML = `${t.name}<small>${t.blurb}</small>`;
        b.title = t.blurb;
        b.onclick = () => selectTechnique(t.id);
        techWrap.appendChild(b);
    });
    renderInfo(engine.technique);
}

// ── Visualization (candlelit spectrum + waveform, à la Synth Gregorian) ───────
function startVisualization() {
    const canvas = document.getElementById('vizCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth * window.devicePixelRatio;
    canvas.height = canvas.offsetHeight * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    const width = canvas.offsetWidth, height = canvas.offsetHeight;

    function draw() {
        animationId = requestAnimationFrame(draw);
        const waveData = engine.getAnalyserData();
        const freqData = engine.getFrequencyData();
        if (!waveData || !freqData) return;

        ctx.fillStyle = 'rgba(14, 11, 6, 0.32)';
        ctx.fillRect(0, 0, width, height);

        // Faint staff lines
        ctx.strokeStyle = 'rgba(200, 168, 78, 0.10)';
        ctx.lineWidth = 1;
        for (let l = 1; l <= 4; l++) {
            const y = height * (0.25 + l * 0.11);
            ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(width - 20, y); ctx.stroke();
        }

        // Formant spectrum as candlelight (log-ish emphasis on low bins where formants live)
        const barCount = 80;
        const barWidth = width / barCount;
        const usable = Math.floor(freqData.length * 0.55);
        for (let i = 0; i < barCount; i++) {
            const idx = Math.floor(Math.pow(i / barCount, 1.4) * usable);
            const value = freqData[idx] / 255;
            const barHeight = value * height * 0.72;
            const x = i * barWidth;
            const g = ctx.createLinearGradient(x, height, x, height - barHeight);
            g.addColorStop(0, `rgba(200, 168, 78, ${0.1 + value * 0.4})`);
            g.addColorStop(0.5, `rgba(240, 214, 122, ${value * 0.35})`);
            g.addColorStop(1, `rgba(122, 31, 31, ${value * 0.25})`);
            ctx.fillStyle = g;
            ctx.fillRect(x + 1, height - barHeight, barWidth - 2, barHeight);
        }

        // Flowing waveform
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(240, 214, 122, 0.6)';
        ctx.lineWidth = 1.5;
        const slice = width / waveData.length;
        let x = 0;
        for (let i = 0; i < waveData.length; i++) {
            const v = waveData[i] / 128.0;
            const y = (v * height) / 2;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            x += slice;
        }
        ctx.stroke();
    }
    draw();
}

function stopVisualization() {
    if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
    const canvas = document.getElementById('vizCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.offsetWidth, height = canvas.offsetHeight;
    let alpha = 1;
    function fade() {
        ctx.fillStyle = 'rgba(14, 11, 6, 0.06)';
        ctx.fillRect(0, 0, width, height);
        alpha -= 0.02;
        if (alpha > 0) requestAnimationFrame(fade);
    }
    fade();
}

function paintIdleCanvas() {
    const canvas = document.getElementById('vizCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth * window.devicePixelRatio;
    canvas.height = canvas.offsetHeight * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    ctx.fillStyle = 'rgba(14, 11, 6, 1)';
    ctx.fillRect(0, 0, canvas.offsetWidth, canvas.offsetHeight);
    ctx.strokeStyle = 'rgba(200, 168, 78, 0.12)';
    ctx.lineWidth = 1;
    for (let l = 1; l <= 4; l++) {
        const y = canvas.offsetHeight * (0.25 + l * 0.11);
        ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(canvas.offsetWidth - 20, y); ctx.stroke();
    }
    ctx.font = '14px Cinzel, serif';
    ctx.fillStyle = 'rgba(200, 168, 78, 0.35)';
    ctx.textAlign = 'center';
    ctx.fillText('Press "Give Voice" — then switch technique to A/B the same note', canvas.offsetWidth / 2, canvas.offsetHeight / 2 + 4);
}

window.addEventListener('resize', () => { if (engine.isPlaying) { stopVisualization(); startVisualization(); } else { paintIdleCanvas(); } });

window.addEventListener('DOMContentLoaded', () => {
    buildControls();
    paintIdleCanvas();
});
