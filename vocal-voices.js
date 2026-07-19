/**
 * vocal-voices.js — a small library of interchangeable VOCAL SYNTHESIS engines
 * for the Web Audio API, sharing one interface. The 'sampler' engine plays real
 * recorded vowels (VocalSet, CC BY 4.0) from ./voices/; every other engine is
 * pure synthesis with no samples or dependencies.
 *
 * Techniques (each a genuinely different way of making a sung voice):
 *
 *   'fof'      FOF — Fonction d'Onde Formantique (IRCAM CHANT). The voice is a
 *              stream of overlapping formant grains, one burst per glottal pulse.
 *              Runs in an AudioWorklet. The most convincingly "sung" of the four.
 *
 *   'formant'  Source–filter. A glottal-pulse oscillator run through a bank of
 *              parallel resonant band-pass formant filters. Native Web Audio nodes.
 *
 *   'additive' Additive / spectral. A sum of harmonics whose amplitudes trace the
 *              vowel's formant envelope, rebuilt per note as a PeriodicWave so the
 *              formants stay fixed while the pitch moves.
 *
 *   'tract'    Physical model. A Kelly–Lochbaum digital waveguide of the vocal
 *              tract — a ladder of cylindrical sections whose area function makes
 *              the vowel — excited by a glottal pulse. Runs in an AudioWorklet.
 *
 * Usage:
 *   await VocalVoices.init(ctx);                       // load the worklets once
 *   const v = VocalVoices.create(ctx, { technique:'fof', vowel:'a', detuneCents:0 });
 *   v.output.connect(dest);
 *   v.setFrequency(220, ctx.currentTime, 0.1);         // pitch (with optional glide)
 *   v.setLevel(1, ctx.currentTime);                    // gate the voice on
 *   v.setVowel('o', ctx.currentTime);                  // morph the vowel
 *   v.dispose();
 */
