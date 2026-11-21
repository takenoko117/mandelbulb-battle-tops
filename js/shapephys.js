// ============================================================
//  形状 → 物理量 計測器（軸なしモード用）
//  マンデルバルブ本体をボクセル化して、質量・重心・慣性テンソル・
//  接地面・外周プロファイル（刃）などを実測する
// ============================================================
(function (global) {
  'use strict';

  const N = 40;        // ボクセル分解能
  const L = 1.34;      // 解析範囲（本体座標）
  const ITER = 9;      // 脱出判定の反復回数
  const BINS = 72;     // 外周プロファイルの方位分割数
  const MAX_PTS = 900; // 接地計算用の表面点数
  const cache = new Map();

  // 素材の密度（軽いプラズマ〜重いゴールド）
  const DENSITY = { 'クローム': 1.08, 'パール': 0.95, 'オブシディアン': 1.0, 'ゴールド': 1.15, 'エナメル': 0.97, 'プラズマ': 0.9 };

  // 個体差の正規化に使う母集団の分布（calibrate で測定した 10% / 90% 点）
  const RANGE = {
    m: [0.65, 1.28], Iyy: [0.148, 0.358], wCrit: [0.232, 0.385], blade: [0.46, 0.87],
    reach: [0.915, 1.053], grip: [0.092, 0.48], ecc: [0.0, 0.03],
  };

  function makeInside(sh) {
    const n = sh.power, thPh = sh.thetaPhase, phPh = sh.phiPhase, sq = sh.squash, tw = sh.twist, jA = sh.jAmt, jc = sh.jc;
    return function (px, py, pz) {
      // シェーダの topDE と同じ変換（ねじれ → 扁平）
      const a = py * tw, cw = Math.cos(a), sw = Math.sin(a);
      const bx = cw * px - sw * pz, bz = sw * px + cw * pz, by = py / sq;
      const cx = bx + (jc[0] - bx) * jA, cy = by + (jc[1] - by) * jA, cz = bz + (jc[2] - bz) * jA;
      let x = bx, y = by, z = bz;
      let r = Math.sqrt(x * x + y * y + z * z);
      for (let k = 0; k < ITER; k++) {
        if (r > 2) return false;
        const th = Math.acos(Math.max(-1, Math.min(1, y / Math.max(r, 1e-8)))) * n + thPh;
        const ph = Math.atan2(z, x) * n + phPh;
        const rn = Math.pow(r, n);
        const st = Math.sin(th);
        x = rn * st * Math.cos(ph) + cx;
        y = rn * Math.cos(th) + cy;
        z = rn * st * Math.sin(ph) + cz;
        r = Math.sqrt(x * x + y * y + z * z);
      }
      return r <= 2;
    };
  }

  function analyze(def) {
    const key = def.name + '|' + def.serial;
    if (cache.has(key)) return cache.get(key);
    const sh = def.shape, s = sh.scale, sq = sh.squash;
    const inside = makeInside(sh);
    const hx = (2 * L) / N, hy = (2 * L * sq * 1.06) / N;
    const x0 = -L + hx / 2, y0 = -L * sq * 1.06 + hy / 2;
    const vox = new Uint8Array(N * N * N);
    const idx = (i, j, k) => (j * N + k) * N + i;
    let cnt = 0, sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, szz = 0, sxy = 0, syz = 0, sxz = 0;
    let jMin = N;
    for (let j = 0; j < N; j++) {
      const y = y0 + j * hy;
      for (let k = 0; k < N; k++) {
        const z = x0 + k * hx;
        for (let i = 0; i < N; i++) {
          const x = x0 + i * hx;
          if (x * x + z * z > 1.9 * 1.9) continue;
          if (!inside(x, y, z)) continue;
          vox[idx(i, j, k)] = 1;
          cnt++;
          sx += x; sy += y; sz += z;
          sxx += x * x; syy += y * y; szz += z * z;
          sxy += x * y; syz += y * z; sxz += x * z;
          if (j < jMin) jMin = j;
        }
      }
    }
    if (cnt < 8) {
      // 退化形状（ほぼ起きないが保険）
      cnt = 8; sxx = syy = szz = 8 * 0.2; jMin = N >> 1;
    }
    const dv = hx * hx * hy;
    const cx = sx / cnt, cy = sy / cnt, cz = sz / cnt;
    // 重心まわりの慣性テンソル（単位密度・本体座標）
    const Exx = sxx / cnt - cx * cx, Eyy = syy / cnt - cy * cy, Ezz = szz / cnt - cz * cz;
    const Exy = sxy / cnt - cx * cy, Eyz = syz / cnt - cy * cz, Exz = sxz / cnt - cx * cz;
    const vol = cnt * dv;
    // ワールド単位へ（長さ×s, 体積×s³, 慣性×s⁵）
    const s2 = s * s, s3 = s2 * s;
    const rho = DENSITY[def.material] || 1;
    const m = rho * vol * s3 / 1.55;      // 典型的なコマで ~1
    const Iyy = m * (Exx + Ezz) * s2;
    const Ixx = m * (Eyy + Ezz) * s2;
    const Izz = m * (Exx + Eyy) * s2;
    const Ixy = m * Exy * s2, Iyz = m * Eyz * s2;

    // --- 表面点・接地面・外周プロファイル ---
    const prof = new Float32Array(BINS);
    const pts = [];
    let botX = 0, botZ = 0, botN = 0, botXX = 0, botZZ = 0;
    let yTop = -1e9;
    for (let j = 0; j < N; j++) {
      const y = y0 + j * hy;
      for (let k = 0; k < N; k++) {
        const z = x0 + k * hx;
        for (let i = 0; i < N; i++) {
          if (!vox[idx(i, j, k)]) continue;
          const x = x0 + i * hx;
          if (j <= jMin + 1) { botX += x; botZ += z; botXX += x * x; botZZ += z * z; botN++; }
          const surf = i === 0 || i === N - 1 || j === 0 || j === N - 1 || k === 0 || k === N - 1 ||
            !vox[idx(i - 1, j, k)] || !vox[idx(i + 1, j, k)] || !vox[idx(i, j - 1, k)] ||
            !vox[idx(i, j + 1, k)] || !vox[idx(i, j, k - 1)] || !vox[idx(i, j, k + 1)];
          if (!surf) continue;
          if (y > yTop) yTop = y;
          const dx = x - cx, dz = z - cz;
          const r = Math.hypot(dx, dz) + hx * 0.5;
          let b = Math.floor(((Math.atan2(dz, dx) / (Math.PI * 2)) + 1) % 1 * BINS) % BINS;
          if (r > prof[b]) prof[b] = r;
          pts.push(dx, y - cy, dz);
        }
      }
    }
    // 外周プロファイルを放射方向のスキャン＋二分探索で精密に測る（重心軸基準）
    {
      const yLo = y0 + jMin * hy, yHi = yTop;
      const NH = 20;
      for (let b = 0; b < BINS; b++) {
        const ph = (b + 0.5) / BINS * Math.PI * 2, ux = Math.cos(ph), uz = Math.sin(ph);
        let best = prof[b] * 0.5;
        for (let hI = 0; hI < NH; hI++) {
          const y = yLo + (yHi - yLo) * (hI + 0.5) / NH;
          let r = 1.7, found = -1;
          for (; r > best; r -= 0.025) {
            if (inside(cx + ux * r, y, cz + uz * r)) { found = r; break; }
          }
          if (found < 0) continue;
          let lo = found, hi = found + 0.025;
          for (let it = 0; it < 6; it++) {
            const mid = (lo + hi) * 0.5;
            if (inside(cx + ux * mid, y, cz + uz * mid)) lo = mid; else hi = mid;
          }
          best = Math.max(best, lo);
        }
        prof[b] = best;
      }
    }
    let Rmax = 0, Rsum = 0, slope = 0, R4 = 0;
    const dphi = Math.PI * 2 / BINS;
    for (let b = 0; b < BINS; b++) {
      const r = prof[b];
      Rmax = Math.max(Rmax, r); Rsum += r; R4 += r * r * r * r;
      slope += Math.abs(prof[(b + 1) % BINS] - r) / dphi;
    }
    const Rmean = Rsum / BINS;
    const blade = slope / BINS / Rmean;   // ≈ 平均 tanβ（刃の立ち具合）
    // 支配的な倍音 = 刃の枚数
    let lobes = 1, best = 0;
    for (let h = 2; h <= 14; h++) {
      let re = 0, im = 0;
      for (let b = 0; b < BINS; b++) { const a = h * b * dphi; re += (prof[b] - Rmean) * Math.cos(a); im += (prof[b] - Rmean) * Math.sin(a); }
      const mag = Math.hypot(re, im) * (1 + h * 0.02);
      if (mag > best) { best = mag; lobes = h; }
    }

    const yMin = y0 + jMin * hy - hy * 0.5;
    const bxm = botX / botN, bzm = botZ / botN;
    const rp = (Math.sqrt(Math.max(0, botXX / botN - bxm * bxm + botZZ / botN - bzm * bzm)) + hx * 0.35) * s;
    const rhoC = Math.hypot(bxm - cx, bzm - cz) * s;
    const h = (cy - yMin) * s;
    const Iperp = 0.5 * (Ixx + Izz) + m * h * h;   // 接地点まわりの横軸慣性
    // ジャイロ安定の臨界回転 ω_c ∝ sqrt(m h I⊥)/Iyy（正規化単位）
    const wCrit = 0.115 * Math.sqrt(m * h * Iperp) / Iyy;
    // 動的アンバランス（慣性主軸と回転軸のずれ）
    const imb = Math.min(1, Math.hypot(Ixy, Iyz) / Math.max(0.04 * Iyy, Math.abs(Iyy - 0.5 * (Ixx + Izz))));

    // 表面点を間引いて保存（重心基準・ワールド単位）
    const nP = pts.length / 3;
    const stride = Math.max(1, Math.floor(nP / MAX_PTS));
    const P = [];
    for (let q = 0; q < nP; q += stride) P.push(pts[q * 3] * s, pts[q * 3 + 1] * s, pts[q * 3 + 2] * s);
    const profW = prof.map((r) => r * s);

    const res = {
      m, vol: vol * s3, Iyy, Ixx, Izz, Iperp, h, rp, rhoC, imb,
      com: [cx * s, cy * s, cz * s], rhoDir: Math.atan2(bzm - cz, bxm - cx),
      yMin: yMin * s, height: (yTop + hy * 0.5 - yMin) * s,
      Rmax: Rmax * s, Rmean: Rmean * s, blade, lobes, air: (R4 / BINS) * s2 * s2 * (yTop - yMin) * s,
      wCrit,
      prof: profW, pts: new Float32Array(P),
    };
    res.ratings = rate(res);
    cache.set(key, res);
    return res;
  }

  const norm01 = (v, r) => Math.max(0, Math.min(1, (v - r[0]) / (r[1] - r[0])));
  function rate(a) {
    const g = grip(a);
    const R = {
      mass: norm01(a.m, RANGE.m),
      inertia: norm01(a.Iyy, RANGE.Iyy),
      stab: 1 - norm01(a.wCrit, RANGE.wCrit),
      blade: norm01(a.blade, RANGE.blade),
      reach: norm01(a.Rmax, RANGE.reach),
      grip: norm01(g, RANGE.grip),
      ecc: norm01(a.rhoC, RANGE.ecc),
    };
    // タイプ判定（最も突出した特性）
    const cand = [
      ['アタック', R.blade * 0.7 + R.reach * 0.3],
      ['ディフェンス', R.mass * 0.5 + R.inertia * 0.5],
      ['スタミナ', R.stab * 0.6 + (1 - R.grip) * 0.4],
      ['スピード', R.grip * 0.7 + (1 - R.mass) * 0.3],
    ];
    cand.sort((x, y) => y[1] - x[1]);
    R.type = cand[0][1] - cand[1][1] < 0.06 ? 'バランス' : cand[0][0];
    return R;
  }
  function grip(a) { return a.rp + a.rhoC * 0.6; }

  // 方位角（ローカル）での外周半径
  function radiusAt(a, phi) {
    const f = ((phi / (Math.PI * 2)) % 1 + 1) % 1 * BINS;
    const i = Math.floor(f) % BINS, t = f - Math.floor(f);
    const r0 = a.prof[i], r1 = a.prof[(i + 1) % BINS];
    return { r: r0 + (r1 - r0) * t, dr: (r1 - r0) / (Math.PI * 2 / BINS) };
  }

  // 姿勢行列(列優先)での最下点 → 重心の床からの高さと接地点
  function support(a, rot) {
    const p = a.pts;
    let best = 1e9, bi = 0;
    const r1 = rot[1], r4 = rot[4], r7 = rot[7];
    for (let i = 0; i < p.length; i += 3) {
      const y = r1 * p[i] + r4 * p[i + 1] + r7 * p[i + 2];
      if (y < best) { best = y; bi = i; }
    }
    const x = p[bi], y = p[bi + 1], z = p[bi + 2];
    return {
      h: -best,
      contact: [rot[0] * x + rot[3] * y + rot[6] * z, best, rot[2] * x + rot[5] * y + rot[8] * z],
    };
  }

  global.ShapePhys = { analyze, radiusAt, support, grip, RANGE, BINS };
})(typeof window !== 'undefined' ? window : globalThis);
