// ============================================================
//  プロシージャル・サウンド (WebAudio)
// ============================================================
(function (global) {
  'use strict';

  class Sfx {
    constructor() {
      this.ctx = null;
      this.enabled = true;
      this.hums = [];
    }
    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.55;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      this.master.connect(comp).connect(ctx.destination);
      // リバーブ（簡易インパルス）
      this.verb = ctx.createConvolver();
      const len = ctx.sampleRate * 1.6;
      const buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      }
      this.verb.buffer = buf;
      this.verbGain = ctx.createGain();
      this.verbGain.gain.value = 0.25;
      this.verb.connect(this.verbGain).connect(this.master);
      // ノイズバッファ
      const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
      this.noise = nb;
      // コマの回転音（2本）
      for (let i = 0; i < 2; i++) {
        const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
        const o2 = ctx.createOscillator(); o2.type = 'triangle';
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900; f.Q.value = 6;
        const g = ctx.createGain(); g.gain.value = 0;
        const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        o1.connect(f); o2.connect(f); f.connect(g);
        if (pan) { g.connect(pan); pan.connect(this.master); } else g.connect(this.master);
        o1.start(); o2.start();
        this.hums.push({ o1, o2, f, g, pan });
      }
    }
    get t() { return this.ctx ? this.ctx.currentTime : 0; }
    _out(gainNode, reverb = 0.3) {
      gainNode.connect(this.master);
      if (reverb > 0) {
        const s = this.ctx.createGain(); s.gain.value = reverb;
        gainNode.connect(s); s.connect(this.verb);
      }
    }
    setHum(i, spin01, pan = 0, active = true) {
      if (!this.ctx || !this.hums[i]) return;
      const h = this.hums[i], t = this.t;
      const f = 70 + spin01 * 160 + i * 7;
      h.o1.frequency.setTargetAtTime(f, t, 0.05);
      h.o2.frequency.setTargetAtTime(f * 2.01, t, 0.05);
      h.f.frequency.setTargetAtTime(400 + spin01 * 2200, t, 0.08);
      h.g.gain.setTargetAtTime(active && this.enabled ? 0.018 + spin01 * 0.035 : 0, t, 0.08);
      if (h.pan) h.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.05);
    }
    clash(power = 1, pan = 0) {
      if (!this.ctx || !this.enabled) return;
      const ctx = this.ctx, t = this.t;
      const p = Math.min(2.5, power);
      // ノイズバースト
      const n = ctx.createBufferSource(); n.buffer = this.noise;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2500 + Math.random() * 2500; bp.Q.value = 1.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0, t);
      g.gain.linearRampToValueAtTime(0.5 * p, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18 + p * 0.05);
      n.connect(bp).connect(g);
      this._out(g, 0.35);
      n.start(t, Math.random()); n.stop(t + 0.4);
      // 金属的な共鳴（非整数倍音）
      const base = 520 + Math.random() * 300;
      [1, 2.76, 5.4, 8.93].forEach((m, k) => {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = base * m;
        const og = ctx.createGain();
        og.gain.setValueAtTime(0.0, t);
        og.gain.linearRampToValueAtTime(0.12 * p / (k + 1), t + 0.003);
        og.gain.exponentialRampToValueAtTime(0.0005, t + 0.5 + 0.3 / (k + 1));
        o.connect(og); this._out(og, 0.5);
        o.start(t); o.stop(t + 1.0);
      });
      // 低音の衝撃
      if (p > 0.8) {
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
        const og = ctx.createGain();
        og.gain.setValueAtTime(0.35 * Math.min(1, p - 0.5), t);
        og.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        o.connect(og); this._out(og, 0.1);
        o.start(t); o.stop(t + 0.35);
      }
    }
    whoosh(dur = 0.6, up = true, vol = 0.3) {
      if (!this.ctx || !this.enabled) return;
      const ctx = this.ctx, t = this.t;
      const n = ctx.createBufferSource(); n.buffer = this.noise;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2;
      f.frequency.setValueAtTime(up ? 300 : 3000, t);
      f.frequency.exponentialRampToValueAtTime(up ? 4000 : 200, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0, t);
      g.gain.linearRampToValueAtTime(vol, t + dur * 0.3);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      n.connect(f).connect(g); this._out(g, 0.3);
      n.start(t, Math.random()); n.stop(t + dur + 0.05);
    }
    blip(freq = 880, dur = 0.08, type = 'square', vol = 0.08) {
      if (!this.ctx || !this.enabled) return;
      const ctx = this.ctx, t = this.t;
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
      o.connect(g); this._out(g, 0.15);
      o.start(t); o.stop(t + dur + 0.02);
    }
    chord(freqs, dur = 1.2, vol = 0.06, type = 'sawtooth') {
      if (!this.ctx || !this.enabled) return;
      const ctx = this.ctx, t = this.t;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(600, t); lp.frequency.exponentialRampToValueAtTime(5000, t + dur * 0.4);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
      lp.connect(g); this._out(g, 0.6);
      freqs.forEach((f) => {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = (Math.random() - 0.5) * 12;
        o.connect(lp); o.start(t); o.stop(t + dur + 0.05);
      });
    }
    boom(vol = 0.6) {
      if (!this.ctx || !this.enabled) return;
      const ctx = this.ctx, t = this.t;
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(28, t + 1.0);
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
      o.connect(g); this._out(g, 0.4);
      o.start(t); o.stop(t + 1.3);
      this.whoosh(0.9, false, 0.25);
    }
    powerUp() {
      if (!this.ctx || !this.enabled) return;
      const ctx = this.ctx, t = this.t;
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(880, t + 0.7);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 10;
      f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(6000, t + 0.7);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0, t); g.gain.linearRampToValueAtTime(0.15, t + 0.1); g.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
      o.connect(f).connect(g); this._out(g, 0.5);
      o.start(t); o.stop(t + 1.2);
      this.whoosh(0.8, true, 0.3);
    }
  }

  global.Sfx = new Sfx();
})(window);