(function (global) {
    'use strict';

    // Directory this script was loaded from, so the sampled-voice assets in
    // ./voices/ resolve correctly however the page is hosted.
    const SCRIPT_DIR = (function () {
        try { const s = document.currentScript && document.currentScript.src; if (s) return s.replace(/[^/]*$/, ''); } catch (e) {}
        return '';
    })();

    // ── Sung-vowel formant tables: five formants {f: Hz, a: amp, bw: Hz} ─────────
    const VOWELS = {
        a: [{f:650,a:1,bw:80},{f:1080,a:0.5,bw:90},{f:2650,a:0.28,bw:120},{f:2900,a:0.2,bw:130},{f:3250,a:0.1,bw:140}],
        e: [{f:400,a:1,bw:70},{f:1700,a:0.45,bw:100},{f:2500,a:0.32,bw:120},{f:2900,a:0.22,bw:130},{f:3300,a:0.12,bw:140}],
        i: [{f:290,a:1,bw:60},{f:2100,a:0.4,bw:110},{f:2800,a:0.34,bw:120},{f:3300,a:0.24,bw:130},{f:3600,a:0.12,bw:150}],
        o: [{f:400,a:1,bw:70},{f:760,a:0.34,bw:80},{f:2550,a:0.2,bw:120},{f:2850,a:0.15,bw:130},{f:3250,a:0.08,bw:140}],
        u: [{f:350,a:1,bw:65},{f:600,a:0.26,bw:75},{f:2400,a:0.16,bw:120},{f:2800,a:0.1,bw:130},{f:3200,a:0.06,bw:140}]
    };

    // Vocal-tract constriction presets (tongue index/diameter, lip aperture) for
    // the Kelly–Lochbaum model. index is fraction glottis→lips.
    const TRACT_VOWELS = {
        a: { tongueIndex: 0.35, tongueDiameter: 2.6, lip: 1.5 },
        e: { tongueIndex: 0.56, tongueDiameter: 1.7, lip: 1.4 },
        i: { tongueIndex: 0.74, tongueDiameter: 1.05, lip: 1.4 },
        o: { tongueIndex: 0.40, tongueDiameter: 1.9, lip: 0.8 },
        u: { tongueIndex: 0.50, tongueDiameter: 1.4, lip: 0.7 }
    };

    // ── Worklet source: FOF grain voice ─────────────────────────────────────────
    const FOF_SRC = `
    class FofVoiceProcessor extends AudioWorkletProcessor {
      static get parameterDescriptors(){return [
        {name:'frequency',defaultValue:130,minValue:20,maxValue:3000,automationRate:'a-rate'},
        {name:'level',defaultValue:0,minValue:0,maxValue:2,automationRate:'a-rate'}];}
      constructor(o){super();o=(o&&o.processorOptions)||{};this.sr=sampleRate;this.phase=0;this.grains=[];
        this.formants=o.formants||[{f:600,a:1,bw:90}];this.tex=o.tex||0.004;
        this.breath=o.breath!=null?o.breath:0.06;this.jitter=o.jitter!=null?o.jitter:0.03;
        this.vibRate=4.2+Math.random()*1.6;this.vibDepth=o.vibDepth!=null?o.vibDepth:0.006;this.vibPhase=Math.random()*6.283;
        this.prune=Math.floor(0.065*this.sr);this.maxG=28;
        this.port.onmessage=(e)=>{if(e.data.formants)this.formants=e.data.formants;if(e.data.breath!=null)this.breath=e.data.breath;};}
      process(inp,outp,p){const out=outp[0][0];if(!out)return true;const fA=p.frequency,lA=p.level,n=out.length,T=6.283185307;
        for(let i=0;i<n;i++){const lvl=lA.length>1?lA[i]:lA[0];let f0=fA.length>1?fA[i]:fA[0];
          this.vibPhase+=T*this.vibRate/this.sr;if(this.vibPhase>T)this.vibPhase-=T;f0*=1+Math.sin(this.vibPhase)*this.vibDepth;
          this.phase+=f0/this.sr;
          if(this.phase>=1){this.phase-=1;if(lvl>0.0002||this.grains.length){this.grains.push({age:0,amp:1+(Math.random()-0.5)*this.jitter});
            while(this.grains.length&&this.grains[0].age>this.prune)this.grains.shift();if(this.grains.length>this.maxG)this.grains.shift();}}
          let s=0;const F=this.formants,tex=this.tex;
          for(let g=0;g<this.grains.length;g++){const gr=this.grains[g],t=gr.age/this.sr;let atk=1;if(t<tex)atk=0.5*(1-Math.cos(Math.PI*t/tex));
            for(let k=0;k<F.length;k++){const fm=F[k],env=atk*Math.exp(-Math.PI*fm.bw*t);if(env>1e-4)s+=gr.amp*fm.a*env*Math.sin(T*fm.f*t);}gr.age++;}
          if(this.breath>0)s+=(Math.random()*2-1)*this.breath*(0.4+0.6*Math.min(1,this.grains.length/3));
          out[i]=s*lvl*0.22;}
        return true;}}
    registerProcessor('fof-voice',FofVoiceProcessor);`;

    // ── Worklet source: Kelly–Lochbaum vocal-tract voice ────────────────────────
    const TRACT_SRC = `
    class TractVoiceProcessor extends AudioWorkletProcessor {
      static get parameterDescriptors(){return [
        {name:'frequency',defaultValue:130,minValue:20,maxValue:3000,automationRate:'a-rate'},
        {name:'level',defaultValue:0,minValue:0,maxValue:2,automationRate:'a-rate'}];}
      constructor(o){super();o=(o&&o.processorOptions)||{};this.sr=sampleRate;this.N=28;
        this.L=new Float64Array(this.N);this.R=new Float64Array(this.N);
        this.jL=new Float64Array(this.N+1);this.jR=new Float64Array(this.N+1);
        this.k=new Float64Array(this.N+1);this.diam=new Float64Array(this.N);
        this.glottalRefl=0.75;this.lipRefl=-0.85;this.phase=0;this.hp=0;this.hpPrev=0;
        this.vibRate=4.4+Math.random()*1.2;this.vibPhase=Math.random()*6.283;this.vibDepth=o.vibDepth!=null?o.vibDepth:0.006;
        this.breath=o.breath!=null?o.breath:0.02;this.tense=0.85;
        this.setShape(o.shape||{tongueIndex:0.4,tongueDiameter:2.2,lip:1.3});
        this.port.onmessage=(e)=>{if(e.data.shape)this.setShape(e.data.shape);if(e.data.breath!=null)this.breath=e.data.breath;};}
      setShape(s){const N=this.N;
        for(let i=0;i<N;i++){const x=i/(N-1);
          let d=1.5;                                   // rest profile
          if(x<0.18)d=0.7+x/0.18*0.8;                  // glottal end narrows
          const ti=s.tongueIndex,tw=0.22;              // tongue constriction (Gaussian dip)
          d-= (s.tongueDiameter>0? (1.9-s.tongueDiameter):0)*Math.exp(-Math.pow((x-ti)/tw,2));
          if(x>0.86)d=Math.min(d,s.lip);               // lip aperture
          this.diam[i]=Math.max(0.05,d);}
        // reflection coefficients from areas (A ~ diam^2)
        for(let i=1;i<N;i++){const a1=this.diam[i-1]*this.diam[i-1],a2=this.diam[i]*this.diam[i];
          this.k[i]=(a1-a2)/(a1+a2+1e-6);}
        this.k[0]=this.glottalRefl;this.k[N]=this.lipRefl;}
      glottal(ph,tense){ // Rosenberg-like pulse, tenseness shapes it
        const tp=0.6,tn=0.16;
        if(ph<tp)return tense*(3*(ph/tp)*(ph/tp)-2*(ph/tp)*(ph/tp)*(ph/tp));
        if(ph<tp+tn){const u=(ph-tp)/tn;return tense*(1-u*u);}
        return 0;}
      step(gl){const N=this.N,R=this.R,L=this.L,jR=this.jR,jL=this.jL,k=this.k;
        jR[0]=L[0]*this.glottalRefl+gl;
        for(let i=1;i<N;i++){const w=k[i]*(R[i-1]+L[i]);jR[i]=R[i-1]-w;jL[i-1]=L[i]+w;}
        jL[N-1]=R[N-1]*this.lipRefl;
        for(let i=0;i<N;i++){R[i]=jR[i]*0.9995;L[i]=jL[i]*0.9995;}
        return R[N-1];}
      process(inp,outp,p){const out=outp[0][0];if(!out)return true;const fA=p.frequency,lA=p.level,n=out.length,T=6.283185307;
        for(let i=0;i<n;i++){const lvl=lA.length>1?lA[i]:lA[0];let f0=fA.length>1?fA[i]:fA[0];
          this.vibPhase+=T*this.vibRate/this.sr;if(this.vibPhase>T)this.vibPhase-=T;f0*=1+Math.sin(this.vibPhase)*this.vibDepth;
          this.phase+=f0/this.sr;if(this.phase>=1)this.phase-=1;
          let g=this.glottal(this.phase,this.tense);if(this.breath>0)g+=(Math.random()*2-1)*this.breath;
          g*=lvl;
          let o1=this.step(g);o1=this.step(g);        // 2x oversample for bandwidth/stability
          // radiation highpass (lip differentiation)
          const hp=o1-this.hpPrev+0.995*this.hp;this.hp=hp;this.hpPrev=o1;
          out[i]=hp*lvl*0.6;}
        return true;}}
    registerProcessor('tract-voice',TractVoiceProcessor);`;

    // Worklet readiness is tracked PER AudioContext (a context can only use
    // worklets whose modules were added to it), so the library is safe even if
    // an app builds more than one context.
    async function init(ctx) {
        if (!ctx.__vocalWorklets) {
            try {
                for (const src of [FOF_SRC, TRACT_SRC]) {
                    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
                    await ctx.audioWorklet.addModule(url);
                }
                ctx.__vocalWorklets = true;
            } catch (e) {
                ctx.__vocalWorklets = false;
            }
        }
        await loadSamples(ctx);           // decode the real-voice sample bank (safe if it 404s)
        return !!ctx.__vocalWorklets;
    }

    // ── Sampled-voice bank (real VocalSet vowels, formant-preserving pitch grid) ──
    // Loaded once per context. Each loop is a seamless, steady sung vowel at a
    // known pitch; the runtime detunes the nearest loop by ≤ a few semitones.
    async function loadSamples(ctx) {
        if (ctx.__vocalSamples || ctx.__vocalSamplesTried) return ctx.__vocalSamples;
        ctx.__vocalSamplesTried = true;
        const base = api.sampleBase || (SCRIPT_DIR + 'voices/');
        try {
            const grid = await (await fetch(base + 'grid.json')).json();
            const map = {}, byPartVowel = {};
            await Promise.all(grid.map(async (g) => {
                const ab = await (await fetch(base + g.file)).arrayBuffer();
                const buffer = await ctx.decodeAudioData(ab);
                const key = g.part + '_' + g.midi + '_' + g.vowel;
                map[key] = { buffer, hz: g.hz, midi: g.midi, part: g.part, vowel: g.vowel };
                const pk = g.part + '|' + g.vowel;
                (byPartVowel[pk] = byPartVowel[pk] || []).push({ midi: g.midi, key });
            }));
            for (const k in byPartVowel) byPartVowel[k].sort((a, b) => a.midi - b.midi);
            ctx.__vocalSamples = { map, byPartVowel };
        } catch (e) { ctx.__vocalSamples = null; }
        return ctx.__vocalSamples;
    }
    function hasSamples(ctx) { return !!(ctx && ctx.__vocalSamples); }

    function hasWorklets(ctx) { return !!(ctx && ctx.__vocalWorklets); }

    // ── Consonant articulation ─────────────────────────────────────────────
    // Real singing articulates a consonant at each syllable onset (and often a
    // coda), then flows the melisma on the vowel. Most consonants are noise or
    // transient events we can synthesise procedurally — no samples needed — so
    // "Ky-ri-e" gets its k, "Sanctus" its s. Voiced consonants (m,n,l,r) use a
    // brief pitched murmur at the note's fundamental. Tuned for ecclesiastical
    // Latin but general enough for the vernacular song texts too.
    let _noiseBuf = null;
    function getNoise(ctx) {
        if (ctx.__vocalNoise) return ctx.__vocalNoise;
        const n = Math.floor(ctx.sampleRate * 2), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        ctx.__vocalNoise = buf; return buf;
    }
    // A slow, smooth random-walk control signal in [-1,1] (20 s, looped). Used
    // to give each looped-sample layer its own aperiodic pitch/amplitude drift,
    // so a short loop repeated under a long held note never reads as identical
    // stitched copies — the seam and spectral repeat are smeared into a living,
    // breathing sustain. One buffer per context; each layer reads it at a random
    // rate and phase, so layers stay decorrelated.
    function getDrift(ctx) {
        if (ctx.__vocalDrift) return ctx.__vocalDrift;
        const n = Math.floor(ctx.sampleRate * 20), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
        let vel = 0, val = 0, mx = 1e-6;
        for (let i = 0; i < n; i++) { vel += (Math.random() * 2 - 1) * 0.0009; vel *= 0.9992; val += vel; d[i] = val; if (Math.abs(val) > mx) mx = Math.abs(val); }
        for (let i = 0; i < n; i++) d[i] /= mx;                 // normalise to ±1
        ctx.__vocalDrift = buf; return buf;
    }
    // Phone → articulation params. cls: 'fric'|'stop'|'nasal'|'liquid'|'aspirate'.
    // cf/Q = band-pass centre/width of the noise; dur seconds; lvl relative gain;
    // voiced = add a pitched bed; closure = silent gap before a stop's burst.
    const CONSONANTS = {
        s:  { cls: 'fric', cf: 6800, Q: 1.3, dur: 0.10, lvl: 0.11 },
        z:  { cls: 'fric', cf: 6200, Q: 1.3, dur: 0.08, lvl: 0.08, voiced: true },
        sh: { cls: 'fric', cf: 3400, Q: 1.6, dur: 0.11, lvl: 0.12 },   // 'sc'+e/i, 'x' softening
        f:  { cls: 'fric', cf: 5200, Q: 0.6, dur: 0.09, lvl: 0.07 },
        v:  { cls: 'fric', cf: 4200, Q: 0.7, dur: 0.06, lvl: 0.06, voiced: true },
        th: { cls: 'fric', cf: 6400, Q: 0.5, dur: 0.08, lvl: 0.05 },
        h:  { cls: 'aspirate', cf: 2400, Q: 0.4, dur: 0.07, lvl: 0.05 },
        t:  { cls: 'stop', cf: 3600, Q: 1.0, dur: 0.014, lvl: 0.17, closure: 0.03 },
        d:  { cls: 'stop', cf: 3000, Q: 1.0, dur: 0.012, lvl: 0.12, closure: 0.02, voiced: true },
        p:  { cls: 'stop', cf: 1200, Q: 0.8, dur: 0.010, lvl: 0.13, closure: 0.03 },
        b:  { cls: 'stop', cf: 900,  Q: 0.8, dur: 0.010, lvl: 0.10, closure: 0.02, voiced: true },
        k:  { cls: 'stop', cf: 1800, Q: 1.4, dur: 0.015, lvl: 0.16, closure: 0.035 }, // guttural/back
        g:  { cls: 'stop', cf: 1500, Q: 1.4, dur: 0.013, lvl: 0.12, closure: 0.02, voiced: true },
        m:  { cls: 'nasal', lp: 360, dur: 0.07, lvl: 0.13 },
        n:  { cls: 'nasal', lp: 480, dur: 0.06, lvl: 0.13 },
        ng: { cls: 'nasal', lp: 300, dur: 0.07, lvl: 0.12 },
        l:  { cls: 'liquid', lp: 760, dur: 0.045, lvl: 0.12 },
        r:  { cls: 'liquid', lp: 620, dur: 0.055, lvl: 0.12, tap: true },  // rolled/tapped r
        w:  { cls: 'liquid', lp: 520, dur: 0.04, lvl: 0.09 },
        y:  { cls: 'liquid', lp: 1100, dur: 0.04, lvl: 0.09 }
    };
    // Ecclesiastical-Latin grapheme → phone, context-sensitive (c/g/sc soften
    // before e,i,ae,oe; digraphs ch/ph/th/gn/qu/x). Returns array of phone ids.
    function graphemesToPhones(cluster, nextVowel) {
        const soft = /^[eiœæy]/.test(nextVowel || '');
        const s = cluster.toLowerCase(), out = [];
        for (let i = 0; i < s.length;) {
            const two = s.substr(i, 2);
            if (two === 'ch') { out.push('k'); i += 2; }            // Christe = Kriste
            else if (two === 'ph') { out.push('f'); i += 2; }
            else if (two === 'th') { out.push('t'); i += 2; }       // Latin th = t
            else if (two === 'gn') { out.push('ng'); out.push('y'); i += 2; } // agnus ≈ any-us
            else if (two === 'qu') { out.push('k'); out.push('w'); i += 2; }
            else if (two === 'sc') { out.push(soft ? 'sh' : 'k'); if (!soft) out.push('k'); i += 2; }
            else {
                const c = s[i];
                if (c === 'c') out.push(soft ? 'sh' : 'k');         // Cecilia softens
                else if (c === 'g') out.push(soft ? 'y' : 'g');     // (soft g ≈ palatal glide, approx)
                else if (c === 'x') { out.push('k'); out.push('s'); }
                else if (c === 'j') out.push('y');                  // Latin j = y
                else if (c === 'w') out.push('w');
                else if ('bdfhklmnprstvz'.includes(c)) out.push(c);
                // silent/ignored: 'h' inside words is weak but we keep leading h; skip anything else
                i += 1;
            }
        }
        return out.filter((p) => CONSONANTS[p]);
    }
    // Split a syllable's text into {onset:[phones], coda:[phones]} around its vowel core.
    const _isVowel = (c) => 'aeiouyœæ'.includes(c);
    function splitSyllable(text) {
        const s = (text || '').toLowerCase().replace(/[^a-zœæ]/g, '');
        if (!s) return { onset: [], coda: [] };
        let a = 0; while (a < s.length && !_isVowel(s[a])) a++;
        let b = s.length; while (b > a && !_isVowel(s[b - 1])) b--;
        const onsetC = s.slice(0, a), firstVowel = s[a] || '', codaC = s.slice(b);
        return { onset: graphemesToPhones(onsetC, firstVowel), coda: graphemesToPhones(codaC, '') };
    }

    // Build a PeriodicWave whose harmonic amplitudes trace the formant envelope
    // at a given fundamental (used by the 'additive' technique).
    function formantWave(ctx, f0, formants) {
        const nyq = ctx.sampleRate / 2;
        const K = Math.max(4, Math.min(64, Math.floor(nyq / f0)));
        const real = new Float32Array(K + 1), imag = new Float32Array(K + 1);
        for (let k = 1; k <= K; k++) {
            const fh = k * f0;
            let amp = 0;
            for (const fm of formants) {
                const d = (fh - fm.f) / (fm.bw * 0.5);
                amp += fm.a / (1 + d * d);                 // Lorentzian formant peak
            }
            amp *= Math.pow(k, -0.35);                      // gentle source tilt
            imag[k] = amp;
        }
        return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    }

    function glottalWave(ctx) {
        const n = 40, real = new Float32Array(n), imag = new Float32Array(n);
        for (let k = 1; k < n; k++) imag[k] = 1 / Math.pow(k, 1.2);
        return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    }

    // Bright, near-flat-spectrum impulse-train wave — the classic buzzy LPC /
    // Speak-&-Spell excitation (many harmonics of nearly equal weight).
    function impulseWave(ctx) {
        const n = 32, real = new Float32Array(n), imag = new Float32Array(n);
        for (let k = 1; k < n; k++) imag[k] = 1 / Math.sqrt(k);   // ~ -3 dB/oct, still buzzy
        return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    }

    // A looping white-noise BufferSource (2 s), used as the hiss/aspiration/
    // stochastic excitation in the vocoder, ddsp, klatt and lpc techniques.
    function makeNoise(ctx) {
        const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = buf; src.loop = true;
        return src;
    }

    // Sample a vowel's formant envelope (sum of Lorentzian peaks) at one frequency —
    // this sets each vocoder band gain and each ddsp/klatt resonator amplitude.
    function formantEnvAt(freq, formants) {
        let amp = 0;
        for (const fm of formants) {
            const d = (freq - fm.f) / (fm.bw * 0.65);
            amp += fm.a / (1 + d * d);
        }
        return amp;
    }

    // ── The voice factory ───────────────────────────────────────────────────────
    function create(ctx, opts) {
        opts = opts || {};
        const technique = opts.technique || 'fof';
        const vowelName = opts.vowel || 'a';
        const detuneCents = opts.detuneCents || 0;
        const detuneFactor = Math.pow(2, detuneCents / 1200);
        const breath = opts.breath != null ? opts.breath : 0.06;
        const vibDepth = opts.vibDepth != null ? opts.vibDepth : 0.006;

        if ((technique === 'fof' || technique === 'tract') && ctx.__vocalWorklets) {
            const name = technique === 'fof' ? 'fof-voice' : 'tract-voice';
            const processorOptions = technique === 'fof'
                ? { formants: VOWELS[vowelName], breath, vibDepth, jitter: 0.03 }
                : { shape: TRACT_VOWELS[vowelName], breath: breath * 0.4, vibDepth };
            const node = new AudioWorkletNode(ctx, name, { numberOfInputs: 0, outputChannelCount: [1], processorOptions });
            const freqParam = node.parameters.get('frequency');
            const levelParam = node.parameters.get('level');
            return {
                technique, output: node,
                setFrequency(f, t, glide) {
                    const target = f * detuneFactor;
                    freqParam.cancelScheduledValues(t);
                    if (glide && glide > 0) { freqParam.setValueAtTime(freqParam.value || target, t); freqParam.exponentialRampToValueAtTime(Math.max(1, target), t + glide); }
                    else freqParam.setValueAtTime(target, t);
                },
                setLevel(v, t) { levelParam.cancelScheduledValues(t); levelParam.setValueAtTime(v, t); },
                setVowel(name2, t) {
                    if (technique === 'fof') node.port.postMessage({ formants: VOWELS[name2] });
                    else node.port.postMessage({ shape: TRACT_VOWELS[name2] });
                },
                dispose() { try { node.disconnect(); } catch (e) {} }
            };
        }

        // ── Sampled real voice (VocalSet vowels, formant-preserving pitch grid) ──
        // The most realistic engine: it plays actual recorded sung vowels, looped
        // seamlessly, choosing the nearest pitch in the sample grid and detuning it
        // by only a few semitones (so the vocal-tract formants stay put — no
        // "chipmunk"). A small detuned/panned ensemble gives a choral width, and a
        // gentle vibrato LFO rides each voice's detune.
        if (technique === 'sampler' && hasSamples(ctx)) {
            const bank = ctx.__vocalSamples;
            const voicePref = opts.voice || 'auto';           // 'auto' | 'male' | 'female'
            const size = opts.ensemble != null ? opts.ensemble : 3;
            const vibDepthCents = opts.vibCents != null ? opts.vibCents : (vibDepth * 1200); // reuse vibDepth (ratio) → cents
            const vibRate = opts.vibRate != null ? opts.vibRate : (4.6 + Math.random() * 1.2);

            const out = ctx.createGain(); out.gain.value = 0;   // voice gate (vowel)
            // voiceOut = exposed output = gated vowel + ungated consonant tap, so
            // articulated consonants sound through/around the vowel gate.
            const voiceOut = ctx.createGain(); voiceOut.gain.value = 1; out.connect(voiceOut);
            const consBus = ctx.createGain(); consBus.gain.value = 1; consBus.connect(voiceOut);
            // shared vibrato LFO → depth gain → fans out to every source.detune
            const lfo = ctx.createOscillator(); lfo.frequency.value = vibRate;
            const lfoDepth = ctx.createGain(); lfoDepth.gain.value = vibDepthCents;
            lfo.connect(lfoDepth); lfo.start(ctx.currentTime + Math.random() * 0.1);

            const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
            function pickPart(midi) {
                if (voicePref === 'male') return 'm';
                if (voicePref === 'female') return 'f';
                return midi < 66 ? 'm' : 'f';                   // overlap at F#4
            }
            function pickLoop(vowelName, hz) {
                const midi = hzToMidi(hz), part = pickPart(midi);
                let list = bank.byPartVowel[part + '|' + vowelName] || bank.byPartVowel['m|' + vowelName] || bank.byPartVowel['f|' + vowelName];
                if (!list || !list.length) return null;
                let best = list[0], bd = Math.abs(list[0].midi - midi);
                for (const e of list) { const d = Math.abs(e.midi - midi); if (d < bd) { bd = d; best = e; } }
                return bank.map[best.key];
            }

            // ── Granular sustain ────────────────────────────────────────────
            // Rather than LOOP the short source buffer (which repeats audibly
            // under a long held note), spray overlapping grains read from RANDOM
            // positions of the vowel sample, each with its own pitch, amplitude
            // and pan jitter. Random positions ⇒ the sustain never repeats; the
            // per-grain jitter gives it a living, breathing quality. A lightweight
            // lookahead scheduler keeps grains flowing while the voice exists.
            let curVowel = vowelName, curLoop = pickLoop(curVowel, 200);
            // pitch-ramp state so setFrequency can glide smoothly between grains
            let hzFrom = 200, hzTo = 200, rampT0 = 0, rampDur = 0;
            function hzAt(t) {
                if (rampDur <= 0 || t >= rampT0 + rampDur) return hzTo;
                if (t <= rampT0) return hzFrom;
                return hzFrom * Math.pow(hzTo / hzFrom, (t - rampT0) / rampDur);   // cents-linear glide
            }
            const GDUR_MIN = 0.12, GDUR_MAX = 0.18, OVERLAP = 4.2;   // high overlap ⇒ smooth (steady) amplitude
            const panSpread = size > 1 ? 0.6 : 0.35;
            const activeGrains = new Set();
            let nextGrainAt = 0, alive = true;

            function spawnGrain(at) {
                const loop = curLoop; if (!loop || !loop.buffer) return;
                const gdur = GDUR_MIN + Math.random() * (GDUR_MAX - GDUR_MIN);
                const hz = hzAt(at + gdur * 0.5);
                const cents = 1200 * Math.log2(hz / loop.hz) + detuneCents + (Math.random() - 0.5) * 9; // per-grain pitch jitter
                const rate = Math.pow(2, cents / 1200);
                const src = ctx.createBufferSource(); src.buffer = loop.buffer; src.loop = false;
                src.detune.value = cents;
                lfoDepth.connect(src.detune);                            // musical vibrato carries across grains
                const g = ctx.createGain(); g.gain.value = 0;
                const amp = (0.85 + Math.random() * 0.3) / Math.sqrt(OVERLAP);   // mild per-grain amplitude jitter
                // raised-cosine (triangular) window — click-free overlap-add
                g.gain.setValueAtTime(0, at);
                g.gain.linearRampToValueAtTime(amp, at + gdur * 0.5);
                g.gain.linearRampToValueAtTime(0, at + gdur);
                const need = gdur * rate;                                 // buffer-seconds consumed at this rate
                const maxOff = Math.max(0, loop.buffer.duration - need - 0.005);
                const off = Math.random() * maxOff;                      // RANDOM read position ⇒ no periodicity
                if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = (Math.random() - 0.5) * panSpread; src.connect(g); g.connect(p); p.connect(out); }
                else { src.connect(g); g.connect(out); }
                try { src.start(at, off, need + 0.02); } catch (e) { return; }
                activeGrains.add(src);
                src.onended = () => { activeGrains.delete(src); try { src.disconnect(); } catch (e) {} };
            }

            // Lookahead scheduler: keep ~140 ms of grains queued on the audio clock.
            function tick() {
                if (!alive) return;
                const ahead = ctx.currentTime + 0.14;
                if (nextGrainAt < ctx.currentTime) nextGrainAt = ctx.currentTime;
                let guard = 0;
                while (nextGrainAt < ahead && guard++ < 64) {
                    spawnGrain(nextGrainAt);
                    nextGrainAt += (GDUR_MIN + Math.random() * (GDUR_MAX - GDUR_MIN)) / OVERLAP;   // hop = grain / overlap
                }
            }
            const grainTimer = (typeof setInterval === 'function') ? setInterval(tick, 60) : null;
            tick();

            // Play one procedural consonant into the ungated consonant bus.
            // Fricatives/stops = band-passed noise; nasals/liquids = a brief
            // low-passed pitched murmur at the note's fundamental.
            function playConsonant(phone, startAt, pitchHz) {
                const p = CONSONANTS[phone]; if (!p) return;
                const t0 = Math.max(ctx.currentTime, startAt);
                if (p.cls === 'nasal' || p.cls === 'liquid') {
                    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = pitchHz || curHz || 200;
                    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = p.lp; lp.Q.value = 0.7;
                    const g = ctx.createGain(); g.gain.value = 0;
                    o.connect(lp); lp.connect(g); g.connect(consBus);
                    o.start(t0);
                    if (p.tap) {   // rolled r: a couple of quick amplitude taps
                        const n = 3, seg = p.dur / n;
                        for (let k = 0; k < n; k++) { g.gain.setValueAtTime(0, t0 + k * seg); g.gain.linearRampToValueAtTime(p.lvl, t0 + k * seg + seg * 0.35); g.gain.linearRampToValueAtTime(0.0, t0 + (k + 1) * seg); }
                    } else {
                        g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(p.lvl, t0 + p.dur * 0.3); g.gain.setTargetAtTime(0, t0 + p.dur * 0.6, 0.03);
                    }
                    o.stop(t0 + p.dur + 0.12);
                } else {           // fric / stop / aspirate: filtered noise burst
                    const closure = p.closure || 0, at = t0 + closure;
                    const src = ctx.createBufferSource(); src.buffer = getNoise(ctx); src.loop = true;
                    src.playbackRate.value = 0.8 + Math.random() * 0.4;
                    const bp = ctx.createBiquadFilter();
                    bp.type = p.cls === 'aspirate' ? 'lowpass' : 'bandpass'; bp.frequency.value = p.cf; bp.Q.value = p.Q;
                    const g = ctx.createGain(); g.gain.value = 0;
                    src.connect(bp); bp.connect(g); g.connect(consBus);
                    let bed = null;
                    if (p.voiced) {  // voiced z/v/d/g/b: a soft pitched bed under the noise
                        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = pitchHz || curHz || 200;
                        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
                        const bg = ctx.createGain(); bg.gain.value = 0; o.connect(lp); lp.connect(bg); bg.connect(consBus);
                        o.start(at); bg.gain.setValueAtTime(0, at); bg.gain.linearRampToValueAtTime(p.lvl * 0.6, at + 0.006); bg.gain.setTargetAtTime(0, at + p.dur * 0.5, 0.02); o.stop(at + p.dur + 0.1); bed = o;
                    }
                    src.start(at);
                    const atk = p.cls === 'stop' ? 0.002 : p.dur * 0.25;
                    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(p.lvl, at + atk); g.gain.setTargetAtTime(0, at + p.dur * (p.cls === 'stop' ? 0.4 : 0.6), p.cls === 'stop' ? 0.012 : 0.03);
                    src.stop(at + p.dur + 0.12);
                }
            }
            // Articulate a syllable's consonants around its vowel. Onset phones end
            // just before vowelOnset (so "sss-AH"); coda phones fire at noteEnd.
            function articulate(text, vowelOnset, noteEnd, pitchHz) {
                const { onset, coda } = splitSyllable(text);
                if (onset.length) {
                    let dur = 0; for (const p of onset) dur += (CONSONANTS[p].dur + (CONSONANTS[p].closure || 0));
                    let t = vowelOnset - dur;
                    for (const p of onset) { playConsonant(p, t, pitchHz); t += CONSONANTS[p].dur + (CONSONANTS[p].closure || 0); }
                }
                if (coda.length && noteEnd != null) {
                    let t = noteEnd;
                    for (const p of coda) { playConsonant(p, t, pitchHz); t += CONSONANTS[p].dur + (CONSONANTS[p].closure || 0); }
                }
            }

            return {
                technique, output: voiceOut, articulate,
                setFrequency(f, t, glide) {
                    const now = ctx.currentTime, t0 = (t && t > now) ? t : now;
                    hzFrom = hzAt(t0); hzTo = f; rampT0 = t0; rampDur = (glide && glide > 0) ? glide : 0;
                    // re-pick the nearest-pitch sample so the grains stay formant-accurate
                    curLoop = pickLoop(curVowel, f) || curLoop;
                },
                // fast-ish attack, slow smooth release on the vowel gate
                setLevel(v, t) {
                    const g = out.gain;
                    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
                    if (v >= g.value) g.linearRampToValueAtTime(v, t + 0.03);   // rising: crisp onset
                    else g.setTargetAtTime(v, t, 0.06);                          // falling: ~180ms natural decay
                },
                setVowel(name2, t) { if (name2 !== curVowel) { curVowel = name2; curLoop = pickLoop(name2, hzTo) || curLoop; } },
                dispose() {
                    alive = false; try { if (grainTimer) clearInterval(grainTimer); } catch (e) {}
                    // fade the gate before stopping grains so teardown never clicks
                    const t = ctx.currentTime, fade = 0.2;
                    try { out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(out.gain.value, t); out.gain.linearRampToValueAtTime(0, t + fade); } catch (e) {}
                    try { lfo.stop(t + fade + 0.05); } catch (e) {}
                    activeGrains.forEach((s) => { try { s.stop(t + fade + 0.12); } catch (e) {} });
                    setTimeout(() => { try { out.disconnect(); } catch (e) {} try { consBus.disconnect(); } catch (e) {} try { voiceOut.disconnect(); } catch (e) {} }, (fade + 0.25) * 1000);
                }
            };
        }

        // ── Channel vocoder / VODER (Dudley, Bell Labs 1939) ────────────────────
        // Buzz (pulse train at f0) + hiss (noise) split through a bank of band-pass
        // filters whose gains are the vowel's formant envelope at each band centre.
        if (technique === 'vocoder') {
            const out = ctx.createGain(); out.gain.value = 0;      // out gain = the voice gate
            let formants = VOWELS[vowelName];
            const buzz = ctx.createOscillator(); buzz.setPeriodicWave(glottalWave(ctx)); buzz.detune.value = detuneCents;
            const buzzGain = ctx.createGain(); buzzGain.gain.value = 1; buzz.connect(buzzGain);
            const hiss = makeNoise(ctx);
            const hissGain = ctx.createGain(); hissGain.gain.value = 0.05 + breath * 0.6; hiss.connect(hissGain);
            const NB = 14, fmin = 180, fmax = 4200;
            const bands = [];
            for (let i = 0; i < NB; i++) {
                const cf = fmin * Math.pow(fmax / fmin, i / (NB - 1));
                const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = cf; bp.Q.value = 5.5;
                const g = ctx.createGain(); g.gain.value = formantEnvAt(cf, formants);
                buzzGain.connect(bp); hissGain.connect(bp); bp.connect(g); g.connect(out);
                bands.push({ cf, g });
            }
            buzz.start(ctx.currentTime); hiss.start(ctx.currentTime);
            return {
                technique, output: out,
                setFrequency(f, t, glide) {
                    const target = f * detuneFactor;
                    if (glide && glide > 0) { buzz.frequency.setValueAtTime(buzz.frequency.value || target, t); buzz.frequency.exponentialRampToValueAtTime(Math.max(1, target), t + glide); }
                    else buzz.frequency.setValueAtTime(target, t);
                },
                setLevel(v, t) { out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(v, t); },
                setVowel(name2, t) { formants = VOWELS[name2]; bands.forEach((b) => b.g.gain.setValueAtTime(formantEnvAt(b.cf, formants), t)); },
                dispose() { try { buzz.stop(); } catch (e) {} try { hiss.stop(); } catch (e) {} try { out.disconnect(); } catch (e) {} }
            };
        }

        // ── DDSP-style harmonic + filtered noise (Engel et al. 2020) ────────────
        // A formant-weighted harmonic oscillator summed with time-varying
        // formant-shaped filtered noise — the classic-meets-neural bridge.
        if (technique === 'ddsp') {
            const out = ctx.createGain(); out.gain.value = 0;
            let formants = VOWELS[vowelName];
            let lastF0 = 200;
            const osc = ctx.createOscillator(); osc.setPeriodicWave(formantWave(ctx, lastF0, formants)); osc.detune.value = detuneCents;
            const harm = ctx.createGain(); harm.gain.value = 0.92; osc.connect(harm); harm.connect(out);
            const noise = makeNoise(ctx);
            const nGain = ctx.createGain(); nGain.gain.value = 0.10 + breath * 0.5;
            const nb = [0, 2, 3].map((idx) => {
                const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
                bp.frequency.value = formants[idx].f; bp.Q.value = Math.max(0.6, formants[idx].f / (formants[idx].bw * 2));
                noise.connect(bp); bp.connect(nGain); return { bp, idx };
            });
            nGain.connect(out);
            osc.start(ctx.currentTime); noise.start(ctx.currentTime);
            return {
                technique, output: out,
                setFrequency(f, t, glide) {
                    const target = f * detuneFactor;
                    if (glide && glide > 0) { osc.frequency.setValueAtTime(osc.frequency.value || target, t); osc.frequency.exponentialRampToValueAtTime(Math.max(1, target), t + glide); }
                    else osc.frequency.setValueAtTime(target, t);
                    if (Math.abs(f - lastF0) > lastF0 * 0.02) { lastF0 = f; try { osc.setPeriodicWave(formantWave(ctx, f, formants)); } catch (e) {} }
                },
                setLevel(v, t) {
                    out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(v, t);
                    // loudness also drives the noise/harmonic balance (more air when soft)
                    nGain.gain.setValueAtTime((0.10 + breath * 0.5) * (0.6 + 0.4 * (1 - Math.min(1, v))), t);
                },
                setVowel(name2, t) {
                    formants = VOWELS[name2];
                    try { osc.setPeriodicWave(formantWave(ctx, lastF0, formants)); } catch (e) {}
                    nb.forEach((n) => { n.bp.frequency.setValueAtTime(formants[n.idx].f, t); });
                },
                dispose() { try { osc.stop(); } catch (e) {} try { noise.stop(); } catch (e) {} try { out.disconnect(); } catch (e) {} }
            };
        }

        // ── Klatt-style cascade formant synth (Klatt KLSYN, 1980) ───────────────
        // A voicing source (+ aspiration) through a CASCADE of formant resonators;
        // the series product yields the correct relative formant amplitudes.
        if (technique === 'klatt') {
            const out = ctx.createGain(); out.gain.value = 0;
            let formants = VOWELS[vowelName];
            const src = ctx.createOscillator(); src.setPeriodicWave(glottalWave(ctx)); src.detune.value = detuneCents;
            const srcGain = ctx.createGain(); srcGain.gain.value = 1; src.connect(srcGain);
            const asp = makeNoise(ctx); const aspGain = ctx.createGain(); aspGain.gain.value = 0.02 + breath * 0.25; asp.connect(aspGain);
            const sum = ctx.createGain(); srcGain.connect(sum); aspGain.connect(sum);
            // Cascade of peaking resonators: each boosts its formant while passing the
            // rest of the source spectrum, so the series product is the vowel envelope
            // (audible, unlike series band-pass which starves the fundamental).
            const res = [];
            let chain = sum;
            for (let i = 0; i < 5; i++) {           // F1..F5 in cascade
                const pk = ctx.createBiquadFilter(); pk.type = 'peaking';
                pk.frequency.value = formants[i].f;
                pk.Q.value = Math.max(0.7, formants[i].f / formants[i].bw);
                pk.gain.value = 4 + 11 * formants[i].a;     // dB boost ∝ formant amplitude
                chain.connect(pk); chain = pk; res.push(pk);
            }
            // A gentle low-shelf cut tames the un-radiated low end (lip radiation ~ +6dB/oct).
            const tilt = ctx.createBiquadFilter(); tilt.type = 'highpass'; tilt.frequency.value = 90; tilt.Q.value = 0.5;
            const makeup = ctx.createGain(); makeup.gain.value = 0.6; chain.connect(tilt); tilt.connect(makeup); makeup.connect(out);
            src.start(ctx.currentTime); asp.start(ctx.currentTime);
            return {
                technique, output: out,
                setFrequency(f, t, glide) {
                    const target = f * detuneFactor;
                    if (glide && glide > 0) { src.frequency.setValueAtTime(src.frequency.value || target, t); src.frequency.exponentialRampToValueAtTime(Math.max(1, target), t + glide); }
                    else src.frequency.setValueAtTime(target, t);
                },
                setLevel(v, t) { out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(v, t); },
                setVowel(name2, t) {
                    formants = VOWELS[name2];
                    res.forEach((pk, i) => { pk.frequency.setValueAtTime(formants[i].f, t); pk.Q.setValueAtTime(Math.max(0.7, formants[i].f / formants[i].bw), t); pk.gain.setValueAtTime(4 + 11 * formants[i].a, t); });
                },
                dispose() { try { src.stop(); } catch (e) {} try { asp.stop(); } catch (e) {} try { out.disconnect(); } catch (e) {} }
            };
        }

        // ── LPC — all-pole resonator bank (Atal/Itakura; TI Speak & Spell 1978) ──
        // A bright impulse-train (voiced) / noise (unvoiced) excitation through a
        // parallel bank of poles, plus a soft waveshaper for the iconic robotic grit.
        if (technique === 'lpc') {
            const out = ctx.createGain(); out.gain.value = 0;
            let formants = VOWELS[vowelName];
            const buzz = ctx.createOscillator(); buzz.setPeriodicWave(impulseWave(ctx)); buzz.detune.value = detuneCents;
            const buzzGain = ctx.createGain(); buzzGain.gain.value = 1; buzz.connect(buzzGain);
            const hiss = makeNoise(ctx); const hissGain = ctx.createGain(); hissGain.gain.value = 0.03 + breath * 0.3; hiss.connect(hissGain);
            const grit = ctx.createWaveShaper();
            const curve = new Float32Array(1024);
            for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(2.2 * x); }
            grit.curve = curve; grit.oversample = '2x';
            const poles = formants.map((fm) => {
                const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
                bp.frequency.value = fm.f; bp.Q.value = Math.max(0.7, fm.f / fm.bw);
                const g = ctx.createGain(); g.gain.value = fm.a;
                buzzGain.connect(bp); hissGain.connect(bp); bp.connect(g); g.connect(grit);
                return { bp, g };
            });
            grit.connect(out);
            buzz.start(ctx.currentTime); hiss.start(ctx.currentTime);
            return {
                technique, output: out,
                setFrequency(f, t, glide) {
                    const target = f * detuneFactor;
                    if (glide && glide > 0) { buzz.frequency.setValueAtTime(buzz.frequency.value || target, t); buzz.frequency.exponentialRampToValueAtTime(Math.max(1, target), t + glide); }
                    else buzz.frequency.setValueAtTime(target, t);
                },
                setLevel(v, t) { out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(v, t); },
                setVowel(name2, t) {
                    formants = VOWELS[name2];
                    poles.forEach((p, i) => { p.bp.frequency.setValueAtTime(formants[i].f, t); p.bp.Q.setValueAtTime(Math.max(0.7, formants[i].f / formants[i].bw), t); p.g.gain.setValueAtTime(formants[i].a, t); });
                },
                dispose() { try { buzz.stop(); } catch (e) {} try { hiss.stop(); } catch (e) {} try { out.disconnect(); } catch (e) {} }
            };
        }

        // Native-node techniques: 'formant' and 'additive' (also the fallback).
        const out = ctx.createGain(); out.gain.value = 1;
        const osc = ctx.createOscillator();
        let formants = VOWELS[vowelName];

        if (technique === 'additive') {
            osc.setPeriodicWave(formantWave(ctx, 200, formants));
        } else { // 'formant'
            osc.setPeriodicWave(glottalWave(ctx));
        }
        osc.detune.value = detuneCents;

        let bands = null, lastF0 = 200;
        if (technique === 'formant') {
            bands = formants.map((fm) => {
                const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
                bp.frequency.value = fm.f; bp.Q.value = fm.f / fm.bw;
                const g = ctx.createGain(); g.gain.value = fm.a;
                osc.connect(bp); bp.connect(g); g.connect(out);
                return { bp, g, bw: fm.bw };
            });
        } else {
            osc.connect(out);
        }
        osc.start(ctx.currentTime);

        return {
            technique, output: out,
            setFrequency(f, t, glide) {
                const target = f * detuneFactor;
                if (glide && glide > 0) { osc.frequency.setValueAtTime(osc.frequency.value || target, t); osc.frequency.exponentialRampToValueAtTime(Math.max(1, target), t + glide); }
                else osc.frequency.setValueAtTime(target, t);
                if (technique === 'additive' && Math.abs(f - lastF0) > lastF0 * 0.02) {
                    lastF0 = f; try { osc.setPeriodicWave(formantWave(ctx, f, formants)); } catch (e) {}
                }
            },
            setLevel(v, t) { out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(v, t); },
            setVowel(name2, t) {
                formants = VOWELS[name2];
                if (technique === 'formant' && bands) {
                    bands.forEach((b, i) => { b.bp.frequency.setValueAtTime(formants[i].f, t); b.bp.Q.setValueAtTime(formants[i].f / formants[i].bw, t); b.g.gain.setValueAtTime(formants[i].a, t); });
                } else if (technique === 'additive') {
                    try { osc.setPeriodicWave(formantWave(ctx, lastF0, formants)); } catch (e) {}
                }
            },
            dispose() { try { osc.stop(); } catch (e) {} try { out.disconnect(); } catch (e) {} }
        };
    }

    // Ordered earliest → most modern, so the explorer walks history left-to-right.
    const TECHNIQUES = [
        { id: 'sampler',  name: 'Sampled voice',   blurb: 'Real recorded sung vowels (VocalSet), looped and pitch-mapped with formant preservation — the most realistic voice.' },
        { id: 'vocoder',  name: 'Channel vocoder', blurb: 'Buzz + hiss split through a band-pass bank gated by the vowel envelope — Dudley\'s VODER (1939).' },
        { id: 'formant',  name: 'Formant filter',  blurb: 'A glottal-pulse oscillator through parallel resonant band-pass formants (source–filter, PAT/OVE).' },
        { id: 'klatt',    name: 'Klatt cascade',   blurb: 'A voicing source + aspiration through a cascade of formant resonators — KLSYN / DECtalk (1980).' },
        { id: 'tract',    name: 'Vocal tract',     blurb: 'A Kelly–Lochbaum waveguide of the vocal tract, excited by a glottal pulse (physical model, 1962).' },
        { id: 'lpc',      name: 'LPC (all-pole)',  blurb: 'A bright impulse/noise excitation through an all-pole resonator bank — Speak & Spell (1978).' },
        { id: 'fof',      name: 'FOF (CHANT)',     blurb: 'Overlapping formant grains, one burst per glottal pulse — the IRCAM CHANT method (1979).' },
        { id: 'additive', name: 'Additive / SMS',  blurb: 'A sum of harmonics tracing the vowel formant envelope (sinusoidal / spectral modelling, 1986).' },
        { id: 'ddsp',     name: 'DDSP harmonic+noise', blurb: 'A harmonic oscillator bank summed with formant-shaped filtered noise — the neural bridge (2020).' }
    ];

    const api = { init, hasWorklets, hasSamples, loadSamples, create, VOWELS, TRACT_VOWELS, TECHNIQUES, sampleBase: null };
    global.VocalVoices = api;
})(typeof self !== 'undefined' ? self : this);
