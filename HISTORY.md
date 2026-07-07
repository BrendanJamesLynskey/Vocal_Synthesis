# A History of Vocal Synthesis

*From bellows and reeds to differentiable DSP — how we taught machines to speak and to sing.*

This is the written companion to the **[Vocal Synthesis explorer](https://brendanjameslynskey.github.io/Vocal_Synthesis/)**, which implements eight of these techniques live in the browser. Where a milestone is playable in the app, its **technique id** is given in **`code font`**; otherwise it is marked *described only* (it needs recorded samples or a trained model that will not fit in a dependency-free web page).

The through-line of the whole story is one idea, the **source–filter model**: the voice is a *sound source* (the buzzing vocal folds, or turbulent noise) shaped by a *filter* (the resonances of the throat, mouth and lips — the **formants**). Almost every technique below is a different way of building, or sidestepping, those two parts.

---

## 1. The mechanical age (1779–1791) — *described only*

Long before electricity, the vocal tract was modelled in **wood, leather and brass**.

- **Christian Gottlieb Kratzenstein (1779, St Petersburg).** Answering a prize question of the Imperial Academy, Kratzenstein built five differently-shaped **acoustic resonators**, each excited by a vibrating reed, that sounded the five vowels *a, e, i, o, u*. This is the source–filter model made physical: a reed source, a resonant-chamber filter.
- **Wolfgang von Kempelen (1791, Vienna).** Over twenty years Kempelen built a full **speaking machine**: a bellows for lungs, a vibrating reed for the glottis, and a soft leather "mouth" the operator reshaped by hand, with side whistles for the sibilants. It could produce whole words and short phrases. His book describing it founded the scientific study of speech production. (Kempelen is now better remembered for the fraudulent chess-playing "Turk" — but the speaking machine was entirely real.)

**Modern echo:** these vowel resonators are the ancestor of every formant synth in this collection. The **`formant`** and **`klatt`** engines are their direct electrical descendants — a buzz source through tuned resonances.

## 2. Reed and tube acoustics (1830s) — *described only*

**Robert Willis** and later **Hermann von Helmholtz** turned the mechanical demonstrations into science. Willis showed that a vowel's identity depends on the **resonant frequency of the tube**, not on the reed — sweep the tube length and one vowel morphs into another. Helmholtz's spherical resonators isolated individual formant frequencies and established the acoustic theory the twentieth century would digitise. This is the intellectual root of the idea that a vowel *is* a pattern of formants — the pattern every engine here stores in its vowel table.

---

## 3. The vocoder and the VODER (1938–1939) — **`vocoder`**

At **Bell Labs**, **Homer Dudley** invented the **vocoder** (voice + coder) to compress speech for transatlantic telephony. His insight: separate the slowly-changing *spectral envelope* (the formants) from the fast *excitation* (the pitch). Analysis measured the energy in ~10 band-pass channels; synthesis re-created the voice from a **buzz** (a pulse train at the pitch) plus a **hiss** (noise), split through the same bands and scaled by the measured envelopes.

Dudley then built the **VODER** (Voice Operating Demonstrator), a synthesis-only vocoder **played by hand** — an operator used a keyboard and a foot pedal (for pitch) to gate the bands in real time. Trained operators demonstrated it at the **1939 New York World's Fair**, making the machine speak whole sentences. It was the first device to synthesise continuous human speech electrically, and its buzz-plus-hiss-through-a-filterbank architecture underlies vocoders to this day (including the musical vocoder of Kraftwerk, Wendy Carlos and countless records).

**In the app** the `vocoder` engine drives 14 band-pass filters with a glottal buzz and a little hiss, setting each band's gain from the selected vowel's formant envelope — exactly Dudley's synthesis path.

---

## 4. Electronic formant synthesizers (1953–1980) — **`formant`**, **`klatt`**

Once resonators could be built from electronic circuits, the source–filter model became the dominant approach to speech synthesis for thirty years.

- **PAT — Parametric Artificial Talker (Walter Lawrence, 1953, Edinburgh).** A **parallel** bank of three formant resonators driven by a buzz/hiss source, controlled by hand-painted parameter tracks. → this is the **`formant`** engine.
- **OVE (Gunnar Fant, 1953, KTH Stockholm).** A **cascade** synthesizer, where resonators are chained in series so the relative formant amplitudes come out correctly by construction. Fant's *Acoustic Theory of Speech Production* (1960) is the field's foundational text.
- **Klatt synthesizer / KLSYN (Dennis Klatt, MIT, 1980).** The definitive classical formant synthesizer: a sophisticated voicing source, aspiration and frication noise, a **cascade** branch for vowels and a **parallel** branch for consonants, all driven by dozens of time-varying parameters. Klatt's system became **DECtalk** (1984) — and thereby the instantly recognisable synthetic voice of **Stephen Hawking**, who kept its distinctive timbre for decades. → the **`klatt`** engine models the cascade with a voiced source, aspiration and a chain of formant resonators.

Formant synthesis is fully parametric, tiny, and infinitely tunable — which is exactly why it still powers the sample-free singing engines across this whole collection.

---

## 5. The vocal tract as a physical model — and the first singing computer (1961–1962) — **`tract`**

Instead of modelling the *sound*, model the *tube*. **John Kelly** and **Carol Lochbaum** at Bell Labs treated the vocal tract as a chain of short cylindrical sections and derived a **digital waveguide** — the **Kelly–Lochbaum model** — in which sound waves travel up and down the tube, reflecting at each change of cross-sectional area. The vowel is simply the tube's **area function**; the acoustics emerge from the physics.

In **1961**, using this model on an **IBM 704**, Kelly and Lochbaum's colleague **Max Mathews** and John Kelly made the computer **sing "Daisy Bell" (Bicycle Built for Two)**, with musical accompaniment programmed by Mathews. It was the **first time a computer sang**. **Arthur C. Clarke** heard the demonstration at Bell Labs, and it became the song **HAL 9000** reverts to as it is shut down in *2001: A Space Odyssey*.

The lineage runs straight to **Pink Trombone** (Neil Thapen, 2017), a browser toy of exactly this model that made articulatory synthesis famous again. → the **`tract`** engine is a Kelly–Lochbaum ladder of cylindrical sections, its area function set by the vowel, excited by a glottal pulse.

---

## 6. Linear Predictive Coding — and a toy that talked (1971–1978) — **`lpc`**

**Linear Predictive Coding (LPC)**, developed by **Bishnu Atal & Suzanne Hanauer** (Bell Labs) and **Fumitada Itakura** (Nagoya/NTT) around 1971, models the vocal tract as an **all-pole filter** whose coefficients are *predicted* from the recent signal — each sample estimated as a weighted sum of the previous few. Excite that filter with a **pulse train** (voiced) or **noise** (unvoiced) and you reconstruct intelligible speech from a handful of numbers per frame. LPC became the backbone of digital speech coding (and, later, GSM mobile telephony).

Crucially, it was cheap enough to fit on **one chip**. **Texas Instruments'** **Speak & Spell** (1978), built on the **TMS5100** LPC chip, put a talking machine in children's hands and gave a generation its idea of what a "robot voice" sounds like. (That voice later opened E.T. and haunts electronic music.) → the **`lpc`** engine drives an all-pole resonator bank with a bright impulse train plus a touch of noise and waveshaping, for that characteristic buzzy, robotic grain.

---

## 7. FOF and CHANT — the machine learns to sing beautifully (1979–1984) — **`fof`**

At **IRCAM** in Paris, **Xavier Rodet, Yves Potard and Jean-Baptiste Barrière** built **CHANT**, whose synthesis primitive is the **FOF** — *Fonction d'Onde Formantique* (formant wave function). Rather than filtering a source, FOF **generates each formant directly** as a stream of short, overlapping grains: one exponentially-decaying sinusoidal burst per formant, fired once per glottal period. The grain's decay rate sets the formant's bandwidth; the fundamental sets how often the grains fire.

The result was, for its time, the most **convincingly sung** synthetic voice ever produced — IRCAM's synthetic soprano and choir startled listeners who assumed no computer could sing an operatic vowel. FOF's grain-based, source-free approach also connects it to granular synthesis. → the **`fof`** engine (an AudioWorklet) is the default voice throughout this collection's early-music apps precisely because it sings so well.

---

## 8. Sinusoidal and spectral modelling (1986–1990) — **`additive`**

A different abstraction: represent sound as a **sum of sinusoids** whose frequencies and amplitudes vary over time.

- **McAulay & Quatieri (1986, MIT Lincoln Lab)** introduced **sinusoidal modelling**, tracking spectral peaks frame to frame.
- **Xavier Serra & Julius Smith (1989–90, Stanford CCRMA)** extended it to **SMS — Spectral Modeling Synthesis** — the **deterministic + stochastic** split: a harmonic (sinusoidal) part *plus* a residual of filtered noise for breathiness, fricatives and attack transients. This decomposition is one of the most influential ideas in the field; it reappears, transformed, in DDSP thirty years later.

→ the **`additive`** engine builds a harmonic spectrum tracing the vowel's formant envelope, rebuilt as the pitch moves so the formants stay fixed. (The stochastic residual is exactly what the `ddsp` engine adds back as filtered noise.)

---

## 9. Concatenative synthesis: gluing real recordings together (1986–2004) — *described only*

If you want a voice to sound truly human, the shortest path is to **use human recordings**.

- **PSOLA / TD-PSOLA (Charpentier & Moulines, 1986, CNET).** *Pitch-Synchronous Overlap-Add* re-pitches and re-times recorded speech by windowing it at each glottal epoch and overlapping the grains at a new rate — changing pitch and duration without changing timbre. **MBROLA** (Dutoit, Mons, 1996) made a free diphone-concatenation engine that spoke dozens of languages.
- **Unit-selection TTS (Sagisaka; Hunt & Black, 1996)** chose the best-fitting units from a large recorded database and concatenated them, giving the most natural TTS of the 1990s–2000s.
- **VOCALOID (Kenmochi / Yamaha, 2003–2004).** Concatenative synthesis aimed squarely at **singing**: a database of recorded diphones from a single singer, pitch-shifted and spectrally smoothed to follow a score and lyrics. **Hatsune Miku** (2007) turned it into a global cultural phenomenon and gave "the voice" a virtual body.

These need recorded audio units, so they are **described only** here — but the PSOLA overlap-add idea is visible, in miniature, in how the `fof` engine overlaps glottal-period grains.

---

## 10. Statistical parametric synthesis (1999–2010s) — *described only*

Rather than store recordings, **learn a statistical model** that *generates* vocoder parameters.

- **HMM-based synthesis / HTS (Tokuda, Zen and colleagues, from ~1999)** trained hidden Markov models to predict spectral envelope, pitch and durations, which a vocoder then rendered. Small and flexible, if a little muffled ("averaging" smooths detail away).
- **High-quality analysis/synthesis vocoders** made these systems sing: **STRAIGHT** (Hideki Kawahara, 1999) and later **WORLD** (Masanori Morise, 2016) decompose a voice into **f0 + smooth spectral envelope + aperiodicity**, allowing extreme, artefact-free pitch and time manipulation. WORLD in particular became the rendering back-end for much neural singing synthesis. These are *described only* (WORLD could run in a browser but is heavy), yet their f0-plus-envelope-plus-noise decomposition is conceptually the same three ingredients the `ddsp` engine controls.

---

## 11. The neural era (2016–present) — mostly *described only*, with **`ddsp`** as the live bridge

Deep learning collapsed the source–filter pipeline into learned models that map text or score directly to waveforms.

- **WaveNet (van den Oord et al., DeepMind, 2016).** An autoregressive convolutional network predicting audio **one sample at a time**, from raw data. It leapt past every prior method in naturalness and powered Google Assistant's voice. Slow at first; later distilled (Parallel WaveNet) for real-time use. *Described only.*
- **Tacotron / Tacotron 2 (Google, 2017–18).** Sequence-to-sequence models mapping text → mel-spectrogram, rendered to audio by a neural vocoder (WaveNet, then **WaveRNN**, then GAN vocoders like **HiFi-GAN** and **Parallel WaveGAN**). This encoder-plus-neural-vocoder recipe defined modern TTS. *Described only.*
- **DDSP — Differentiable Digital Signal Processing (Engel, Hantrakul, Gu & Roberts, Google Magenta, 2020).** The pivotal "classic-meets-neural" idea: put a **harmonic oscillator bank + a time-varying filtered-noise generator** (a Serra–Smith harmonic-plus-noise synth) *inside* a neural network, and let gradient descent learn to drive them from **loudness and pitch** envelopes. The synthesis stays fully interpretable and runs in real time; the network only supplies the control signals. → the **`ddsp`** engine runs the DSP half of exactly this architecture live — a formant-weighted harmonic bank summed with formant-shaped filtered noise, balanced by loudness — the one neural-era endpoint that *is* implementable, sample-free, in a browser.
- **Neural singing: NPSS, DiffSinger, and beyond (2019–present).** Dedicated singing-voice synthesizers: the **Neural Parametric Singing Synthesizer** (Blaauw & Bonada, 2017–19); **DiffSinger** (Liu et al., 2021), which applies **diffusion models** to generate expressive singing mel-spectrograms; and a wave of end-to-end and diffusion/flow systems since. These, and modern zero-shot voice cloning, are the current frontier. *Described only* — they require trained models, though a future browser build could load a small one via WebNN or ONNX Runtime Web.

---

## The arc in one line

A **reed in a brass tube** (1779) → a **buzz through a filter bank played by hand** (1939) → **resonators, tubes and all-pole filters** that fit on a chip (1953–1978) → **grains and sinusoids** that finally sing (1979–1990) → **recorded units glued together** (1986–2007) → **statistics, then neural nets, then differentiable DSP** (1999–2020) that fold the whole 240-year history back into a single learnable harmonic-plus-noise model.

Everything above is the same two questions asked over and over: *what is the source, and what is the filter?* Open the **[explorer](https://brendanjameslynskey.github.io/Vocal_Synthesis/)**, hold one note, and switch between the answers.

---

### Sources & further reading

- Dennis Klatt, "Review of text-to-speech conversion for English," *JASA* 82(3), 1987 — the canonical history to 1987.
- Gunnar Fant, *Acoustic Theory of Speech Production*, 1960.
- Xavier Rodet, Yves Potard, Jean-Baptiste Barrière, "The CHANT Project," *Computer Music Journal*, 1984.
- Xavier Serra & Julius Smith, "Spectral Modeling Synthesis," *Computer Music Journal*, 1990.
- Jesse Engel et al., "DDSP: Differentiable Digital Signal Processing," *ICLR* 2020.
- Neil Thapen, *Pink Trombone*, 2017 (dood.al/pinktrombone) — the Kelly–Lochbaum model in a browser.
