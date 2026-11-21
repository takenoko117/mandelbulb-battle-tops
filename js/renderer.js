// ============================================================
//  WebGL2 レンダラ
//  scene(HDR + depth) → TAA → [particles] → bloom → composite
// ============================================================
(function (global) {
  'use strict';
  const S = global.Shaders;

  const HALTON = (() => {
    const h = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
    const a = [];
    for (let i = 1; i <= 16; i++) a.push([h(i, 2) - 0.5, h(i, 3) - 0.5]);
    return a;
  })();

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', {
        antialias: false, alpha: false, depth: false, stencil: false,
        powerPreference: 'high-performance', preserveDrawingBuffer: false,
      });
      if (!gl) throw new Error('WebGL2 がサポートされていません');
      this.gl = gl;
      const ext = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
      this.hdr = !!ext;
      this.fmt = ext ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
      this.parallel = gl.getExtension('KHR_parallel_shader_compile');
      this.vao = gl.createVertexArray();
      this.frame = 0;
      this.rw = 0; this.rh = 0;
      this.histIdx = 0;
      this.resetHistory = true;
      this.prevCam = null;
      this.programs = {};
      this.ready = false;
      // GPU 時間計測（動的解像度用）
      this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      this.queries = [];
      this.gpuMs = null;
      this._initParticles();
    }

    // ---------- shader compile (非同期) ----------
    _compileShader(type, src) {
      const gl = this.gl;
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return sh;
    }
    _startProgram(name, vs, fs) {
      const gl = this.gl;
      const v = this._compileShader(gl.VERTEX_SHADER, vs);
      const f = this._compileShader(gl.FRAGMENT_SHADER, fs);
      const p = gl.createProgram();
      gl.attachShader(p, v); gl.attachShader(p, f);
      gl.linkProgram(p);
      this.programs[name] = { prog: p, vs: v, fs: f, locs: {}, vsSrc: vs, fsSrc: fs };
    }
    _checkProgram(name) {
      const gl = this.gl;
      const P = this.programs[name];
      if (!gl.getProgramParameter(P.prog, gl.LINK_STATUS)) {
        const log = (gl.getShaderInfoLog(P.vs) || '') + '\n' + (gl.getShaderInfoLog(P.fs) || '') + '\n' + (gl.getProgramInfoLog(P.prog) || '');
        console.error('[' + name + '] shader error\n' + log);
        throw new Error('シェーダーのコンパイルに失敗しました (' + name + ')\n' + log.slice(0, 600));
      }
    }
    compileAll() {
      this._startProgram('scene', S.FULLSCREEN_VS, S.SCENE_FS);
      this._startProgram('taa', S.FULLSCREEN_VS, S.TAA_FS);
      this._startProgram('bright', S.FULLSCREEN_VS, S.BRIGHT_FS);
      this._startProgram('down', S.FULLSCREEN_VS, S.DOWN_FS);
      this._startProgram('up', S.FULLSCREEN_VS, S.UP_FS);
      this._startProgram('composite', S.FULLSCREEN_VS, S.COMPOSITE_FS);
      this._startProgram('part', S.PART_VS, S.PART_FS);
      const gl = this.gl;
      return new Promise((resolve, reject) => {
        const check = () => {
          try {
            if (this.parallel) {
              for (const k in this.programs) {
                if (!gl.getProgramParameter(this.programs[k].prog, this.parallel.COMPLETION_STATUS_KHR)) {
                  setTimeout(check, 30);
                  return;
                }
              }
            }
            for (const k in this.programs) this._checkProgram(k);
            this.ready = true;
            resolve();
          } catch (e) { reject(e); }
        };
        setTimeout(check, 30);
      });
    }

    _use(name) {
      const P = this.programs[name];
      this.gl.useProgram(P.prog);
      this.cur = P;
      return P;
    }
    _loc(n) {
      const P = this.cur;
      if (!(n in P.locs)) P.locs[n] = this.gl.getUniformLocation(P.prog, n);
      return P.locs[n];
    }
    u1i(n, v) { const l = this._loc(n); if (l) this.gl.uniform1i(l, v); }
    u1f(n, v) { const l = this._loc(n); if (l) this.gl.uniform1f(l, v); }
    u2f(n, a, b) { const l = this._loc(n); if (l) this.gl.uniform2f(l, a, b); }
    u3fv(n, v) { const l = this._loc(n); if (l) this.gl.uniform3fv(l, v); }
    u4fv(n, v) { const l = this._loc(n); if (l) this.gl.uniform4fv(l, v); }
    um3(n, v) { const l = this._loc(n); if (l) this.gl.uniformMatrix3fv(l, false, v); }

    // ---------- render targets ----------
    _makeTarget(w, h) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, this.fmt.internal, w, h, 0, this.fmt.format, this.fmt.type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex, fb, w, h };
    }
    _freeTarget(t) {
      if (!t) return;
      this.gl.deleteTexture(t.tex);
      this.gl.deleteFramebuffer(t.fb);
    }
    _ensureTargets(rw, rh) {
      if (rw === this.rw && rh === this.rh) return;
      this.rw = rw; this.rh = rh;
      [this.tScene, this.tPart, ...(this.tHist || []), ...(this.tBloom || [])].forEach((t) => this._freeTarget(t));
      this.tScene = this._makeTarget(rw, rh);
      this.tPart = this._makeTarget(rw, rh);
      this.tHist = [this._makeTarget(rw, rh), this._makeTarget(rw, rh)];
      this.tBloom = [];
      let w = Math.max(1, rw >> 1), h = Math.max(1, rh >> 1);
      for (let i = 0; i < 6; i++) {
        this.tBloom.push(this._makeTarget(w, h));
        w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
      }
      this.resetHistory = true;
    }

    // ---------- particles ----------
    _initParticles() {
      const gl = this.gl;
      this.maxParts = 1500;
      this.partVao = gl.createVertexArray();
      this.partBuf = gl.createBuffer();
      this.partData = new Float32Array(this.maxParts * 4 * 12);
      gl.bindVertexArray(this.partVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.partBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.partData.byteLength, gl.DYNAMIC_DRAW);
      const stride = 12 * 4;
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 32);
      const idx = new Uint16Array(this.maxParts * 6);
      for (let i = 0; i < this.maxParts; i++) {
        const b = i * 4;
        idx.set([b, b + 1, b + 2, b + 2, b + 1, b + 3], i * 6);
      }
      this.partIdx = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.partIdx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
    }
    _uploadParticles(parts) {
      const n = Math.min(parts.length, this.maxParts);
      const D = this.partData;
      const corners = [[0, -1], [0, 1], [1, -1], [1, 1]];
      let o = 0;
      for (let i = 0; i < n; i++) {
        const p = parts[i];
        for (let c = 0; c < 4; c++) {
          D[o++] = p.a[0]; D[o++] = p.a[1]; D[o++] = p.a[2];
          D[o++] = p.b[0]; D[o++] = p.b[1]; D[o++] = p.b[2];
          D[o++] = corners[c][0]; D[o++] = corners[c][1];
          D[o++] = p.col[0]; D[o++] = p.col[1]; D[o++] = p.col[2]; D[o++] = p.size;
        }
      }
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.partBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, D, 0, o);
      return n;
    }

    _drawFS(target) {
      const gl = this.gl;
      if (target) { gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb); gl.viewport(0, 0, target.w, target.h); }
      else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.canvas.width, this.canvas.height); }
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    _tex(unit, tex, name) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      this.u1i(name, unit);
    }

    // ---------- main render ----------
    _pollTimers() {
      const gl = this.gl, ext = this.timerExt;
      while (this.queries.length) {
        const q = this.queries[0];
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
        if (!disjoint) {
          const ms = ns / 1e6;
          this.gpuMs = this.gpuMs == null ? ms : this.gpuMs * 0.85 + ms * 0.15;
        }
        gl.deleteQuery(q);
        this.queries.shift();
      }
    }

    render(F) {
      const gl = this.gl;
      let q = null;
      if (this.timerExt) {
        this._pollTimers();
        if (this.queries.length < 4) {
          q = gl.createQuery();
          gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, q);
        }
      }
      this._render(F);
      if (q) {
        gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
        this.queries.push(q);
      }
    }

    _render(F) {
      const gl = this.gl;
      const rw = Math.max(16, Math.round(this.canvas.width * F.scale));
      const rh = Math.max(16, Math.round(this.canvas.height * F.scale));
      this._ensureTargets(rw, rh);
      this.frame++;
      const jit = HALTON[this.frame % HALTON.length];
      const Q = F.quality;
      gl.disable(gl.BLEND);

      // ===== 1. SCENE =====
      this._use('scene');
      this.u2f('uRes', rw, rh);
      this.u1f('uTime', F.time);
      this.u1i('uFrame', this.frame);
      this.u3fv('uCamPos', F.cam.pos);
      this.um3('uCamRot', F.cam.rot);
      this.u1f('uFocal', F.cam.focal);
      this.u2f('uJitter', jit[0], jit[1]);
      this.u1i('uMode', F.mode);
      this.u1i('uIter', Q.iter);
      this.u1i('uSteps', Q.steps);
      this.u1i('uShadowSteps', Q.shadowSteps);
      this.u1i('uReflSteps', Q.reflSteps);
      this.u1f('uFloorY', F.floorY || 0);
      this.u3fv('uKeyDir', F.keyDir);
      this.u3fv('uKeyCol', F.keyCol);
      this.u1f('uArenaGlow', F.arenaGlow == null ? 1 : F.arenaGlow);
      const tops = F.tops;
      this.u1i('uTopCount', tops.length);
      const pack = (fn, n) => { const a = new Float32Array(2 * n); tops.forEach((t, i) => a.set(fn(t), i * n)); return a; };
      this.u3fv('uTPos', pack((t) => t.pos, 3));
      this.um3('uTRot', pack((t) => t.rot, 9));
      this.u4fv('uTShape', pack((t) => [t.v[0] + (t.powerBoost || 0), t.v[1], t.v[3], t.v[4]], 4));
      this.u4fv('uTJulia', pack((t) => [t.v[7], t.v[8], t.v[9], t.v[6]], 4));
      this.u4fv('uTDyn', pack((t) => [t.v[2], t.spinVis, t.flash, t.energy], 4));
      this.u4fv('uTMatA', pack((t) => [t.v[28], t.v[29], t.v[30], t.v[31]], 4));
      this.u4fv('uTMatB', pack((t) => [t.v[32], t.v[33], t.v[34], t.v[35]], 4));
      this.u4fv('uTMisc', pack((t) => [t.v[5], t.alive ? 1 : 0, t.aura, t.motion ? 1 : 0], 4));
      this.u3fv('uTPalA', pack((t) => t.v.slice(10, 13), 3));
      this.u3fv('uTPalB', pack((t) => t.v.slice(13, 16), 3));
      this.u3fv('uTPalC', pack((t) => t.v.slice(16, 19), 3));
      this.u3fv('uTPalD', pack((t) => t.v.slice(19, 22), 3));
      this.u3fv('uTGlow', pack((t) => t.v.slice(22, 25), 3));
      this.u3fv('uTTint', pack((t) => t.v.slice(25, 28), 3));
      this.u4fv('uTCont', pack((t) => t.axisless && t.contact ? [t.contact[0], t.contact[1], t.contact[2], 1] : [0, 0, 0, 0], 4));
      this.u4fv('uTrail', F.trails || new Float32Array(128));
      this.u4fv('uShock', F.shock || [0, 0, 0, 0]);
      this._drawFS(this.tScene);

      // ===== 2. TAA =====
      const prev = this.prevCam || F.cam;
      const hSrc = this.tHist[this.histIdx];
      const hDst = this.tHist[1 - this.histIdx];
      this._use('taa');
      this._tex(0, this.tScene.tex, 'uCur');
      this._tex(1, hSrc.tex, 'uHist');
      this.u2f('uRes', rw, rh);
      this.um3('uCamRot', F.cam.rot); this.u3fv('uCamPos', F.cam.pos); this.u1f('uFocal', F.cam.focal);
      this.um3('uPrevCamRot', prev.rot); this.u3fv('uPrevCamPos', prev.pos);
      this.u1f('uReset', (this.resetHistory || F.reset) ? 1 : 0);
      this.u1f('uStaticW', F.staticW || 0.1);
      this.u1f('uDynW', F.dynW || 0.3);
      const curRot = pack((t) => t.rot, 9), curPos = pack((t) => t.pos, 3);
      const prevT = (this.prevTops && this.prevTops.n === tops.length) ? this.prevTops : { rot: curRot, pos: curPos };
      this.um3('uTRot', curRot); this.u3fv('uTPos', curPos);
      this.um3('uPRot', prevT.rot); this.u3fv('uPPos', prevT.pos);
      this.prevTops = { rot: curRot, pos: curPos, n: tops.length };
      this._drawFS(hDst);
      this.histIdx = 1 - this.histIdx;
      this.resetHistory = false;
      this.prevCam = { rot: F.cam.rot.slice(), pos: F.cam.pos.slice(), focal: F.cam.focal };

      // ===== 3. PARTICLES =====
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.tPart.fb);
      gl.viewport(0, 0, rw, rh);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (F.particles && F.particles.length) {
        const n = this._uploadParticles(F.particles);
        this._use('part');
        this.um3('uCamRot', F.cam.rot); this.u3fv('uCamPos', F.cam.pos); this.u1f('uFocal', F.cam.focal);
        this.u2f('uRes', rw, rh);
        this._tex(0, this.tScene.tex, 'uDepth');
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.bindVertexArray(this.partVao);
        gl.drawElements(gl.TRIANGLES, n * 6, gl.UNSIGNED_SHORT, 0);
        gl.disable(gl.BLEND);
        gl.bindVertexArray(null);
      }

      // ===== 4. BLOOM =====
      this._use('bright');
      this._tex(0, hDst.tex, 'uSrc');
      this._tex(1, this.tPart.tex, 'uPart');
      this.u2f('uTexel', 1 / rw, 1 / rh);
      this.u1f('uThreshold', F.bloomThreshold || 1.0);
      this._drawFS(this.tBloom[0]);
      this._use('down');
      for (let i = 1; i < this.tBloom.length; i++) {
        const src = this.tBloom[i - 1];
        this._tex(0, src.tex, 'uSrc');
        this.u2f('uTexel', 1 / src.w, 1 / src.h);
        this._drawFS(this.tBloom[i]);
      }
      this._use('up');
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = this.tBloom.length - 1; i > 0; i--) {
        const src = this.tBloom[i], dst = this.tBloom[i - 1];
        this._tex(0, src.tex, 'uSrc');
        this.u2f('uTexel', 1 / src.w, 1 / src.h);
        this.u2f('uDstSize', dst.w, dst.h);
        this.u1f('uWeight', 1.0);
        this._drawFS(dst);
      }
      gl.disable(gl.BLEND);

      // ===== 5. COMPOSITE =====
      this._use('composite');
      this._tex(0, hDst.tex, 'uHdr');
      this._tex(1, this.tPart.tex, 'uPart');
      this._tex(2, this.tBloom[0].tex, 'uBloom');
      this.u2f('uOutRes', this.canvas.width, this.canvas.height);
      this.u2f('uSrcTexel', 1 / rw, 1 / rh);
      this.u1f('uExposure', F.exposure || 1.0);
      this.u1f('uBloomStr', F.bloomStr == null ? 0.06 : F.bloomStr);
      this.u1f('uTime', F.time);
      this.u1f('uCA', F.ca == null ? 0.012 : F.ca);
      this.u1f('uFlash', F.flash || 0);
      this.u1f('uVignette', F.vignette == null ? 0.85 : F.vignette);
      this.u1f('uSharpen', F.sharpen == null ? 0.35 : F.sharpen);
      this.u1f('uSat', F.saturation == null ? 1.08 : F.saturation);
      this._drawFS(null);
    }
  }

  global.Renderer = Renderer;
})(window);
