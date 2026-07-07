# Vocal Synthesis — The Machine Made to Sing

An interactive, dependency-free explorer of **singing-voice synthesis techniques**, from the earliest electrical voice machines to the neural era. Eight genuinely different methods of making a sung voice — all implemented **live in the browser** with only the Web Audio API. **No samples, no libraries, no external assets** (bar Google Fonts). Hold one note and switch technique to **A/B a century of method** on the very same pitch and vowel.

**[Launch the app](https://brendanjameslynskey.github.io/Vocal_Synthesis/)** — auto-detects your device and recommends desktop or mobile.

**[Read the full written history →](HISTORY.md)**

---

## What this is

The engines all share one interface (the [`vocal-voices.js`](vocal-voices.js) library, also used by [Synth Organum](https://github.com/BrendanJamesLynskey/Synth_Organum) and the other early-music apps). The explorer builds its controls straight from the library's technique list, shows a live spectrum/waveform visualizer, and — the point of the thing — lets you **swap the synthesis method while a note or phrase sustains**, so the difference between a 1939 vocoder and a 2020 DDSP model is audible under your ear on an identical pitch and vowel.

Each technique also carries a short dossier in the app — name, era, key people and dates — and a longer treatment in [`HISTORY.md`](HISTORY.md).

## The implemented techniques

Ordered earliest → most modern (the order they appear in the explorer). Each links to its section of the history.

| id | Era | Technique — one-liner |
|---|---|---|
| **`vocoder`** | 1938–39 | [Channel vocoder / VODER](HISTORY.md#3-the-vocoder-and-the-voder-19381939--vocoder) — buzz + hiss through a band-pass bank gated by the vowel envelope (Dudley, Bell Labs) |
| **`formant`** | 1953–80 | [Formant filter](HISTORY.md#4-electronic-formant-synthesizers-19531980--formant-klatt) — a glottal-pulse source through parallel resonant formants (PAT / OVE) |
| **`klatt`** | 1980 | [Klatt cascade](HISTORY.md#4-electronic-formant-synthesizers-19531980--formant-klatt) — voicing source + aspiration through a cascade of formant resonators (KLSYN → DECtalk) |
| **`tract`** | 1961–62 | [Vocal-tract waveguide](HISTORY.md#5-the-vocal-tract-as-a-physical-model--and-the-first-singing-computer-19611962--tract) — a Kelly–Lochbaum physical model of the tube ("Daisy Bell") |
| **`lpc`** | 1971–78 | [LPC all-pole](HISTORY.md#6-linear-predictive-coding--and-a-toy-that-talked-19711978--lpc) — impulse/noise excitation through an all-pole resonator bank (Speak & Spell) |
| **`fof`** | 1979–84 | [FOF / CHANT](HISTORY.md#7-fof-and-chant--the-machine-learns-to-sing-beautifully-19791984--fof) — overlapping formant grains, one burst per glottal pulse (IRCAM) |
| **`additive`** | 1986–90 | [Additive / SMS](HISTORY.md#8-sinusoidal-and-spectral-modelling-19861990--additive) — a sum of harmonics tracing the formant envelope (sinusoidal / spectral modelling) |
| **`ddsp`** | 2020 | [DDSP harmonic + noise](HISTORY.md#11-the-neural-era-2016present--mostly-described-only-with-ddsp-as-the-live-bridge) — harmonic oscillator bank + formant-shaped filtered noise (the neural bridge) |

**Described only** in the history (they need recorded samples or trained models, so they are not playable in a sample-free page): the **mechanical machines** (Kratzenstein 1779, von Kempelen 1791), **PSOLA / MBROLA / concatenative** and **VOCALOID**, **STRAIGHT / WORLD** vocoders, **HMM / HTS** statistical synthesis, and the full **neural stack** (WaveNet, Tacotron, HiFi-GAN, DiffSinger). The `ddsp` engine is the one neural-era method implementable live.

## Using the explorer

1. Press **Give Voice** to start the sound.
2. Pick a **Vowel** (a / e / i / o / u) and a **Pitch** (C3–E4).
3. **Transport**: *Sustain* holds one note; *Phrase* sings a short vowel-cycling melody.
4. **A/B**: while it sounds, click through the **Technique** buttons — the same note keeps sounding, re-voiced by each method, so you can hear the timbral difference directly. Watch the formant peaks move in the visualizer.

## Quick start

```bash
git clone https://github.com/BrendanJamesLynskey/Vocal_Synthesis.git
cd Vocal_Synthesis
python3 -m http.server 8080
```

Open <http://localhost:8080> and press **Give Voice**. Any static file server works — there is no build step and no dependency.

## Files

| File | Purpose |
|---|---|
| `index.html` | Landing page — detects device, links to desktop / mobile / history |
| `desktop.html` | Desktop explorer app |
| `style.css` | Manuscript-themed styles (parchment, ink, gold) |
| `vocal-voices.js` | Shared library of interchangeable vocal-synthesis engines (vocoder, formant, klatt, tract, lpc, fof, additive, ddsp) |
| `app.js` | Explorer engine + UI controller + spectrum/waveform visualizer |
| `vocal_mobile.html` | Self-contained mobile version (single bundled file) |
| `HISTORY.md` | The full written history of vocal synthesis, 1779 → today |
| `DIRECTIONS.md` | Project roadmap and technique table (developer handoff) |

## The library API

```js
await VocalVoices.init(ctx);                       // load the worklets (per-context safe)
const v = VocalVoices.create(ctx, { technique:'fof', vowel:'a', breath:0.06 });
v.output.connect(dest);
v.setFrequency(196, ctx.currentTime, 0);           // pitch (3rd arg = glide seconds)
v.setLevel(1, ctx.currentTime);                    // gate the voice
v.setVowel('o', ctx.currentTime);                  // morph the vowel
v.dispose();
VocalVoices.TECHNIQUES;                             // [{id,name,blurb}] — used to build the UI
```

Every technique honours the same interface, which is what makes the live A/B (and the interchangeable engine in the early-music apps) possible.

## Where it sits

Part of the **[DSP & Music](https://github.com/BrendanJamesLynskey/DSP_and_Music)** collection. The same `vocal-voices.js` library sings across the early-music apps — most directly in **[Synth Organum](https://github.com/BrendanJamesLynskey/Synth_Organum)**, which has a live **Vocal Engine** selector built on these techniques.

## License

MIT
