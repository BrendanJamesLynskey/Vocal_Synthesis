/**
 * vocal-voices.js — a small library of interchangeable VOCAL SYNTHESIS engines
 * for the Web Audio API, sharing one interface. No samples, no dependencies.
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
        if (ctx.__vocalWorklets) return true;
        try {
            for (const src of [FOF_SRC, TRACT_SRC]) {
                const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
                await ctx.audioWorklet.addModule(url);
            }
            ctx.__vocalWorklets = true;
        } catch (e) {
            ctx.__vocalWorklets = false;
        }
        return !!ctx.__vocalWorklets;
    }

    function hasWorklets(ctx) { return !!(ctx && ctx.__vocalWorklets); }

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
        { id: 'vocoder',  name: 'Channel vocoder', blurb: 'Buzz + hiss split through a band-pass bank gated by the vowel envelope — Dudley\'s VODER (1939).' },
        { id: 'formant',  name: 'Formant filter',  blurb: 'A glottal-pulse oscillator through parallel resonant band-pass formants (source–filter, PAT/OVE).' },
        { id: 'klatt',    name: 'Klatt cascade',   blurb: 'A voicing source + aspiration through a cascade of formant resonators — KLSYN / DECtalk (1980).' },
        { id: 'tract',    name: 'Vocal tract',     blurb: 'A Kelly–Lochbaum waveguide of the vocal tract, excited by a glottal pulse (physical model, 1962).' },
        { id: 'lpc',      name: 'LPC (all-pole)',  blurb: 'A bright impulse/noise excitation through an all-pole resonator bank — Speak & Spell (1978).' },
        { id: 'fof',      name: 'FOF (CHANT)',     blurb: 'Overlapping formant grains, one burst per glottal pulse — the IRCAM CHANT method (1979).' },
        { id: 'additive', name: 'Additive / SMS',  blurb: 'A sum of harmonics tracing the vowel formant envelope (sinusoidal / spectral modelling, 1986).' },
        { id: 'ddsp',     name: 'DDSP harmonic+noise', blurb: 'A harmonic oscillator bank summed with formant-shaped filtered noise — the neural bridge (2020).' }
    ];

    global.VocalVoices = { init, hasWorklets, create, VOWELS, TRACT_VOWELS, TECHNIQUES };
})(typeof self !== 'undefined' ? self : this);
