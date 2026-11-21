// ============================================================
//  名前 → 一意のマンデルバルブ・コマ 生成器
//  同じ名前からは常に同じパラメータが生成される（決定論的）
// ============================================================
(function (global) {
  'use strict';

  // --- 128bit 文字列ハッシュ (cyrb128) : UTF-8 バイト列に対して適用 ---
  function cyrb128(str) {
    const bytes = new TextEncoder().encode(str);
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < bytes.length; i++) {
      const k = bytes[i];
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= (h2 ^ h3 ^ h4); h2 ^= h1; h3 ^= h1; h4 ^= h1;
    return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
  }

  // --- sfc32 PRNG ---
  function sfc32(a, b, c, d) {
    return function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  function hsl2rgb(h, s, l) {
    h = ((h % 1) + 1) % 1;
    const f = (n) => {
      const k = (n + h * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    };
    return [f(0), f(8), f(4)];
  }

  // 素材アーキタイプ（連続パラメータで表現し、モーフィング可能にする）
  const MATERIALS = [
    { key: 'chrome',   jp: 'クローム',       metal: 1.0,  rough: [0.06, 0.16], vein: [0.0, 0.0], irid: [0.15, 0.45], sss: 0.0, coat: 0.0, sat: [0.05, 0.25], val: [0.75, 0.95], sta: 0.55 },
    { key: 'pearl',    jp: 'パール',         metal: 0.12, rough: [0.22, 0.34], vein: [0.0, 0.3], irid: [0.75, 1.0],  sss: 0.7, coat: 0.6, sat: [0.15, 0.35], val: [0.75, 0.92], sta: 0.75 },
    { key: 'obsidian', jp: 'オブシディアン', metal: 0.35, rough: [0.12, 0.25], vein: [2.5, 5.0], irid: [0.0, 0.25],  sss: 0.0, coat: 0.9, sat: [0.3, 0.6],   val: [0.06, 0.14], sta: 0.45 },
    { key: 'gold',     jp: 'ゴールド',       metal: 1.0,  rough: [0.16, 0.32], vein: [0.0, 0.6], irid: [0.0, 0.2],   sss: 0.0, coat: 0.0, sat: [0.45, 0.8],  val: [0.6, 0.85],  sta: 0.6 },
    { key: 'enamel',   jp: 'エナメル',       metal: 0.0,  rough: [0.3, 0.45],  vein: [0.0, 0.4], irid: [0.0, 0.15],  sss: 0.25, coat: 1.0, sat: [0.6, 0.9],  val: [0.45, 0.7],  sta: 0.5 },
    { key: 'plasma',   jp: 'プラズマ',       metal: 0.2,  rough: [0.08, 0.18], vein: [1.2, 2.6], irid: [0.3, 0.6],   sss: 1.0, coat: 0.7, sat: [0.6, 0.95],  val: [0.2, 0.4],   sta: 0.4 },
  ];

  const HUE_WORDS = [
    [0.00, '紅蓮'], [0.05, '緋炎'], [0.10, '琥珀'], [0.14, '黄金'], [0.20, '翠雷'], [0.30, '翡翠'],
    [0.42, '碧海'], [0.50, '氷刃'], [0.58, '蒼穹'], [0.66, '瑠璃'], [0.74, '紫電'], [0.82, '妖華'],
    [0.90, '桜花'], [0.96, '紅蓮'],
  ];
  const NOUNS = ['ヘリオス', 'ネビュラ', 'オーロラ', 'ヴォルテクス', 'ケルベロス', 'フェニックス', 'リヴァイアサン', 'アストラル',
    'ゼニス', 'クェーサー', 'パルサー', 'ミラージュ', 'ガーディアン', 'セラフィム', 'オリオン', 'カリバーン', 'グリフォン',
    'ルミナス', 'エクリプス', 'タイフーン', 'ファントム', 'ノヴァ', 'アビス', 'スパイラル', 'ジェネシス', 'イグニス', 'テンペスト'];
  const GREEK = ['α', 'β', 'γ', 'Δ', 'ε', 'ζ', 'Θ', 'Λ', 'Ξ', 'Π', 'Σ', 'Φ', 'Ψ', 'Ω'];

  function normalizeName(name) {
    return (name || '').normalize('NFKC').trim();
  }

  function genTop(rawName) {
    const name = normalizeName(rawName) || 'MANDELBULB';
    const h = cyrb128('mbtop/v1/' + name);
    const rnd = sfc32(h[0], h[1], h[2], h[3]);
    for (let i = 0; i < 12; i++) rnd();
    const R = (a, b) => a + (b - a) * rnd();
    const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

    // --- 形状 ---
    const power = pick([4, 5, 5, 6, 6, 7, 7, 8, 8, 8, 9, 9, 10]);
    const thetaPhase = rnd() < 0.4 ? 0 : R(-0.55, 0.85);
    const phiPhase = rnd() < 0.5 ? 0 : R(-0.6, 0.6);
    let jAmt = 0, jc = [0, 0, 0];
    if (rnd() < 0.38) {
      // 高い冪 + 大きなジュリア成分は構造が崩れて塊になるので抑制
      jAmt = R(0.05, 0.22) * (power >= 8 ? 0.6 : 1);
      const u = R(-1, 1), a = R(0, Math.PI * 2), s = Math.sqrt(1 - u * u), m = R(0.35, 0.9);
      jc = [s * Math.cos(a) * m, u * m, s * Math.sin(a) * m];
    }
    const squash = R(0.56, 0.84);
    const scale = R(0.84, 0.98);
    const twist = rnd() < 0.42 ? R(-1.0, 1.0) : 0;

    // --- 素材 ---
    const matIdx = Math.floor(rnd() * MATERIALS.length) % MATERIALS.length;
    const M = MATERIALS[matIdx];
    const hue = rnd();
    const sat = R(M.sat[0], M.sat[1]);
    const val = R(M.val[0], M.val[1]);
    let baseHue = hue;
    if (M.key === 'gold') baseHue = R(0.06, 0.14);
    // 金属は F0 が高い（明るい）方がリアル
    const c0 = hsl2rgb(baseHue, sat, M.metal > 0.9 ? val * 0.5 + 0.3 : val * 0.5 + 0.08);
    // コサインパレット a + b cos(2π(c t + d))
    const palA = c0.map((v) => Math.min(1, v * 1.15 + 0.02));
    const spread = R(0.18, 0.48) * (M.key === 'chrome' ? 0.5 : 1);
    const palB = [spread, spread * R(0.7, 1.1), spread * R(0.7, 1.2)].map((v) => v * (M.key === 'obsidian' ? 0.25 : 1));
    const freq = R(0.6, 1.8);
    const palC = [freq, freq * R(0.85, 1.15), freq * R(0.8, 1.25)];
    const palD = [hue, hue + R(0.08, 0.33), hue + R(0.18, 0.66)];

    const glowHue = (M.key === 'obsidian' || M.key === 'plasma') ? (hue + R(0.35, 0.65)) % 1 : (hue + R(-0.08, 0.08) + 1) % 1;
    const glow = hsl2rgb(glowHue, 1.0, 0.55);
    const tint = rnd() < 0.5 ? [0.92, 0.93, 0.95] : (rnd() < 0.5 ? [1.0, 0.78, 0.45] : [0.95, 0.65, 0.55]);

    const mat = {
      metal: M.metal,
      rough: R(M.rough[0], M.rough[1]),
      vein: R(M.vein[0], M.vein[1]),
      irid: R(M.irid[0], M.irid[1]),
      sss: M.sss,
      coat: M.coat,
      trapMix: rnd(),
      veinThr: R(0.025, 0.09),
    };

    // --- ステータス ---
    const atkRaw = 0.35 + ((power - 4) / 8) * 0.7 + jAmt * 1.4 + Math.abs(twist) * 0.25;
    const defRaw = (1 - (squash - 0.56) / 0.28) * 0.55 + ((scale - 0.84) / 0.14) * 0.45 + M.metal * 0.2;
    const staRaw = M.sta + (1 - Math.min(1, Math.abs(thetaPhase))) * 0.35 + (mat.coat * 0.1);
    const spdRaw = 0.95 - ((scale - 0.84) / 0.14) * 0.5 + (1 - M.metal) * 0.2 + Math.abs(phiPhase) * 0.3;
    const raws = [atkRaw, defRaw, staRaw, spdRaw].map((v) => Math.max(0.05, v) + 0.35);
    const sum = raws.reduce((a, b) => a + b, 0);
    const stats = raws.map((v) => Math.max(25, Math.min(96, Math.round((v / sum) * 240))));
    const [ATK, DEF, STA, SPD] = stats;
    const mx = Math.max(...stats), mn = Math.min(...stats);
    let type = 'バランス';
    if (mx - mn >= 12) {
      type = ['アタック', 'ディフェンス', 'スタミナ', 'スピード'][stats.indexOf(mx)];
    }

    // --- コードネーム ---
    let hw = HUE_WORDS[0][1];
    for (const [hv, w] of HUE_WORDS) if (glowHue >= hv) hw = w;
    if (M.key === 'chrome' && sat < 0.15) hw = '白銀';
    if (M.key === 'obsidian') hw = '漆黒';
    const noun = pick(NOUNS);
    const greek = pick(GREEK);
    const codename = `${hw}の${noun} ${greek}${power}`;
    const serial = 'MB-' + h[0].toString(16).toUpperCase().padStart(8, '0').slice(0, 4) + '·' + h[1].toString(16).toUpperCase().padStart(8, '0').slice(0, 4);

    return {
      name,
      codename,
      serial,
      material: M.jp,
      type,
      stats: { ATK, DEF, STA, SPD },
      // --- レンダリング用パラメータ ---
      shape: { power, thetaPhase, phiPhase, squash, scale, twist, jAmt, jc },
      palA, palB, palC, palD,
      glow, tint,
      mat,
      // 物理
      radius: scale * 1.12,
      tipLen: scale * (1.12 * squash + 0.38),
      mass: 0.8 + DEF / 100 * 0.7 + (scale - 0.84) * 2,
    };
  }

  // 補間用の「生パラメータ」ベクトル（モーフィング）
  function topToVec(t) {
    const s = t.shape;
    return [
      s.power, s.thetaPhase, s.phiPhase, s.squash, s.scale, s.twist, s.jAmt, ...s.jc,
      ...t.palA, ...t.palB, ...t.palC, ...t.palD, ...t.glow, ...t.tint,
      t.mat.metal, t.mat.rough, t.mat.vein, t.mat.irid, t.mat.sss, t.mat.coat, t.mat.trapMix, t.mat.veinThr,
    ];
  }

  global.TopGen = { genTop, topToVec, normalizeName, hsl2rgb };
})(window);
