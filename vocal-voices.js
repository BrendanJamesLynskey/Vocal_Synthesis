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
    // A slow, smooth random-walk control signal in [-1,1] (20 s, looped). The
    // sampler engine plays it into a shared sub-cent detune input so a held
    // note breathes slightly — alive but never detuned against itself. One
    // buffer per context; each voice reads it at its own random rate.
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
        // The most realistic engine: it plays actual recorded sung vowels,
        // choosing the nearest pitch in the sample grid and detuning it by at
        // most a semitone or so (so the vocal-tract formants stay put — no
        // "chipmunk"). Long notes are sustained by phase-coherent splicing of
        // the short recording (see below), and one shared vibrato LFO rides
        // every layer's detune so the note always stays a single pitch.
        if (technique === 'sampler' && hasSamples(ctx)) {
            const bank = ctx.__vocalSamples;
            const voicePref = opts.voice || 'auto';           // 'auto' | 'male' | 'female'
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

            // ── Phase-coherent splice sustain ───────────────────────────────
            // A long note is built from SEGMENTS of the vowel sample spliced
            // end-to-end with short crossfades. Between splices the recording
            // plays back verbatim — perfectly natural and perfectly in tune. At
            // each splice the read position jumps to a RANDOM point, but that
            // point is quantised to a whole number of pitch periods and matched
            // to a global phase accumulator, so the outgoing and incoming
            // segments are IN PHASE while they overlap: they reinforce instead
            // of beating or comb-filtering (the failure mode of jittered
            // granular). Segment lengths are randomised so splices never fall
            // on a fixed grid — the sustain never repeats, yet stays one clean
            // pitch. ALL pitch modulation (portamento, vibrato, sub-cent drift)
            // is shared by every live segment through common AudioParam inputs,
            // so simultaneous layers can never sound at different pitches.
            let curVowel = vowelName, curLoop = pickLoop(curVowel, 200);
            // pitch-ramp state so setFrequency can glide smoothly across splices
            let hzFrom = 200, hzTo = 200, rampT0 = 0, rampDur = 0;
            function hzAt(t) {
                if (rampDur <= 0 || t >= rampT0 + rampDur) return hzTo;
                if (t <= rampT0) return hzFrom;
                return hzFrom * Math.pow(hzTo / hzFrom, (t - rampT0) / rampDur);   // cents-linear glide
            }
            // ∫ hzAt dt over [a,b] — exact for the cents-linear (exponential) ramp.
            function cyclesBetween(a, b) {
                if (b <= a) return 0;
                if (rampDur <= 0) return (b - a) * hzTo;
                const t1 = rampT0, t2 = rampT0 + rampDur;
                let s = 0;
                if (a < t1) s += (Math.min(b, t1) - a) * hzFrom;
                const ra = Math.max(a, t1), rb = Math.min(b, t2);
                if (rb > ra) {
                    const fa = hzAt(ra), fb = hzAt(rb);
                    s += Math.abs(fb - fa) < 1e-9 ? fa * (rb - ra) : (fb - fa) * (rb - ra) / Math.log(fb / fa);
                }
                if (b > t2) s += (b - Math.max(a, t2)) * hzTo;
                return s;
            }
            let phC = 0, phT = 0;                       // global phase: cycles elapsed at the target pitch
            function phaseAt(t) { return t >= phT ? phC + cyclesBetween(phT, t) * detuneFactor : phC - cyclesBetween(t, phT) * detuneFactor; }

            // Shared target pitch in cents (re REF_HZ). Every segment's detune
            // listens to this ONE node, so portamento moves all layers together.
            const REF_HZ = 440;
            const pitchCents = ctx.createConstantSource();
            pitchCents.offset.value = 1200 * Math.log2(hzTo / REF_HZ);
            pitchCents.start();
            // Slow SUB-CENT random drift — also shared, so it adds life without
            // ever splitting the note into different simultaneous pitches.
            const driftSrc = ctx.createBufferSource(); driftSrc.buffer = getDrift(ctx); driftSrc.loop = true;
            driftSrc.playbackRate.value = 0.85 + Math.random() * 0.3;
            const driftGain = ctx.createGain(); driftGain.gain.value = 0.6;   // ±0.6 cents
            driftSrc.connect(driftGain); driftSrc.start();

            // Measure each loop ONCE (lazily, cached on the loop object): a 10 ms
            // pitch track by normalized autocorrelation, its median pitch, and a
            // cumulative-phase map. Real VocalSet takes are NOT dead steady — a
            // few are >100 cents off their grid label and most carry the
            // singer's own vibrato — so per-segment detune curves FLATTEN the
            // measured track to the target pitch (formants untouched: the
            // correction is only ever a few % of playback rate), and splice
            // offsets are phase-quantised through the map, not a fixed period.
            function pitchMap(loop) {
                if (loop.__pm) return loop.__pm;
                const d = loop.buffer.getChannelData(0), sr = loop.buffer.sampleRate;
                const hop = Math.max(1, Math.floor(sr * 0.01)), win = Math.floor(sr * 0.04);
                const lo = Math.max(2, Math.floor(sr / (loop.hz * 1.21))), hi = Math.min(Math.floor(sr / (loop.hz * 0.83)), Math.floor(d.length / 3));
                // 10 ms RMS bins: quiet pockets (glottal gaps, creak, edits) break
                // the phase model invisibly — frames touching one are excluded
                const nb = Math.max(1, Math.floor(d.length / hop)), bins = new Float64Array(nb);
                for (let j = 0; j < nb; j++) {
                    let e = 0; const a0 = j * hop, b0 = Math.min(d.length, a0 + hop);
                    for (let i = a0; i < b0; i++) e += d[i] * d[i];
                    bins[j] = Math.sqrt(e / (b0 - a0));
                }
                const bSorted = Array.from(bins).sort((p, q) => p - q), bMed = bSorted[Math.floor(nb / 2)] || 1e-6;
                const hzs = [], clar = [], quiet = [];
                for (let s = 0; s + win + hi < d.length; s += hop) {
                    let bl = lo, bv = -2; const vals = new Float64Array(hi - lo + 1);
                    for (let L = lo; L <= hi; L++) {
                        let num = 0, e1 = 0, e2 = 0;
                        for (let i = s; i < s + win; i++) { const p = d[i], q = d[i + L]; num += p * q; e1 += p * p; e2 += q * q; }
                        const v = num / Math.sqrt(e1 * e2 + 1e-20); vals[L - lo] = v;
                        if (v > bv) { bv = v; bl = L; }
                    }
                    let lag = bl;
                    if (bl > lo && bl < hi) {   // parabolic sub-sample refinement
                        const y1 = vals[bl - 1 - lo], y2 = vals[bl - lo], y3 = vals[bl + 1 - lo], den = y1 - 2 * y2 + y3;
                        if (Math.abs(den) > 1e-12) lag = bl + 0.5 * (y1 - y3) / den;
                    }
                    hzs.push(sr / lag); clar.push(bv);
                    let qm = Infinity;
                    for (let j = Math.floor(s / hop); j <= Math.min(nb - 1, Math.floor((s + win) / hop)); j++) if (bins[j] < qm) qm = bins[j];
                    quiet.push(qm < 0.72 * bMed);
                }
                if (!hzs.length) { hzs.push(loop.hz); clar.push(1); quiet.push(false); }
                // 3-point median filter kills single-frame estimator glitches
                const sm = hzs.map((v, i) => {
                    const p = hzs[Math.max(0, i - 1)], q = v, r = hzs[Math.min(hzs.length - 1, i + 1)];
                    return Math.max(Math.min(p, q), Math.min(Math.max(p, q), r));
                });
                // median pitch from RELIABLE frames only (strong periodicity)
                let rel = sm.filter((v, k) => clar[k] >= 0.72);
                if (!rel.length) rel = sm;
                const sorted = rel.slice().sort((p, q) => p - q), hzMed = sorted[Math.floor(sorted.length / 2)];
                // frames with weak periodicity or absurd deviation are UNRELIABLE
                // (breathy onsets, creak): bridge them by interpolation so the
                // flatten curve never chases estimator noise…
                const bad = sm.map((v, k) => quiet[k] || clar[k] < 0.72 || Math.abs(1200 * Math.log2(v / hzMed)) > 250);
                for (let k = 0; k < sm.length; k++) {
                    if (!bad[k]) continue;
                    let p = k - 1; while (p >= 0 && bad[p]) p--;
                    let q = k + 1; while (q < sm.length && bad[q]) q++;
                    const va = p >= 0 ? sm[p] : (q < sm.length ? sm[q] : hzMed);
                    const vb = q < sm.length ? sm[q] : va;
                    sm[k] = va * Math.pow(vb / va, q > p ? (k - p) / (q - p) : 0);
                }
                const cT0 = (win / 2) / sr, hopSec = hop / sr;
                // …and keep splices out of the unreliable span entirely
                let g0 = 0; while (g0 < bad.length && bad[g0]) g0++;
                let g1 = bad.length - 1; while (g1 >= 0 && bad[g1]) g1--;
                const minOff = g0 > 0 && g0 < bad.length ? cT0 + g0 * hopSec : 0;
                const maxPos = g1 >= 0 && g1 < bad.length - 1 ? cT0 + g1 * hopSec + hopSec : loop.buffer.duration;
                const hzAtPos = (t) => {
                    const u = (t - cT0) / hopSec, i = Math.max(0, Math.min(sm.length - 1, Math.floor(u)));
                    const j = Math.min(sm.length - 1, i + 1), fr = Math.max(0, Math.min(1, u - i));
                    return sm[i] * (1 - fr) + sm[j] * fr;
                };
                // cumulative phase (cycles) at 1 ms resolution over the buffer
                const step = 0.001, nSt = Math.ceil(loop.buffer.duration / step) + 2;
                const phi = new Float64Array(nSt);
                for (let k = 1; k < nSt; k++) phi[k] = phi[k - 1] + hzAtPos((k - 0.5) * step) * step;
                const phiAtPos = (t) => {
                    const u = Math.max(0, t / step), i = Math.min(nSt - 2, Math.floor(u));
                    return phi[i] + (phi[i + 1] - phi[i]) * (u - i);
                };
                loop.__pm = { hzMed, hzMin: Math.min.apply(null, sm), hzAtPos, phiAtPos, minOff, maxPos };
                return loop.__pm;
            }
            // 10 ms RMS profile of a loop (cached), for per-segment loudness
            // equalisation — keeps the sustain's amplitude steady wherever the
            // splice lands in the recording.
            function rmsProfile(loop) {
                if (loop.__rms) return loop.__rms;
                const d = loop.buffer.getChannelData(0), sr = loop.buffer.sampleRate, w = Math.max(1, Math.floor(sr * 0.01));
                const n = Math.max(1, Math.floor(d.length / w)), arr = new Float32Array(n);
                let total = 0;
                for (let k = 0; k < n; k++) {
                    let s = 0; const a0 = k * w, b0 = Math.min(d.length, a0 + w);
                    for (let i = a0; i < b0; i++) s += d[i] * d[i];
                    arr[k] = Math.sqrt(s / (b0 - a0)); total += arr[k];
                }
                loop.__rms = { arr, win: w / sr, mean: total / n }; return loop.__rms;
            }
            function rmsAt(loop, t) {
                const p = rmsProfile(loop), u = t / p.win, i = Math.max(0, Math.min(p.arr.length - 1, Math.floor(u)));
                const j = Math.min(p.arr.length - 1, i + 1), fr = Math.max(0, Math.min(1, u - i));
                return p.arr[i] * (1 - fr) + p.arr[j] * fr;
            }

            const XFADE = 0.09, SEG_MIN = 0.16, SEG_MAX = 0.34;   // splice crossfade / segment-length bounds (s)
            const segs = new Set();
            let nextAt = 0, alive = true, lastSeg = null;         // lastSeg: the most recently started segment

            // Where (in buffer seconds) is a flattened segment's read head after
            // `cyc` output cycles? Inverts the cumulative-phase map by Newton.
            function posAfter(pm, off, cyc) {
                let p = off + cyc / pm.hzMed;
                for (let it = 0; it < 3; it++) p += (pm.phiAtPos(off) + cyc - pm.phiAtPos(p)) / pm.hzAtPos(p);
                return p;
            }
            // Fine-align a candidate splice offset by cross-correlating the raw
            // waveform against what the OUTGOING segment is playing at t0 — this
            // is exact where the phase map is only approximate, so crossfading
            // segments genuinely reinforce (no mid-splice level dip or comb).
            function alignOffset(oldLoop, posOut, newLoop, cand, f) {
                try {
                    const dOld = oldLoop.buffer.getChannelData(0), dNew = newLoop.buffer.getChannelData(0);
                    const sr = newLoop.buffer.sampleRate;
                    const per = Math.max(8, Math.floor(sr / pitchMap(newLoop).hzMed));
                    const W = Math.min(per * 4, Math.floor(sr * 0.05));   // ~the crossfade's span
                    const half = Math.floor(per * 1.2);                   // ≥ a full period: a true peak is always in range
                    const i0 = Math.floor(posOut * sr), j0 = Math.floor(cand * sr);
                    if (i0 < 0 || i0 + W >= dOld.length) return { off: cand, v: 0 };
                    const lo = Math.max(-half, -j0), hi = Math.min(half, dNew.length - W - j0 - 1);
                    if (hi <= lo) return { off: cand, v: 0 };
                    let bestD = 0, bestV = -2, e1 = 0;
                    for (let k = 0; k < W; k++) e1 += dOld[i0 + k] * dOld[i0 + k];
                    for (let dlt = lo; dlt <= hi; dlt++) {
                        let num = 0, e2 = 0;
                        for (let k = 0; k < W; k++) { const p = dOld[i0 + k], q = dNew[j0 + dlt + k]; num += p * q; e2 += q * q; }
                        const v = num / Math.sqrt(e2 + 1e-12);
                        if (v > bestV) { bestV = v; bestD = dlt; }
                    }
                    return { off: cand + bestD / sr, v: bestV / Math.sqrt(e1 + 1e-12) };
                } catch (e) { return { off: cand, v: 0 }; }
            }

            // Start one segment at audio-clock time t0; returns its full-level
            // duration so the scheduler knows when the next splice is due.
            function startSegment(t0) {
                const loop = curLoop; if (!loop || !loop.buffer) return SEG_MIN;
                const pm = pitchMap(loop), prof = rmsProfile(loop);
                if (t0 > phT) { phC = phaseAt(t0); phT = t0; }
                const ph = phaseAt(t0);
                const f = hzAt(t0) * detuneFactor;
                const rate0 = f / pm.hzMed, rateMax = f / pm.hzMin;
                const dur = loop.buffer.duration, margin = 0.015;
                const needMin = (SEG_MIN + 2 * XFADE) * rateMax * 1.02 + margin;
                // stay inside the loop's RELIABLE pitch-tracked span
                const useEnd = Math.min(dur, pm.maxPos + 0.02);
                const useStart = Math.min(pm.minOff, Math.max(0, useEnd - needMin - 0.02));
                const maxOff = Math.max(useStart, useEnd - needMin);
                // random read position, then nudged (< one period) so the
                // recording's cumulative phase there matches the global phase
                const frac = ph - Math.floor(ph);
                // leave ~2.5 periods of headroom so the phase nudge and waveform
                // alignment below never push the offset past maxOff (a hard clamp
                // there would undo the alignment and dip the crossfade)
                let off = useStart + Math.random() * Math.max(0, maxOff - 2.5 / pm.hzMed - useStart);
                for (let it = 0; it < 2; it++) {
                    const p0 = pm.phiAtPos(off);
                    let dphi = frac - (p0 - Math.floor(p0));
                    dphi -= Math.round(dphi);
                    off += dphi / pm.hzAtPos(off);
                }
                // ...then aligned exactly to the OUTGOING segment's waveform
                let alignV = 1;
                if (lastSeg && t0 - lastSeg.t0 < 0.8 && lastSeg.loop.buffer) {
                    const posOut = posAfter(pitchMap(lastSeg.loop), lastSeg.off, phaseAt(t0) - phaseAt(lastSeg.t0));
                    const al = alignOffset(lastSeg.loop, posOut, loop, off, f);
                    off = al.off; alignV = al.v;
                }
                off = Math.max(0, Math.min(maxOff, off));
                const avail = (useEnd - off - margin) / (rateMax * 1.02) - 2 * XFADE;
                const segFull = Math.max(0.05, Math.min(SEG_MIN + Math.random() * (SEG_MAX - SEG_MIN), avail));
                const T = segFull + 2 * XFADE, tEnd = t0 + XFADE + segFull;   // the next segment starts at tEnd
                const src = ctx.createBufferSource(); src.buffer = loop.buffer; src.loop = false;
                const baseCents = 1200 * Math.log2(REF_HZ / pm.hzMed) + detuneCents;
                // Detune curve FLATTENS the recording's measured pitch track so
                // this segment sounds at exactly the (shared) target pitch.
                const dt = 0.005, K = Math.max(2, Math.ceil(T / dt) + 1);
                const dCurve = new Float32Array(K), gCurve = new Float32Array(K);
                // ρ-compensated fade-in: with the outgoing side fading linearly
                // (1−w) and the splice's measured waveform correlation ρ, this
                // incoming gain keeps the summed amplitude flat — it is linear w
                // when the splice is perfectly phase-matched (ρ→1) and morphs to
                // equal-power when it could not be matched (ρ→0), so a splice
                // can never dip the sustain.
                const rho = Math.max(0, Math.min(0.98, alignV));
                for (let k = 0; k < K; k++) {
                    const tau = Math.min(T, k * (T / (K - 1))), pos = off + tau * rate0;
                    dCurve[k] = baseCents - 1200 * Math.log2(pm.hzAtPos(pos) / pm.hzMed);
                    let w;
                    if (tau < XFADE) {
                        const q = 1 - tau / XFADE;   // outgoing's remaining gain
                        w = -rho * q + Math.sqrt(Math.max(0, 1 - (1 - rho * rho) * q * q));
                    } else w = tau > XFADE + segFull ? Math.max(0, (T - tau) / XFADE) : 1;
                    const eq = Math.min(1.6, Math.max(0.65, prof.mean / (rmsAt(loop, pos) + 1e-6)));
                    gCurve[k] = 0.9 * w * eq;
                }
                gCurve[0] = 0; gCurve[K - 1] = 0;
                src.detune.value = dCurve[0];
                pitchCents.connect(src.detune);                        // portamento target (shared)
                lfoDepth.connect(src.detune);                          // musical vibrato (shared)
                driftGain.connect(src.detune);                         // sub-cent life (shared)
                const g = ctx.createGain(); g.gain.value = 0;
                // separate series "kill" gain: resplice fades THIS, never the
                // value-curve param (cancelAndHold on an active curve snaps —
                // an audible hard cut — in some engines)
                const kg = ctx.createGain(); kg.gain.value = 1;
                src.connect(g); g.connect(kg); kg.connect(out);
                try {
                    src.detune.setValueCurveAtTime(dCurve, t0, T);
                    g.gain.setValueCurveAtTime(gCurve, t0, T);
                    src.start(t0, off); src.stop(t0 + T + 0.02);
                } catch (e) { try { src.disconnect(); } catch (e2) {} try { kg.disconnect(); } catch (e2) {} return segFull; }
                const seg = { src, g, kg, t0, off, loop, tStop: t0 + T + 0.02 };
                segs.add(seg); lastSeg = seg;
                src.onended = () => { segs.delete(seg); try { src.disconnect(); } catch (e) {} try { g.disconnect(); } catch (e) {} try { kg.disconnect(); } catch (e) {} };
                return segFull;
            }

            // Lookahead scheduler: keep ~0.35 s of segments queued on the audio clock.
            function tick() {
                if (!alive) return;
                const now = ctx.currentTime;
                if (nextAt < now + 0.005) nextAt = now + 0.005;
                let guard = 0;
                while (nextAt < now + 0.35 && guard++ < 16) nextAt += XFADE + startSegment(nextAt);
            }
            const segTimer = (typeof setInterval === 'function') ? setInterval(tick, 80) : null;
            tick();

            // Retire every live/pending segment with a crossfade ending at t+fade
            // and start fresh ones — used when the vowel changes mid-note.
            function resplice(t, fade) {
                const now = ctx.currentTime, tv = Math.max(now + 0.03, t || 0);
                segs.forEach((s) => {
                    try {
                        const kk = s.kg.gain;
                        if (s.t0 >= tv) { kk.setValueAtTime(0, now); s.src.stop(tv); }
                        else {
                            // fade the kill gain — the value-curve param stays untouched;
                            // never let the fade outlive the source's scheduled stop
                            const fEnd = Math.max(now + 0.01, Math.min(tv + fade, (s.tStop || (tv + fade)) - 0.005));
                            kk.setValueAtTime(1, now); kk.linearRampToValueAtTime(0, fEnd);
                        }
                    } catch (e) {}
                });
                nextAt = tv; tick();
            }

            // Play one procedural consonant into the ungated consonant bus.
            // Fricatives/stops = band-passed noise; nasals/liquids = a brief
            // low-passed pitched murmur at the note's fundamental.
            function playConsonant(phone, startAt, pitchHz) {
                const p = CONSONANTS[phone]; if (!p) return;
                const t0 = Math.max(ctx.currentTime, startAt);
                if (p.cls === 'nasal' || p.cls === 'liquid') {
                    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = pitchHz || hzTo || 200;
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
                        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = pitchHz || hzTo || 200;
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
                    if (t0 > phT) { phC = phaseAt(t0); phT = t0; }   // integrate the OLD ramp up to t0
                    hzFrom = hzAt(t0); hzTo = f; rampT0 = t0; rampDur = (glide && glide > 0) ? glide : 0;
                    // glide the shared pitch node: linear-in-cents == the exponential hzAt models
                    const p = pitchCents.offset, c0 = 1200 * Math.log2(Math.max(1, hzFrom) / REF_HZ), c1 = 1200 * Math.log2(Math.max(1, f) / REF_HZ);
                    try {
                        p.cancelScheduledValues(t0); p.setValueAtTime(c0, t0);
                        if (rampDur > 0) p.linearRampToValueAtTime(c1, t0 + rampDur);
                        else p.setValueAtTime(c1, t0);
                    } catch (e) {}
                    // re-pick the nearest-pitch sample so segments stay formant-accurate
                    curLoop = pickLoop(curVowel, f) || curLoop;
                    // a big jump invalidates in-flight segments' rate budgets
                    // (they could run out of buffer): resplice cleanly instead
                    if (Math.abs(1200 * Math.log2(Math.max(1, f) / Math.max(1, hzFrom))) > 250) resplice(t0, 0.06);
                },
                // fast-ish attack, slow smooth release on the vowel gate
                setLevel(v, t) {
                    const g = out.gain;
                    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
                    if (v >= g.value) g.linearRampToValueAtTime(v, t + 0.03);   // rising: crisp onset
                    else g.setTargetAtTime(v, t, 0.06);                          // falling: ~180ms natural decay
                },
                setVowel(name2, t) {
                    if (name2 === curVowel) return;
                    curVowel = name2; curLoop = pickLoop(name2, hzTo) || curLoop;
                    resplice(t, 0.09);                 // crossfade old-vowel segments into new-vowel ones
                },
                dispose() {
                    alive = false; try { if (segTimer) clearInterval(segTimer); } catch (e) {}
                    // fade the gate before stopping segments so teardown never clicks
                    const t = ctx.currentTime, fade = 0.2;
                    try { out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(out.gain.value, t); out.gain.linearRampToValueAtTime(0, t + fade); } catch (e) {}
                    try { lfo.stop(t + fade + 0.05); } catch (e) {}
                    try { driftSrc.stop(t + fade + 0.05); } catch (e) {}
                    try { pitchCents.stop(t + fade + 0.05); } catch (e) {}
                    segs.forEach((s) => { try { s.src.stop(t + fade + 0.12); } catch (e) {} });
                    setTimeout(() => {
                        try { out.disconnect(); } catch (e) {}
                        try { consBus.disconnect(); } catch (e) {}
                        try { voiceOut.disconnect(); } catch (e) {}
                        try { lfoDepth.disconnect(); } catch (e) {}
                        try { driftGain.disconnect(); } catch (e) {}
                        try { pitchCents.disconnect(); } catch (e) {}
                    }, (fade + 0.25) * 1000);
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
