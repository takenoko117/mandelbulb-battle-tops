// ============================================================
//  バトル・シミュレーション（物理 / CPU AI / 火花 / カメラ）
// ============================================================
(function (global) {
  'use strict';

  const A_BOWL = 0.03, R_BOWL = 7.0, G = 9.8;
  const TAU = Math.PI * 2;
  // 軸なし（形状物理）モードの係数
  const FC = {
    fric: 0.01,    // 接地摩擦トルク
    air: 0.004,    // 空気抵抗トルク
    steer: 0.0026, // 移動操作による減衰
    acc: 5.2,      // 操舵加速度
    ecc: 100,      // 偏心による揺動
    sweep: 18,     // 刃の掃引による打撃
    clash: 0.4,    // 回転どうしの反発
    e: 0.5,        // 反発係数
    mu0: 0.15, mu1: 0.35, press: 0.5, slip: 8,
    tq: 0.0012,    // 衝突トルク → 回転損失
    react: 0.3,    // 刃で打った側の反作用
    wall: 0.35,
    dash: 2.5,
    launchExp: 0.5,
    gripMass: 0.6,
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
  const floorY = (x, z) => { const r = Math.min(Math.hypot(x, z), R_BOWL); return A_BOWL * r * r; };

  // ---------- 3D helpers ----------
  const V3 = {
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    lerp: (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)],
  };

  // カメラ: pos, target, fov → 行列(列優先: right, up, forward)
  function makeCamera(pos, target, fovDeg, roll = 0) {
    const f = V3.norm(V3.sub(target, pos));
    let r = V3.norm(V3.cross(f, [0, 1, 0]));
    let u = V3.cross(r, f);
    if (roll) {
      const c = Math.cos(roll), s = Math.sin(roll);
      const r2 = V3.add(V3.mul(r, c), V3.mul(u, s));
      const u2 = V3.add(V3.mul(u, c), V3.mul(r, -s));
      r = r2; u = u2;
    }
    return {
      pos: new Float32Array(pos),
      rot: new Float32Array([r[0], r[1], r[2], u[0], u[1], u[2], f[0], f[1], f[2]]),
      focal: 1 / Math.tan((fovDeg * Math.PI / 180) / 2),
      right: r, up: u, fwd: f,
    };
  }

  // コマの姿勢行列（ローカル→ワールド, 列優先）
  function topRotation(spin, tilt, tiltDir) {
    const dx = Math.cos(tiltDir), dz = Math.sin(tiltDir);
    const k = [dz, 0, -dx];
    const c = Math.cos(tilt), s = Math.sin(tilt), t = 1 - c;
    // Rodrigues 行列（行優先で計算）
    const R = [
      [t * k[0] * k[0] + c, t * k[0] * k[1] - s * k[2], t * k[0] * k[2] + s * k[1]],
      [t * k[0] * k[1] + s * k[2], t * k[1] * k[1] + c, t * k[1] * k[2] - s * k[0]],
      [t * k[0] * k[2] - s * k[1], t * k[1] * k[2] + s * k[0], t * k[2] * k[2] + c],
    ];
    const ca = Math.cos(spin), sa = Math.sin(spin);
    const Y = [[ca, 0, sa], [0, 1, 0], [-sa, 0, ca]];
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] = R[i][0] * Y[0][j] + R[i][1] * Y[1][j] + R[i][2] * Y[2][j];
    return new Float32Array([M[0][0], M[1][0], M[2][0], M[0][1], M[1][1], M[2][1], M[0][2], M[1][2], M[2][2]]);
  }

  // 傾いたコマの中心高さ
  function centerHeight(def, tilt) {
    const s = def.shape.scale;
    const tipLen = def.tipLen;
    const rh = 1.12 * s, rv = 1.12 * s * def.shape.squash;
    const ext = Math.sqrt(Math.pow(rh * Math.sin(tilt), 2) + Math.pow(rv * Math.cos(tilt), 2));
    return Math.max(tipLen * Math.cos(tilt), ext * 0.92);
  }

  // 軸なしコマの描画位置：最下点を床に接地させ、重心軸まわりに回す
  // base = 重心直下の床位置。戻り値 pos = 本体中心のワールド座標
  function freePose(ph, rot, base) {
    const sp = ShapePhys.support(ph, rot);
    const com = [base[0], base[1] + sp.h, base[2]];
    const c = ph.com;
    const rc = [rot[0] * c[0] + rot[3] * c[1] + rot[6] * c[2], rot[1] * c[0] + rot[4] * c[1] + rot[7] * c[2], rot[2] * c[0] + rot[5] * c[1] + rot[8] * c[2]];
    return {
      pos: [com[0] - rc[0], com[1] - rc[1], com[2] - rc[2]],
      contact: [com[0] + sp.contact[0], com[1] + sp.contact[1], com[2] + sp.contact[2]],
    };
  }

  // ============================================================
  class Fighter {
    constructor(def, isPlayer, free) {
      this.def = def;
      this.isPlayer = isPlayer;
      this.free = !!free;
      this.vec = TopGen.topToVec(def);
      const st = def.stats;
      this.atkMul = 0.6 + st.ATK / 100 * 0.9;
      this.defMul = 0.6 + st.DEF / 100 * 0.9;
      this.staMul = 1.45 - st.STA / 100 * 0.9;
      this.spdMul = 0.7 + st.SPD / 100 * 0.6;
      this.mass = def.mass;
      this.radius = def.radius * 0.96;
      if (this.free) {
        // 形状を実測した物理量だけで戦う
        const ph = this.ph = ShapePhys.analyze(def);
        this.mass = ph.m;
        this.radius = ph.Rmax;
        this.I = ph.Iyy;
        this.wc = ph.wCrit;
        this.gripN = ph.ratings.grip;
        this.bladeN = ph.ratings.blade;
        // 典型的なコマ（m/I ≈ 3.9）を基準にした回転の失いやすさ
        this.spinCost = (ph.m / ph.Iyy) / 3.9;
        // シューターは一定のエネルギーを与える → 慣性が大きいほど初期回転は遅い（E = ½Iω²）
        this.w0 = clamp(Math.pow(0.24 / ph.Iyy, FC.launchExp), 0.7, 1.45);
        // 床をつかむ接地面は、衝突時に押し出されにくい（実効質量が増える）
        this.kMass = ph.m * (1 + FC.gripMass * this.gripN);
      }
      this.reset();
    }
    reset() {
      this.x = 0; this.z = 0; this.vx = 0; this.vz = 0; this.y = 0; this.vy = 0;
      this.maxSpin = this.free ? 100 * this.w0 : 100; this.spin = this.maxSpin;
      this.angle = Math.random() * TAU;
      this.tilt = 0.03; this.tiltDir = 0; this.wobble = 0;
      this.state = 'hidden';
      this.flash = 0; this.special = 0; this.overdrive = 0; this.dashCD = 0; this.boost = 0;
      this.fallT = 0; this.fallTilt = null;
      this.trail = []; this.trailT = 0;
      this.hitCD = 0;
      this.dashFx = 0;
      this.sinceHit = 99;
    }
    get spinFrac() { return clamp(this.spin / this.maxSpin, 0, 1); }
    get alive() { return this.state === 'spinning' || this.state === 'drop'; }
  }

  // ============================================================
  class Battle {
    constructor(playerDef, cpuDef, hooks, opts) {
      this.free = !!(opts && opts.free);
      this.P = new Fighter(playerDef, true, this.free);
      this.C = new Fighter(cpuDef, false, this.free);
      this.F = [this.P, this.C];
      this.hooks = hooks || {};
      this.score = [0, 0];
      this.round = 0;
      this.time = 0;
      this.timeScale = 1; this.slowT = 0; this.hitStop = 0;
      this.sparks = [];
      this.shock = { x: 0, z: 0, age: 9, str: 0 };
      this.shake = 0;
      this.camAz = -Math.PI / 2; this.camPunch = 0;
      this.cam = { pos: [0, 14, -14], target: [0, 0, 0], fov: 46 };
      this.ai = { t: 0, steer: [0, 0], side: 1, mood: 'attack' };
      this.flash = 0;
      this.state = 'intro';
      this.stateT = 0;
      this.launchGauge = 0; this.launchLocked = -1;
      this.cpuLaunch = 0.7 + Math.random() * 0.28;
      this.result = null;
      // startRound() は呼び出し側で実行（フックが battle を参照できるように）
    }

    startRound() {
      this.round++;
      this.F.forEach((f) => f.reset());
      this.sparks.length = 0;
      this.state = 'launch';
      this.stateT = 0;
      this.launchLocked = -1;
      this.cpuLaunch = 0.68 + Math.random() * 0.3;
      this.result = null;
      this.hooks.onRoundStart && this.hooks.onRoundStart(this.round);
    }

    lockLaunch() {
      if (this.state !== 'launch' || this.launchLocked >= 0) return;
      this.launchLocked = this.launchGauge;
      this.hooks.onLaunchLock && this.hooks.onLaunchLock(this.launchLocked);
      this.state = 'countdown';
      this.stateT = 0;
    }

    _spawn() {
      const cam = makeCamera(this.cam.pos, this.cam.target, this.cam.fov);
      const r = [cam.right[0], cam.right[2]];
      const rl = Math.hypot(r[0], r[1]) || 1; r[0] /= rl; r[1] /= rl;
      const fw = [cam.fwd[0], cam.fwd[2]];
      const fl = Math.hypot(fw[0], fw[1]) || 1; fw[0] /= fl; fw[1] /= fl;
      const setup = (f, side, power) => {
        f.x = r[0] * 3.6 * side; f.z = r[1] * 3.6 * side;
        // 反時計回りの周回速度
        const sp = 2.8 + power * 2.6;
        f.vx = -f.z / 3.6 * sp; f.vz = f.x / 3.6 * sp;
        f.maxSpin = f.free ? 100 * f.w0 : 100;
        f.spin = f.maxSpin * (0.6 + 0.4 * power);
        f.state = 'drop';
        f.y = 4.5; f.vy = -2;
        f.tilt = 0.25; f.tiltDir = Math.random() * TAU;
      };
      const pAcc = 1 - Math.abs(this.launchLocked - 0.92) * 1.6;
      this.playerLaunchPower = clamp(pAcc, 0.35, 1);
      setup(this.P, -1, this.playerLaunchPower);
      setup(this.C, 1, this.cpuLaunch);
    }

    activateSpecial(f) {
      if (this.free || f.special < 100 || f.overdrive > 0 || f.state !== 'spinning') return false;
      f.special = 0;
      f.overdrive = 4.5;
      f.spin = Math.min(f.maxSpin, f.spin + 12);
      this.flash = Math.max(this.flash, 0.35);
      this.slowT = 0.6; this.timeScale = 0.35;
      this.shake = Math.max(this.shake, 0.25);
      for (let i = 0; i < 60; i++) this._spark([f.x, f.y + 0.6, f.z], f.vec.slice(22, 25), 1.5, 6);
      Global.Sfx.powerUp();
      this.hooks.onSpecial && this.hooks.onSpecial(f);
      return true;
    }

    dash(f, dir) {
      if (f.dashCD > 0 || f.state !== 'spinning') return;
      let dx = dir[0], dz = dir[1];
      if (Math.hypot(dx, dz) < 0.2) {
        const o = f === this.P ? this.C : this.P;
        dx = o.x - f.x; dz = o.z - f.z;
      }
      const l = Math.hypot(dx, dz) || 1;
      const imp = f.free ? 6.8 * (0.75 + 0.5 * f.gripN) : 6.8 * f.spdMul * (f.overdrive > 0 ? 1.25 : 1);
      f.vx += dx / l * imp; f.vz += dz / l * imp;
      f.spin -= f.free ? FC.dash * f.spinCost : 2.5;
      f.dashCD = 1.4;
      f.dashFx = 0.35;
      Global.Sfx.whoosh(0.35, true, 0.25);
      for (let i = 0; i < 14; i++) this._spark([f.x, f.y + 0.1, f.z], f.vec.slice(22, 25), 0.6, 2.5);
    }

    _spark(p, col, intensity = 1, speed = 5, hot = true) {
      if (this.sparks.length > 1400) return;
      const u = Math.random() * 2 - 1, a = Math.random() * TAU, s = Math.sqrt(1 - u * u);
      const sp = speed * (0.3 + Math.random());
      this.sparks.push({
        p: p.slice(),
        v: [s * Math.cos(a) * sp, Math.abs(u) * sp * 0.9 + 1.0, s * Math.sin(a) * sp],
        life: 0, max: 0.25 + Math.random() * 0.6,
        col: col.slice(), hot, inten: intensity,
        size: 0.012 + Math.random() * 0.02,
      });
    }

    // ---------------- メイン更新 ----------------
    update(dtReal, input) {
      // スローモーション & ヒットストップ
      if (this.hitStop > 0) { this.hitStop -= dtReal; dtReal *= 0.04; }
      if (this.slowT > 0) { this.slowT -= dtReal; if (this.slowT <= 0) this.timeScale = 1; }
      const dt = Math.min(dtReal, 1 / 20) * this.timeScale;
      this.time += dt;
      this.stateT += dtReal;
      this.flash = Math.max(0, this.flash - dtReal * 3);
      this.shake = Math.max(0, this.shake - dtReal * 1.8);
      this.camPunch = damp(this.camPunch, 0, 4, dtReal);
      this.shock.age += dt;

      switch (this.state) {
        case 'launch':
          this.launchGauge = 0.5 - 0.5 * Math.cos(this.stateT * 3.6);
          if (this.stateT > 6) this.lockLaunch();
          break;
        case 'countdown': {
          const n = Math.floor(this.stateT / 0.6);
          if (n !== this._lastCount) {
            this._lastCount = n;
            if (n < 3) { this.hooks.onCount && this.hooks.onCount(3 - n); Global.Sfx.blip(660, 0.12, 'square', 0.07); }
            else if (n === 3) {
              this.hooks.onCount && this.hooks.onCount(0);
              Global.Sfx.blip(1320, 0.3, 'square', 0.08);
              Global.Sfx.whoosh(0.5, false, 0.35);
              this._spawn();
              this.state = 'battle';
              this.stateT = 0;
              this._lastCount = -1;
            }
          }
          break;
        }
        case 'battle':
        case 'roundEnd':
          break;
      }

      // 物理（サブステップ）
      const sub = 4;
      for (let i = 0; i < sub; i++) this._physics(dt / sub, input);

      // ビジュアル更新
      for (const f of this.F) this._visual(f, dt, dtReal);
      this._updateSparks(dt);
      this._updateCamera(dtReal);

      if (this.state === 'battle') this._checkEnd();
      if (this.state === 'roundEnd' && this.stateT > 3.2) {
        if (this.score[0] >= 2 || this.score[1] >= 2) {
          this.state = 'matchEnd';
          this.stateT = 0;
          this.hooks.onMatchEnd && this.hooks.onMatchEnd(this.score[0] >= 2);
        } else {
          this.startRound();
        }
      }
      // サウンド
      const camR = this._camRight || [1, 0, 0];
      this.F.forEach((f, i) => {
        const pan = (f.x * camR[0] + f.z * camR[2]) / 7;
        Global.Sfx.setHum(i, f.spinFrac, pan, f.state === 'spinning');
      });
    }

    _physics(dt, input) {
      if (this.state !== 'battle' && this.state !== 'roundEnd') return;
      // AI
      this._ai(dt);
      for (const f of this.F) {
        f.hitCD = Math.max(0, f.hitCD - dt);
        f.sinceHit += dt;
        if (f.state === 'drop') {
          f.vy -= G * 1.6 * dt;
          f.y += f.vy * dt;
          f.x += f.vx * dt; f.z += f.vz * dt;
          if (f.y <= 0) {
            f.y = 0; f.state = 'spinning';
            f.wobble = 0.25;
            this._shockAt(f.x, f.z, 0.6);
            for (let i = 0; i < 24; i++) this._spark([f.x, floorY(f.x, f.z) + 0.05, f.z], [1, 0.7, 0.4], 1.0, 4);
            Global.Sfx.clash(0.6);
            this.shake = Math.max(this.shake, 0.18);
          }
          continue;
        }
        if (f.state === 'out') {
          f.vy -= G * dt;
          f.x += f.vx * dt; f.z += f.vz * dt; f.y += f.vy * dt;
          continue;
        }
        if (f.state !== 'spinning' && f.state !== 'falling' && f.state !== 'down') continue;
        const r = Math.hypot(f.x, f.z);
        let ax = -G * 2 * A_BOWL * f.x * 1.1;
        let az = -G * 2 * A_BOWL * f.z * 1.1;
        if (f.state === 'spinning' && f.free) {
          const steer = f.isPlayer ? input.move : this.ai.steer;
          const ph = f.ph, w = Math.max(0, f.spin / 100);
          // 接地面が広いほどグリップが効く（そのぶん摩擦で回転を失う）
          const acc = FC.acc * (0.65 + 0.7 * f.gripN) * (f.isPlayer ? 1 : 0.88);
          ax += steer[0] * acc; az += steer[1] * acc;
          // 接地点が回転軸からずれていると、回転に合わせて振り回される
          if (ph.rhoC > 0.002) {
            const a = f.angle + ph.rhoDir;
            const e = FC.ecc * ph.rhoC * w;
            ax += Math.cos(a) * e; az += Math.sin(a) * e;
          }
          // 回転減衰 = (接地摩擦 + 空気抵抗 + 操舵) / 慣性モーメント
          const sl = Math.hypot(steer[0], steer[1]);
          const tau = FC.fric * ph.m * (0.6 * ph.rp + ph.rhoC + 0.03) + FC.air * w * w * ph.air + FC.steer * sl * ph.m * (0.5 + f.gripN);
          f.spin -= tau / ph.Iyy * 100 * dt;
        } else if (f.state === 'spinning') {
          const steer = f.isPlayer ? input.move : this.ai.steer;
          const acc = 5.2 * f.spdMul * (f.overdrive > 0 ? 1.3 : 1) * (f.isPlayer ? 1 : 0.88);
          ax += steer[0] * acc; az += steer[1] * acc;
          // 回転減衰
          const sp2 = f.vx * f.vx + f.vz * f.vz;
          f.spin -= (1.35 * f.staMul + sp2 * 0.004 + Math.hypot(steer[0], steer[1]) * 0.35) * dt;
        }
        const fric = f.state === 'spinning' ? 0.18 : 2.5;
        f.vx += ax * dt; f.vz += az * dt;
        const k = Math.exp(-fric * dt);
        f.vx *= k; f.vz *= k;
        // 速度の上限（ノックバックは超過可）
        const sp = Math.hypot(f.vx, f.vz);
        const vmax = 6.8;
        if (sp > vmax) { const kk = Math.exp(-2.5 * dt); f.vx *= kk; f.vz *= kk; }
        f.x += f.vx * dt; f.z += f.vz * dt;
        // 外壁
        const lim = R_BOWL - f.radius * 0.55;
        const r2 = Math.hypot(f.x, f.z);
        if (r2 > lim) {
          const nx = f.x / r2, nz = f.z / r2;
          const vr = f.vx * nx + f.vz * nz;
          // リングアウトは強打を受けた直後のみ（自滅しにくく）
          if (vr > 8.0 && f.sinceHit < 0.7 && f.state === 'spinning') {
            f.state = 'out'; f.vy = 4.5;
            f.vx *= 1.1; f.vz *= 1.1;
            this.shake = 0.5;
            Global.Sfx.clash(1.2);
            for (let i = 0; i < 40; i++) this._spark([nx * R_BOWL, A_BOWL * R_BOWL * R_BOWL + 0.2, nz * R_BOWL], [0.5, 0.8, 1.0], 1.5, 6);
            continue;
          }
          f.x = nx * lim; f.z = nz * lim;
          if (vr > 0) {
            f.vx -= nx * vr * 1.55; f.vz -= nz * vr * 1.55;
            if (vr > 2.5 && f.state === 'spinning') {
              f.spin -= vr * (f.free ? FC.wall * f.spinCost : 0.35);
              f.wobble += vr * 0.02;
              for (let i = 0; i < Math.min(12, vr * 2); i++) this._spark([nx * R_BOWL * 0.98, A_BOWL * R_BOWL * R_BOWL, nz * R_BOWL * 0.98], [0.6, 0.85, 1.0], 0.8, 3);
              Global.Sfx.clash(vr * 0.08);
            }
          }
        }
        f.y = 0;
      }
      this._collide(this.P, this.C);
    }

    _collide(a, b) {
      if (this.free) return this._collideFree(a, b);
      const okA = a.state === 'spinning' || a.state === 'falling' || a.state === 'down';
      const okB = b.state === 'spinning' || b.state === 'falling' || b.state === 'down';
      if (!okA || !okB) return;
      const dx = b.x - a.x, dz = b.z - a.z;
      const dist = Math.hypot(dx, dz) || 1e-4;
      const minD = a.radius + b.radius;
      if (dist >= minD) return;
      const nx = dx / dist, nz = dz / dist;
      const ma = a.mass, mb = b.mass;
      const ov = minD - dist;
      a.x -= nx * ov * mb / (ma + mb); a.z -= nz * ov * mb / (ma + mb);
      b.x += nx * ov * ma / (ma + mb); b.z += nz * ov * ma / (ma + mb);
      const vrel = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
      if (a.hitCD > 0 && vrel < 1) return;
      const bothSpin = a.state === 'spinning' && b.state === 'spinning';
      const clash = bothSpin ? 1.2 + (a.spinFrac + b.spinFrac) * 0.9 : 0.4;
      const impact = Math.max(vrel, 0) + clash * 0.8;
      const j = 0.8 * (1.7 * Math.max(vrel, 0) + clash) / (1 / ma + 1 / mb);
      const odA = a.overdrive > 0 ? 1.8 : 1, odB = b.overdrive > 0 ? 1.8 : 1;
      const kA = (b.atkMul * odB) / a.defMul, kB = (a.atkMul * odA) / b.defMul;
      a.vx -= nx * j / ma * kA; a.vz -= nz * j / ma * kA;
      b.vx += nx * j / mb * kB; b.vz += nz * j / mb * kB;
      // 同方向回転どうしの接触による接線方向のはじき
      const tx = -nz, tz = nx;
      const kick = (a.spinFrac + b.spinFrac) * 0.6;
      a.vx -= tx * kick; a.vz -= tz * kick;
      b.vx += tx * kick; b.vz += tz * kick;
      a.hitCD = b.hitCD = 0.12;
      a.sinceHit = b.sinceHit = 0;
      if (!bothSpin) return;
      const dmgA = Math.min(11, (0.3 + 0.032 * impact * impact) * kA);
      const dmgB = Math.min(11, (0.3 + 0.032 * impact * impact) * kB);
      a.spin -= dmgA; b.spin -= dmgB;
      a.special = Math.min(100, a.special + dmgB * 3.2 + dmgA * 1.6);
      b.special = Math.min(100, b.special + dmgA * 3.2 + dmgB * 1.6);
      a.flash = Math.min(1, 0.35 + impact * 0.08); b.flash = a.flash;
      a.wobble += impact * 0.025 * kA; b.wobble += impact * 0.025 * kB;
      if (a.overdrive > 0) a.overdrive = Math.max(0.01, a.overdrive - 1.2);
      if (b.overdrive > 0) b.overdrive = Math.max(0.01, b.overdrive - 1.2);
      // エフェクト
      const cx = a.x + nx * a.radius, cz = a.z + nz * a.radius;
      const cy = floorY(cx, cz) + a.def.tipLen * 0.95;
      const n = Math.min(90, 12 + impact * 9);
      const ca = a.vec.slice(22, 25), cb = b.vec.slice(22, 25);
      const spd = 2.5 + Math.min(impact, 9) * 0.55;
      for (let i = 0; i < n; i++) this._spark([cx, cy, cz], i % 2 ? ca : cb, 1 + Math.min(impact, 9) * 0.12, spd);
      const big = impact > 8 || odA > 1 || odB > 1;
      this.shake = Math.max(this.shake, Math.min(0.6, 0.08 + impact * 0.04));
      if (big) {
        this.hitStop = 0.07;
        this.flash = Math.max(this.flash, 0.18);
        this.camPunch = 1;
        this._shockAt(cx, cz, Math.min(1.5, impact * 0.15));
      }
      Global.Sfx.clash(impact * 0.18, (cx * (this._camRight || [1, 0, 0])[0] + cz * (this._camRight || [1, 0, 0])[2]) / 7);
      this.hooks.onHit && this.hooks.onHit(impact, big);
    }

    // ---- 軸なし：実測した外周プロファイル同士の衝突 ----
    _collideFree(a, b) {
      const live = (f) => f.state === 'spinning' || f.state === 'falling' || f.state === 'down';
      if (!live(a) || !live(b)) return;
      const dx = b.x - a.x, dz = b.z - a.z;
      const dist = Math.hypot(dx, dz) || 1e-4;
      if (dist > a.radius + b.radius) return;
      const nx = dx / dist, nz = dz / dist;
      // 相手方向のローカル方位角 → その向きの外周半径と傾き
      const prof = (f, ux, uz) => {
        const ca = Math.cos(f.angle), sa = Math.sin(f.angle);
        const lx = ca * ux - sa * uz, lz = sa * ux + ca * uz;
        return ShapePhys.radiusAt(f.ph, Math.atan2(lz, lx));
      };
      const pa = prof(a, nx, nz), pb = prof(b, -nx, -nz);
      const minD = pa.r + pb.r;
      if (dist >= minD) return;
      const ma = a.kMass, mb = b.kMass;
      const ov = minD - dist;
      a.x -= nx * ov * mb / (ma + mb); a.z -= nz * ov * mb / (ma + mb);
      b.x += nx * ov * ma / (ma + mb); b.z += nz * ov * ma / (ma + mb);
      const vrel = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
      if (a.hitCD > 0 && vrel < 1) return;
      const wa = a.state === 'spinning' ? Math.max(0, a.spin / 100) : 0;
      const wb = b.state === 'spinning' ? Math.max(0, b.spin / 100) : 0;
      // 刃の前縁（回転方向に半径が増える面）が相手に食い込む度合い
      const edge = (p) => { const t = Math.max(0, -p.dr) / p.r; return Math.min(0.9, t / Math.sqrt(1 + t * t)); };
      const ea = edge(pa), eb = edge(pb);
      const meff = 1 / (1 / ma + 1 / mb);
      const sweep = FC.sweep * (wa * pa.r * ea + wb * pb.r * eb);
      const clash = FC.clash * (wa * pa.r + wb * pb.r);
      const u = Math.max(vrel, 0) + sweep + clash;
      const J = (1 + FC.e) * u * meff;
      const mu = FC.mu0 + FC.mu1 * (a.bladeN + b.bladeN) * 0.5;
      const Jt = Math.min(mu * (J + FC.press * meff), meff * FC.slip * (wa * pa.r + wb * pb.r));
      a.vx -= nx * J / ma; a.vz -= nz * J / ma;
      b.vx += nx * J / mb; b.vz += nz * J / mb;
      const tx = -nz, tz = nx;
      a.vx -= tx * Jt / ma; a.vz -= tz * Jt / ma;
      b.vx += tx * Jt / mb; b.vz += tz * Jt / mb;
      a.hitCD = b.hitCD = 0.12;
      a.sinceHit = b.sinceHit = 0;
      // 摩擦と刃の反作用によるトルク → 回転を失う（慣性モーメントが大きいほど耐える）
      const dwa = FC.tq * pa.r * (Jt + FC.react * J * ea) / a.I;
      const dwb = FC.tq * pb.r * (Jt + FC.react * J * eb) / b.I;
      if (a.state === 'spinning') a.spin -= dwa * 100;
      if (b.state === 'spinning') b.spin -= dwb * 100;
      const impact = u;
      a.flash = Math.min(1, 0.35 + impact * 0.08); b.flash = a.flash;
      a.wobble += J / ma * 0.02; b.wobble += J / mb * 0.02;
      // エフェクト（接触点 = 実際の外周）
      const cx = a.x + nx * pa.r, cz = a.z + nz * pa.r;
      const cy = floorY(cx, cz) + (a.ph.h + b.ph.h) * 0.5;
      const n = Math.min(90, 12 + impact * 9);
      const ca = a.vec.slice(22, 25), cb = b.vec.slice(22, 25);
      const spd = 2.5 + Math.min(impact, 9) * 0.55;
      for (let i = 0; i < n; i++) this._spark([cx, cy, cz], i % 2 ? ca : cb, 1 + Math.min(impact, 9) * 0.12, spd);
      const big = impact > 7.5;
      this.shake = Math.max(this.shake, Math.min(0.6, 0.08 + impact * 0.04));
      if (big) {
        this.hitStop = 0.07;
        this.flash = Math.max(this.flash, 0.18);
        this.camPunch = 1;
        this._shockAt(cx, cz, Math.min(1.5, impact * 0.15));
      }
      const cr = this._camRight || [1, 0, 0];
      Global.Sfx.clash(impact * 0.18, (cx * cr[0] + cz * cr[2]) / 7);
      this.hooks.onHit && this.hooks.onHit(impact, big, { a: dwa * 100, b: dwb * 100 });
    }

    _shockAt(x, z, str) { this.shock = { x, z, age: 0, str }; }

    _ai(dt) {
      const c = this.C, p = this.P;
      if (c.state !== 'spinning') { this.ai.steer = [0, 0]; return; }
      this.ai.t -= dt;
      const px = p.x + p.vx * 0.3, pz = p.z + p.vz * 0.3;
      let dx = px - c.x, dz = pz - c.z;
      const dist = Math.hypot(dx, dz) || 1;
      if (this.ai.t <= 0) {
        this.ai.t = 0.15 + Math.random() * 0.2;
        if (Math.random() < 0.08) this.ai.side *= -1;
        // 軸なしでは「倒れるまでの余裕」（臨界回転との差）で比べる
        const life = (f) => f.free ? f.spin / 100 - f.wc : f.spin / 100;
        const weak = life(c) < life(p) * 0.6 && p.state === 'spinning';
        this.ai.mood = weak && Math.random() < 0.75 ? 'evade' : 'attack';
        if (c.special >= 100 && dist < 5) this.activateSpecial(c);
        if (this.ai.mood === 'attack' && dist < 4.2 && c.dashCD <= 0 && Math.random() < 0.35) {
          this.dash(c, [dx, dz]);
        }
      }
      const ux = dx / dist, uz = dz / dist;
      let sx, sz;
      if (this.ai.mood === 'evade') {
        sx = -uz * this.ai.side - c.x * 0.12;
        sz = ux * this.ai.side - c.z * 0.12;
      } else {
        const off = dist > 2.5 ? 0.45 : 0.1;
        sx = ux - uz * off * this.ai.side;
        sz = uz + ux * off * this.ai.side;
      }
      const r = Math.hypot(c.x, c.z);
      if (r > R_BOWL - 2.0) { sx -= c.x / r * 1.2; sz -= c.z / r * 1.2; }
      const l = Math.hypot(sx, sz) || 1;
      this.ai.steer = [sx / l, sz / l];
    }

    _visual(f, dt, dtReal) {
      f.flash = Math.max(0, f.flash - dtReal * 4);
      f.dashCD = Math.max(0, f.dashCD - dt);
      f.dashFx = Math.max(0, f.dashFx - dt);
      if (f.overdrive > 0) { f.overdrive -= dt; if (f.overdrive <= 0) f.overdrive = 0; }
      f.boost = damp(f.boost, f.overdrive > 0 ? 2 : 0, 6, dt);
      const sf = f.spinFrac;
      if (f.state === 'spinning' && f.free) {
        // ジャイロ安定：臨界回転 ω_c に近づくほど首振りが大きくなり、下回ると倒れる
        const w = Math.max(1e-3, f.spin / 100);
        const near = clamp((f.wc / w - 0.5) / 0.5, 0, 1);
        f.wobble = Math.min(0.5, Math.max(0, f.wobble - dt * 0.25));
        const targetTilt = 0.03 + f.ph.imb * 0.6 + 0.55 * near * near * near + f.wobble;
        f.tilt = damp(f.tilt, targetTilt, 5, dt);
        f.tiltDir += dt * (2.5 + 7 * near);
        f.angle += dt * (2.4 + 6.0 * sf);
        if (w < f.wc) { f.state = 'falling'; f.fallT = 0; }
      } else if (f.state === 'spinning') {
        f.wobble = Math.max(0, f.wobble - dt * 0.25);
        f.wobble = Math.min(f.wobble, 0.5);
        const targetTilt = 0.035 + 0.55 * Math.pow(1 - sf, 4) + f.wobble;
        f.tilt = damp(f.tilt, targetTilt, 5, dt);
        f.tiltDir += dt * (2.5 + 7 * (1 - sf));
        f.angle += dt * (2.4 + 6.0 * sf) * (f.overdrive > 0 ? 1.3 : 1);
        if (f.spin <= 0) { f.state = 'falling'; f.fallT = 0; f.spin = 0; }
      } else if (f.state === 'falling' || f.state === 'down') {
        f.fallT += dt;
        const k = clamp(f.fallT / 0.9, 0, 1);
        const bounce = Math.abs(Math.sin(f.fallT * 9)) * Math.exp(-f.fallT * 4) * 0.15;
        if (f.fallTilt == null) f.fallTilt = f.tilt;
        // 軸なしは横倒しで静止（最下点で接地する）
        f.fallTilt = lerp(f.fallTilt, f.free ? 1.35 : 1.15, 1 - Math.exp(-dt * 5));
        f.tilt = f.fallTilt - bounce;
        f.tiltDir += dt * 4 * (1 - k);
        f.angle += dt * 4 * Math.max(0, 1 - k * 1.5);
        if (k >= 1) f.state = 'down';
      } else if (f.state === 'drop') {
        f.angle += dt * 12;
        f.tilt = damp(f.tilt, 0.05, 3, dt);
      } else if (f.state === 'out') {
        f.angle += dt * 8;
        f.tilt += dt * 1.5;
      }
      // 軌跡
      f.trailT += dt;
      if (f.trailT > 0.05) {
        f.trailT = 0;
        if (f.state === 'spinning') f.trail.push({ x: f.x, z: f.z, t: this.time, s: Math.hypot(f.vx, f.vz) });
        while (f.trail.length > 16) f.trail.shift();
      }
      if (f.state === 'spinning' && f.overdrive > 0 && Math.random() < dt * 40) {
        this._spark([f.x + (Math.random() - 0.5) * 1.6, f.y + Math.random() * 1.3, f.z + (Math.random() - 0.5) * 1.6], f.vec.slice(22, 25), 0.9, 1.0, false);
      }
    }

    _updateSparks(dt) {
      const S = this.sparks;
      for (let i = S.length - 1; i >= 0; i--) {
        const s = S[i];
        s.life += dt;
        if (s.life > s.max) { S[i] = S[S.length - 1]; S.pop(); continue; }
        s.v[1] -= (s.hot ? 9.8 : -1.5) * dt;
        const k = Math.exp(-1.2 * dt);
        s.v[0] *= k; s.v[1] *= k; s.v[2] *= k;
        s.p[0] += s.v[0] * dt; s.p[1] += s.v[1] * dt; s.p[2] += s.v[2] * dt;
        const fy = floorY(s.p[0], s.p[2]);
        if (s.p[1] < fy) { s.p[1] = fy; s.v[1] = Math.abs(s.v[1]) * 0.35; s.v[0] *= 0.7; s.v[2] *= 0.7; }
      }
    }

    _checkEnd() {
      const pDead = this.P.state === 'falling' || this.P.state === 'down' || this.P.state === 'out';
      const cDead = this.C.state === 'falling' || this.C.state === 'down' || this.C.state === 'out';
      if (!pDead && !cDead) return;
      let winner, how;
      if (pDead && cDead) {
        winner = this.P.spin >= this.C.spin ? 0 : 1;
        how = 'DOUBLE KO';
      } else {
        winner = pDead ? 1 : 0;
        const loser = pDead ? this.P : this.C;
        how = loser.state === 'out' ? 'RING OUT' : 'SPIN FINISH';
      }
      this.score[winner]++;
      this.result = { winner, how };
      this.state = 'roundEnd';
      this.stateT = 0;
      this.slowT = 1.4; this.timeScale = 0.3;
      this.flash = 0.25;
      Global.Sfx.boom(0.5);
      this.hooks.onRoundEnd && this.hooks.onRoundEnd(winner, how, this.score.slice());
    }

    _updateCamera(dt) {
      const P = this.P, C = this.C;
      const vis = this.F.filter((f) => f.state !== 'hidden' && !(f.state === 'out' && f.y < -3));
      let tx = 0, tz = 0, sep = 0;
      if (vis.length) {
        vis.forEach((f) => { tx += f.x; tz += f.z; });
        tx /= vis.length; tz /= vis.length;
        if (vis.length === 2) sep = Math.hypot(vis[0].x - vis[1].x, vis[0].z - vis[1].z);
      }
      let dist, el, target;
      if (this.state === 'launch' || this.state === 'countdown') {
        this.camAz += dt * 0.12;
        dist = 13.5; el = 0.72;
        target = [0, 0.3, 0];
      } else if (this.state === 'roundEnd' || this.state === 'matchEnd') {
        const w = this.result ? this.F[this.result.winner] : P;
        this.camAz += dt * 0.25;
        dist = 6.5; el = 0.42;
        target = [w.x * 0.8, floorY(w.x, w.z) + 0.7, w.z * 0.8];
      } else {
        this.camAz += dt * 0.035;
        dist = clamp(7.2 + sep * 0.5, 7.2, 12.5) - this.camPunch * 1.4;
        el = 0.66;
        target = [tx * 0.7, 0.55, tz * 0.7];
      }
      const ct = this.cam.target;
      const k = this.state === 'battle' ? 3 : 1.8;
      for (let i = 0; i < 3; i++) ct[i] = damp(ct[i], target[i], k, dt);
      this._camDist = damp(this._camDist || dist, dist, 2.2, dt);
      this._camEl = damp(this._camEl || el, el, 2.2, dt);
      const asp = this.aspect || 1.6;
      const d = this._camDist * (asp < 1.25 ? Math.pow(1.25 / asp, 0.8) : 1), e = this._camEl;
      const pos = [ct[0] + Math.cos(this.camAz) * Math.cos(e) * d, ct[1] + Math.sin(e) * d, ct[2] + Math.sin(this.camAz) * Math.cos(e) * d];
      const sh = this.shake * this.shake;
      const tt = performance.now() * 0.001;
      pos[0] += Math.sin(tt * 53.1) * sh * 0.5; pos[1] += Math.sin(tt * 61.7) * sh * 0.4; pos[2] += Math.cos(tt * 47.3) * sh * 0.5;
      this.cam.pos = pos;
      this.cam.roll = Math.sin(tt * 39.0) * sh * 0.05;
    }

    // ---------------- レンダリング用データ ----------------
    getCamera() {
      const c = makeCamera(this.cam.pos, this.cam.target, this.cam.fov, this.cam.roll || 0);
      this._camRight = c.right;
      this._camFwd = c.fwd;
      return c;
    }

    renderTops() {
      return this.F.map((f) => {
        const hidden = f.state === 'hidden' || (f.state === 'out' && f.y < -8);
        const fy = f.state === 'out' ? A_BOWL * R_BOWL * R_BOWL : floorY(f.x, f.z);
        const rot = topRotation(f.angle, f.tilt, f.tiltDir);
        let pos, contact = null;
        if (f.free) {
          const fr = freePose(f.ph, rot, [f.x, fy + f.y, f.z]);
          pos = fr.pos; contact = fr.contact;
        } else {
          pos = [f.x, fy + centerHeight(f.def, f.tilt) + f.y, f.z];
        }
        const sf = f.spinFrac;
        const od = f.overdrive > 0 ? 1 : 0;
        return {
          pos, axisless: f.free, contact,
          rot,
          v: f.vec,
          powerBoost: f.boost,
          spinVis: f.state === 'spinning' || f.state === 'drop' ? (2.4 + 6.0 * sf) * (f.overdrive > 0 ? 1.3 : 1) : 0,
          flash: f.flash,
          energy: (f.state === 'spinning' || f.state === 'drop') ? 0.2 + sf * 0.45 + od * 1.4 + f.dashFx * 1.5 : 0.03,
          alive: !hidden,
          aura: (f.state === 'spinning' || f.state === 'drop') ? 0.16 + od * 1.0 + f.dashFx : 0,
          motion: f.state !== 'down',
        };
      });
    }

    trails() {
      const out = new Float32Array(128);
      this.F.forEach((f, k) => {
        const tr = f.trail;
        for (let j = 0; j < 16; j++) {
          const p = tr[j];
          if (!p) continue;
          const age = this.time - p.t;
          const inten = Math.max(0, 1 - age / 0.8) * clamp(p.s / 6, 0.15, 1) * (0.5 + f.spinFrac) * (f.overdrive > 0 ? 2 : 1);
          out.set([p.x, p.z, f.state === 'spinning' ? inten : inten * 0.5, 0], (k * 16 + j) * 4);
        }
      });
      return out;
    }

    particles() {
      const out = [];
      for (const s of this.sparks) {
        const k = 1 - s.life / s.max;
        const hot = s.hot ? Math.max(0, 1 - s.life * 5) : 0;
        const col = [
          (s.col[0] * 0.7 + hot * 1.5 + 0.3) * k * s.inten * 4,
          (s.col[1] * 0.7 + hot * 1.2 + 0.15) * k * s.inten * 4,
          (s.col[2] * 0.7 + hot * 0.8 + 0.05) * k * s.inten * 4,
        ];
        const vl = Math.hypot(s.v[0], s.v[1], s.v[2]) || 1;
        const tl = Math.min(vl * 0.03, 0.22) / vl;
        out.push({ a: s.p, b: [s.p[0] - s.v[0] * tl, s.p[1] - s.v[1] * tl, s.p[2] - s.v[2] * tl], col, size: s.size });
      }
      return out;
    }

    shockUniform() {
      return [this.shock.x, this.shock.z, this.shock.age, this.shock.age < 2 ? this.shock.str : 0];
    }

    // 画面基準の入力 → ワールドXZ
    screenToWorld(ix, iy) {
      const r = this._camRight || [1, 0, 0], f = this._camFwd || [0, 0, 1];
      let rx = r[0], rz = r[2]; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
      let fx = f[0], fz = f[2]; const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
      return [rx * ix + fx * iy, rz * ix + fz * iy];
    }
  }

  const Global = global;
  global.Game = { Battle, Fighter, makeCamera, topRotation, centerHeight, freePose, FC, floorY, A_BOWL, R_BOWL, clamp, lerp, damp };
})(window);
