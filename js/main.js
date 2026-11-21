// ============================================================
//  アプリ本体：画面遷移 / 入力 / メインループ
// ============================================================
(function () {
  'use strict';
  const { Battle, makeCamera, topRotation, freePose, clamp, lerp, damp } = Game;
  const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  const $ = (id) => document.getElementById(id);

  const QUALITY = {
    low:    { iter: 7,  steps: 110, shadowSteps: 24, reflSteps: 40, maxScale: 0.6, dpr: 1.0 },
    medium: { iter: 8,  steps: 150, shadowSteps: 36, reflSteps: 56, maxScale: 0.8, dpr: 1.25 },
    high:   { iter: 9,  steps: 200, shadowSteps: 48, reflSteps: 72, maxScale: 1.0, dpr: 1.5 },
    ultra:  { iter: 11, steps: 280, shadowSteps: 80, reflSteps: 100, maxScale: 1.0, dpr: 2.0 },
  };
  const CPU_NAMES = ['ネメシス', 'オメガ', 'ヴォイド', 'アルカナ', 'ゼノン', 'カリギュラ', 'ルミナス', 'ケイオス', 'セレーネ',
    'QUASAR', 'PHANTOM', 'KRONOS', 'ABYSS-07', 'ヤタガラス', 'スサノオ', 'ミカヅチ', 'LEVIATHAN', 'ZERO', 'ヘカトンケイル', 'ARGENT'];

  const canvas = $('gl');
  let R;
  const state = {
    app: 'loading',
    quality: 'auto',
    scale: 0.75,
    ema: 16.7,
    scaleT: 0,
    time: 0,
    photo: false, photoFrames: 0,
    free: false,          // true = 軸なし（形状物理）モード
    playerName: '',
    playerDef: null, cpuDef: null,
    battle: null,
    cam: { az: -Math.PI / 2 + 0.5, el: 0.22, dist: 5.2, drag: null, autoT: 0 },
    flash: 0,
  };

  // ---------- ディスプレイ用コマ（モーフィング） ----------
  function makeDisp(def) {
    const v = TopGen.topToVec(def);
    return { def, vec: v.slice(), target: v, angle: Math.random() * 6, tilt: 0.04, tiltDir: 0, flash: 0, energy: 0.35, fpos: null };
  }
  // 軸なし表示：最下点で接地させる（形状モーフィング中は位置もなめらかに追従）
  function dispFreePose(d, base, dt) {
    const rot = topRotation(d.angle, d.tilt, d.tiltDir);
    const fp = freePose(ShapePhys.analyze(d.def), rot, base);
    if (!d.fpos) d.fpos = fp.pos.slice();
    for (let i = 0; i < 3; i++) d.fpos[i] = damp(d.fpos[i], fp.pos[i], 9, dt);
    return { pos: d.fpos.slice(), contact: fp.contact };
  }
  function centerHeightV(v, tilt) {
    const s = v[4], sq = v[3];
    const tipLen = s * (1.12 * sq + 0.38);
    const rh = 1.12 * s, rv = 1.12 * s * sq;
    const ext = Math.sqrt(Math.pow(rh * Math.sin(tilt), 2) + Math.pow(rv * Math.cos(tilt), 2));
    return Math.max(tipLen * Math.cos(tilt), ext * 0.92);
  }
  function updateDisp(d, dt, spinRate) {
    for (let i = 0; i < d.vec.length; i++) d.vec[i] = damp(d.vec[i], d.target[i], 5.5, dt);
    // 冪は素早く整数へスナップ（非整数冪の継ぎ目を最小化）
    if (Math.abs(d.vec[0] - d.target[0]) < 0.02) d.vec[0] = d.target[0];
    if (!state.photo) {
      d.angle += dt * spinRate;
      d.tiltDir += dt * 1.3;
    }
    d.flash = Math.max(0, d.flash - dt * 2.5);
  }
  function dispRender(d, pos, spinRate, contact) {
    return {
      pos, axisless: !!contact, contact, rot: topRotation(d.angle, d.tilt, d.tiltDir), v: d.vec, powerBoost: 0,
      spinVis: state.photo ? 0 : spinRate, flash: d.flash, energy: d.energy + d.flash * 0.8,
      alive: true, aura: 0.3, motion: !state.photo,
    };
  }

  let titleDisp = null, vsDisp = [null, null];

  // ---------- カード UI ----------
  function fmt(v) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2); }
  function recordOf(def) {
    const r = records[(state.free ? 'F|' : 'A|') + def.name];
    return r ? `<span class="tag rec">戦績 ${r[0]}勝 ${r[1]}敗</span>` : '';
  }
  function cardHTML(def, side) {
    const s = def.stats, sh = def.shape;
    const bar = (label, v, cls) => `<div class="stat"><span class="sl">${label}</span><div class="sb"><div class="sf ${cls}" style="width:${v}%"></div></div><span class="sv">${v}</span></div>`;
    const glow = def.glow.map((c) => Math.round(Math.min(1, c) * 255)).join(',');
    const params = [`θ${fmt(sh.thetaPhase)}`, `φ${fmt(sh.phiPhase)}`];
    if (sh.jAmt > 0) params.push(`J ${sh.jAmt.toFixed(2)}`);
    if (sh.twist !== 0) params.push(`twist ${fmt(sh.twist)}`);
    return `
      <div class="cardHead" style="--g: rgb(${glow})">
        <div class="cname">${escapeHTML(def.codename)}</div>
        <div class="owner">${side === 'cpu' ? 'CPU · ' : ''}${escapeHTML(def.name)}</div>
      </div>
      <div class="tags"><span class="tag type">${def.type}</span><span class="tag">${def.material}</span><span class="tag serial">${def.serial}</span></div>
      <div class="formula">z ← z<sup>${sh.power}</sup> + c <span>${params.join(' · ')}</span></div>
      ${bar('ATK', s.ATK, 'atk')}${bar('DEF', s.DEF, 'def')}${bar('STA', s.STA, 'sta')}${bar('SPD', s.SPD, 'spd')}
    `;
  }
  // 軸なしモード：形状を実測した物理量を表示
  function cardHTMLFree(def, side) {
    const sh = def.shape, a = ShapePhys.analyze(def), R = a.ratings;
    const glow = def.glow.map((c) => Math.round(Math.min(1, c) * 255)).join(',');
    const bar = (label, jp, v, val, cls) => `<div class="stat free"><span class="sl">${label}<i>${jp}</i></span><div class="sb"><div class="sf ${cls}" style="width:${Math.max(4, Math.round(v * 100))}%"></div></div><span class="sv">${val}</span></div>`;
    return `
      <div class="cardHead" style="--g: rgb(${glow})">
        <div class="cname">${escapeHTML(def.codename)}</div>
        <div class="owner">${side === 'cpu' ? 'CPU · ' : ''}${escapeHTML(def.name)}</div>
      </div>
      <div class="tags"><span class="tag type">${R.type}</span><span class="tag">${def.material}</span><span class="tag">刃 ×${a.lobes}</span>${recordOf(def)}</div>
      <div class="formula">z ← z<sup>${sh.power}</sup> + c <span>実測 · 軸なし</span></div>
      ${bar('MASS', '質量', R.mass, a.m.toFixed(2), 'def')}
      ${bar('INER', '慣性', R.inertia, a.Iyy.toFixed(3), 'sta')}
      ${bar('STAB', '安定', R.stab, 'ωc ' + Math.round(a.wCrit * 100), 'sta2')}
      ${bar('BLADE', '刃', R.blade, a.blade.toFixed(2), 'atk')}
      ${bar('GRIP', '接地', R.grip, a.rp.toFixed(2), 'spd')}
      ${bar('REACH', '間合', R.reach, a.Rmax.toFixed(2), 'atk2')}
    `;
  }
  function card(def, side) { return state.free ? cardHTMLFree(def, side) : cardHTML(def, side); }

  // ---------- 戦績（名前ごと・モードごと） ----------
  let records = {};
  try { records = JSON.parse(localStorage.getItem('mbrec') || '{}') || {}; } catch (_) { records = {}; }
  function addRecord(def, won) {
    const k = (state.free ? 'F|' : 'A|') + def.name;
    const r = records[k] || [0, 0];
    r[won ? 0 : 1]++;
    records[k] = r;
    try { localStorage.setItem('mbrec', JSON.stringify(records)); } catch (_) {}
  }
  function escapeHTML(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- 画面遷移 ----------
  function show(id) {
    ['title', 'vs', 'hud', 'result'].forEach((s) => $(s).classList.toggle('active', s === id));
  }

  function gotoTitle() {
    state.app = 'title';
    state.battle = null;
    show('title');
    state.cam.dist = 5.2; state.cam.el = 0.2;
    R && (R.resetHistory = true);
    // スマホでは自動フォーカスしない（キーボードで画面が隠れるため）
    if (!IS_TOUCH) setTimeout(() => $('nameInput').focus(), 50);
    for (let i = 0; i < 2; i++) Sfx.setHum(i, 0, 0, false);
  }

  function pickCpu() {
    const opts = CPU_NAMES.filter((n) => TopGen.normalizeName(n) !== state.playerDef.name);
    let name = opts[Math.floor(Math.random() * opts.length)];
    if (state.cpuDef && name === state.cpuDef.name) name = opts[(opts.indexOf(name) + 1) % opts.length];
    state.cpuDef = TopGen.genTop(name);
  }

  function gotoVS(newCpu) {
    if (newCpu || !state.cpuDef) pickCpu();
    state.app = 'vs';
    show('vs');
    $('vsP').innerHTML = card(state.playerDef, 'player');
    $('vsC').innerHTML = card(state.cpuDef, 'cpu');
    vsDisp = [makeDisp(state.playerDef), makeDisp(state.cpuDef)];
    vsDisp[1].flash = 1;
    state.cam.dist = 6.4; state.cam.el = 0.2; state.cam.az = -Math.PI / 2;
    R.resetHistory = true;
    Sfx.whoosh(0.6, true, 0.3);
    Sfx.chord([220, 277, 330], 1.0, 0.04);
  }

  function gotoBattle() {
    state.app = 'battle';
    show('hud');
    $('result').classList.remove('active');
    R.resetHistory = true;
    state.battle = new Battle(state.playerDef, state.cpuDef, battleHooks, { free: state.free });
    setupHud();
    state.battle.startRound();
  }

  // ---------- HUD ----------
  function setupHud() {
    const b = state.battle;
    const g = (f) => f.def.glow.map((c) => Math.round(Math.min(1, c) * 255)).join(',');
    $('hudPName').textContent = b.P.def.name;
    $('hudPCode').textContent = b.P.def.codename;
    $('hudCName').textContent = 'CPU · ' + b.C.def.name;
    $('hudCCode').textContent = b.C.def.codename;
    $('hudP').style.setProperty('--g', `rgb(${g(b.P)})`);
    $('hudC').style.setProperty('--g', `rgb(${g(b.C)})`);
    $('hud').classList.toggle('free', b.free);
    // 軸なし：臨界回転（これを下回ると倒れる）をゲージに表示
    const crit = (f) => b.free ? clamp(f.wc / f.w0, 0, 1) * 100 : 0;
    $('critP').style.left = crit(b.P).toFixed(1) + '%';
    $('critC').style.right = crit(b.C).toFixed(1) + '%';
    updatePips();
  }
  function updatePips() {
    const b = state.battle;
    const pip = (n) => [0, 1].map((i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
    $('pipsP').innerHTML = pip(b.score[0]);
    $('pipsC').innerHTML = pip(b.score[1]);
    $('roundNo').textContent = 'ROUND ' + b.round;
  }
  let msgTimer = 0;
  function bigMsg(text, cls = '', dur = 1.2, sub = '') {
    const el = $('bigMsg');
    el.className = '';
    void el.offsetWidth;
    el.innerHTML = `<div class="m">${text}</div>${sub ? `<div class="s">${sub}</div>` : ''}`;
    el.className = 'show ' + cls;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { el.className = 'hide ' + cls; }, dur * 1000);
  }
  const battleHooks = {
    onRoundStart(n) {
      updatePips();
      bigMsg('ROUND ' + n, 'round', 1.4, 'タイミングよくシュート！');
      $('launchUI').classList.add('active');
      $('lockText').textContent = '';
    },
    onLaunchLock(g) {
      const acc = 1 - Math.abs(g - 0.92) * 1.6;
      const t = acc > 0.9 ? 'PERFECT!' : acc > 0.7 ? 'GREAT' : acc > 0.5 ? 'GOOD' : 'WEAK…';
      $('lockText').textContent = t;
      $('lockText').className = acc > 0.9 ? 'perfect' : '';
      Sfx.blip(acc > 0.9 ? 1760 : 990, 0.15, 'triangle', 0.1);
      setTimeout(() => $('launchUI').classList.remove('active'), 700);
    },
    onCount(n) {
      if (n > 0) bigMsg(String(n), 'count', 0.5);
      else bigMsg('GO SHOOT!', 'go', 0.9);
    },
    onHit(impact, big) {
      if (big) bigMsg('CRITICAL!', 'crit', 0.5);
      buzz(big ? 45 : Math.min(25, 6 + impact * 2));
    },
    onSpecial(f) {
      bigMsg('BULB OVERDRIVE', f.isPlayer ? 'od' : 'od cpu', 1.0, f.isPlayer ? 'フラクタル冪 +2 / 攻撃力 ×1.8' : 'CPU の必殺技！');
    },
    onRoundEnd(winner, how, score) {
      updatePips();
      buzz(winner === 0 ? [30, 60, 30] : 120);
      bigMsg(how, winner === 0 ? 'win' : 'lose', 2.6, winner === 0 ? 'あなたのラウンド！' : 'CPU のラウンド');
      if (winner === 0) Sfx.chord([523, 659, 784], 1.4, 0.05); else Sfx.chord([196, 233, 294], 1.4, 0.05);
    },
    onMatchEnd(playerWon) {
      setTimeout(() => {
        if (state.app !== 'battle') return;
        const res = $('result');
        clearTimeout(msgTimer);
        $('bigMsg').className = '';
        $('launchUI').classList.remove('active');
        res.classList.add('active');
        $('resTitle').textContent = playerWon ? 'VICTORY' : 'DEFEAT';
        $('resTitle').className = playerWon ? 'win' : 'lose';
        const b = state.battle;
        addRecord(b.P.def, playerWon);
        addRecord(b.C.def, !playerWon);
        const rec = records[(state.free ? 'F|' : 'A|') + b.P.def.name];
        $('resRec').textContent = `${b.P.def.name} の${state.free ? '軸なし' : ''}戦績：${rec[0]}勝 ${rec[1]}敗`;
        $('resSub').innerHTML = `${escapeHTML(b.P.def.codename)} <b>${b.score[0]} - ${b.score[1]}</b> ${escapeHTML(b.C.def.codename)}`;
        if (playerWon) Sfx.chord([523, 659, 784, 1046], 2.0, 0.06); else Sfx.chord([147, 175, 220], 2.0, 0.06);
      }, 600);
    },
  };

  function updateHudFrame() {
    const b = state.battle;
    const set = (id, f) => {
      $(id + 'Spin').style.width = (f.spinFrac * 100).toFixed(1) + '%';
      $(id + 'Spin').classList.toggle('low', f.spinFrac < 0.25);
      $(id + 'Sp').style.width = f.special.toFixed(1) + '%';
      $(id).classList.toggle('ready', f.special >= 100 && f.overdrive <= 0);
      $(id).classList.toggle('od', f.overdrive > 0);
      $(id + 'Rpm').textContent = Math.round(f.free ? Math.max(0, f.spin) * 120 : f.spinFrac * 12000).toString().padStart(5, '0') + ' RPM';
      if (f.free) $(id + 'Spin').classList.toggle('low', f.spin / 100 < f.wc * 1.25);
    };
    set('hudP', b.P); set('hudC', b.C);
    if (b.state === 'launch') {
      $('needle').style.left = (b.launchGauge * 100).toFixed(1) + '%';
    }
    $('dashBtn').classList.toggle('cd', b.P.dashCD > 0);
    $('spBtn').classList.toggle('ready', b.P.special >= 100 && b.P.overdrive <= 0);
  }

  // ---------- 入力 ----------
  const keys = {};
  const touch = { id: null, sx: 0, sy: 0, x: 0, y: 0 };
  const JOY_R = 56;
  function buzz(pattern) {
    if (!IS_TOUCH || !navigator.vibrate) return;
    try { navigator.vibrate(pattern); } catch (_) {}
  }
  window.addEventListener('keydown', (e) => {
    if (document.activeElement === $('nameInput')) {
      if (e.key === 'Enter' && state.playerDef) { e.preventDefault(); $('btnFight').click(); }
      return;
    }
    keys[e.code] = true;
    Sfx.init();
    if (state.app === 'battle' && state.battle) {
      const b = state.battle;
      if (e.code === 'Space') {
        e.preventDefault();
        if (b.state === 'launch') b.lockLaunch();
        else if (b.state === 'battle') b.dash(b.P, currentMove());
      }
      if (e.code === 'KeyE' || e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyK') b.activateSpecial(b.P);
      if (e.code === 'KeyJ' && b.state === 'battle') b.dash(b.P, currentMove());
      if (e.code === 'Escape') gotoTitle();
    }
    if ((state.app === 'title' || state.app === 'vs') && e.code === 'KeyP') togglePhoto();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });

  function currentMove() {
    let ix = 0, iy = 0;
    if (keys.KeyA || keys.ArrowLeft) ix -= 1;
    if (keys.KeyD || keys.ArrowRight) ix += 1;
    if (keys.KeyW || keys.ArrowUp) iy += 1;
    if (keys.KeyS || keys.ArrowDown) iy -= 1;
    if (touch.id !== null) {
      const dx = touch.x - touch.sx, dy = touch.y - touch.sy;
      const l = Math.hypot(dx, dy);
      if (l > 6) { const m = Math.min(1, (l - 6) / (JOY_R - 6)); ix = dx / l * m; iy = -dy / l * m; }
    }
    const l = Math.hypot(ix, iy);
    if (l > 1) { ix /= l; iy /= l; }
    return state.battle ? state.battle.screenToWorld(ix, iy) : [0, 0];
  }

  // キャンバス操作（ショーケースの回転 / バトル中のクリックでシュート）
  const pts = new Map();   // ショーケースのピンチズーム用
  let pinch = null;
  canvas.addEventListener('pointerdown', (e) => {
    Sfx.init();
    if (state.app === 'battle' && state.battle) {
      const b = state.battle;
      if (b.state === 'launch') { b.lockLaunch(); return; }
      // 画面の左 2/3 ならどこでもスティック（触れた位置が中心）
      if (e.pointerType !== 'mouse' && touch.id === null && e.clientX < window.innerWidth * 0.66) {
        touch.id = e.pointerId; touch.sx = touch.x = e.clientX; touch.sy = touch.y = e.clientY;
        const j = $('joy'); j.style.left = e.clientX + 'px'; j.style.top = e.clientY + 'px'; j.classList.add('active');
        $('joyKnob').style.transform = '';
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      } else if (e.pointerType !== 'mouse' && b.state === 'battle') {
        // 右側のタップはダッシュ
        b.dash(b.P, currentMove());
      }
      return;
    }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const [p1, p2] = [...pts.values()];
      pinch = { d: Math.hypot(p1.x - p2.x, p1.y - p2.y), dist: state.cam.dist };
      state.cam.drag = null;
    } else if (pts.size === 1) {
      state.cam.drag = { x: e.clientX, y: e.clientY, az: state.cam.az, el: state.cam.el };
    }
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  });
  canvas.addEventListener('pointermove', (e) => {
    if (touch.id === e.pointerId) {
      touch.x = e.clientX; touch.y = e.clientY;
      let dx = touch.x - touch.sx, dy = touch.y - touch.sy;
      const l = Math.hypot(dx, dy);
      // 指が大きく離れたらスティックの中心を引きずる（親指の位置ずれに強い）
      if (l > JOY_R * 1.6) {
        const k = (l - JOY_R * 1.6) / l;
        touch.sx += dx * k; touch.sy += dy * k;
        const j = $('joy'); j.style.left = touch.sx + 'px'; j.style.top = touch.sy + 'px';
        dx = touch.x - touch.sx; dy = touch.y - touch.sy;
      }
      const l2 = Math.hypot(dx, dy), m = Math.min(l2, JOY_R);
      $('joyKnob').style.transform = `translate(${l2 ? dx / l2 * m : 0}px, ${l2 ? dy / l2 * m : 0}px)`;
      return;
    }
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) {
      const [p1, p2] = [...pts.values()];
      const d2 = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const lim = state.app === 'vs' ? [4, 10] : [2.0, 8];
      state.cam.dist = clamp(pinch.dist * pinch.d / Math.max(d2, 1), lim[0], lim[1]);
      if (state.photo) state.photoFrames = 0;
      return;
    }
    const d = state.cam.drag;
    if (!d) return;
    state.cam.az = d.az - (e.clientX - d.x) * 0.008;
    state.cam.el = clamp(d.el + (e.clientY - d.y) * 0.006, -0.05, 1.2);
    state.cam.autoT = 3;
    if (state.photo) state.photoFrames = 0;
  });
  const endPointer = (e) => {
    if (touch.id === e.pointerId) { touch.id = null; $('joy').classList.remove('active'); $('joyKnob').style.transform = ''; }
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    state.cam.drag = null;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('wheel', (e) => {
    if (state.app === 'battle') return;
    e.preventDefault();
    const lim = state.app === 'vs' ? [4, 10] : [2.0, 8];
    state.cam.dist = clamp(state.cam.dist * Math.exp(e.deltaY * 0.001), lim[0], lim[1]);
    if (state.photo) state.photoFrames = 0;
  }, { passive: false });

  $('dashBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); Sfx.init(); const b = state.battle; if (b) { if (b.state === 'launch') b.lockLaunch(); else { b.dash(b.P, currentMove()); buzz(12); } } });
  $('spBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); const b = state.battle; if (b) b.activateSpecial(b.P); });

  function togglePhoto() {
    state.photo = !state.photo;
    state.photoFrames = 0;
    document.body.classList.toggle('photo', state.photo);
    $('photoBadge').classList.toggle('active', state.photo);
  }

  // 名前入力
  let lastName = null;
  function onName() {
    const raw = $('nameInput').value;
    const nm = TopGen.normalizeName(raw);
    if (nm === lastName) return;
    lastName = nm;
    const def = TopGen.genTop(nm || 'MANDELBULB');
    state.playerDef = nm ? def : null;
    $('pCard').innerHTML = card(def, 'player');
    $('pCard').classList.toggle('demo', !nm);
    $('btnFight').disabled = !nm;
    if (titleDisp) {
      titleDisp.target = TopGen.topToVec(def);
      titleDisp.def = def;
      titleDisp.flash = 0.6;
      Sfx.whoosh(0.25, true, 0.08);
    }
    if (state.photo) state.photoFrames = 0;
  }
  $('nameInput').addEventListener('input', onName);
  function setMode(free, silent) {
    state.free = !!free;
    try { localStorage.setItem('mbmode', state.free ? 'free' : 'axis'); } catch (_) {}
    document.querySelectorAll('#modeSel button').forEach((b) => b.classList.toggle('on', (b.dataset.mode === 'free') === state.free));
    $('modeHint').textContent = state.free
      ? '軸もパーツもない、フラクタル本体だけのコマ。質量・慣性・接地・刃の形をすべて形状から実測して、物理演算だけで戦います。強い名前を探そう。'
      : '金属の軸とリングを備えた競技用コマ。名前から生まれたステータスで戦い、必殺技オーバードライブも使えます。';
    document.body.classList.toggle('freeMode', state.free);
    lastName = null; onName();
    if (titleDisp) { titleDisp.fpos = null; titleDisp.flash = 0.8; }
    if (!silent) { Sfx.init(); Sfx.whoosh(0.4, true, 0.15); }
  }
  document.querySelectorAll('#modeSel button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode === 'free')));
  $('nameInput').addEventListener('focus', () => Sfx.init());
  $('btnFight').addEventListener('click', () => { if (!state.playerDef) return; Sfx.init(); if (state.photo) togglePhoto(); gotoVS(true); });
  $('btnStart').addEventListener('click', () => { Sfx.init(); if (state.photo) togglePhoto(); gotoBattle(); });
  $('btnReroll').addEventListener('click', () => gotoVS(true));
  $('btnBack').addEventListener('click', () => gotoTitle());
  $('btnRematch').addEventListener('click', () => gotoBattle());
  $('btnNewCpu').addEventListener('click', () => { $('result').classList.remove('active'); gotoVS(true); });
  $('btnRename').addEventListener('click', () => { $('result').classList.remove('active'); gotoTitle(); });
  $('btnQuit').addEventListener('click', () => gotoTitle());

  $('qualitySel').addEventListener('change', (e) => {
    state.quality = e.target.value;
    try { localStorage.setItem('mbq', state.quality); } catch (_) {}
    resize();
  });
  $('photoBtn').addEventListener('click', () => { if (state.app === 'title' || state.app === 'vs') togglePhoto(); });
  $('fsBtn').addEventListener('click', () => {
    const d = document;
    try {
      if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      else { const el = d.documentElement; (el.requestFullscreen || el.webkitRequestFullscreen).call(el, { navigationUI: 'hide' }); }
    } catch (_) {}
  });
  $('soundBtn').addEventListener('click', () => {
    Sfx.init();
    Sfx.enabled = !Sfx.enabled;
    $('soundBtn').textContent = Sfx.enabled ? '♪ ON' : '♪ OFF';
  });

  // ---------- サイズ / 品質 ----------
  // スマホの「自動」は中品質の反復数から開始し、解像度で追従する
  function qset() { return QUALITY[state.quality === 'auto' ? (IS_TOUCH ? 'medium' : 'ultra') : state.quality]; }
  function resize() {
    const q = qset();
    const dpr = Math.min(window.devicePixelRatio || 1, q.dpr);
    const w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (state.quality !== 'auto') state.scale = q.maxScale;
  }
  window.addEventListener('resize', resize);

  function adaptScale(dt) {
    if (state.quality !== 'auto') return;
    // 非表示タブ等でのスロットリング（極端に長いフレーム）は計測から除外
    if (dt < 0.06) state.ema = lerp(state.ema, dt * 1000, 0.06);
    state.scaleT -= dt;
    if (state.scaleT > 0) return;
    // 4K 相当を上限とする
    const px = canvas.width * canvas.height;
    const maxS = Math.min(1.0, Math.sqrt(8.3e6 / px));
    // GPU タイマーが使えればそれを優先（目標 ~11ms）
    const g = R && R.gpuMs;
    const tooSlow = g != null ? g > 13.5 : state.ema > 22;
    const fast = g != null ? g < 8.0 : state.ema < 15.0;
    const minS = IS_TOUCH ? 0.3 : 0.35;
    if (tooSlow && state.scale > minS) { state.scale = Math.max(minS, +(state.scale - 0.05).toFixed(2)); state.scaleT = 0.5; }
    else if (fast && state.scale < maxS) { state.scale = Math.min(maxS, +(state.scale + 0.05).toFixed(2)); state.scaleT = 1.0; }
    else if (state.scale > maxS) state.scale = maxS;
    $('resBadge').textContent = Math.round(canvas.width * state.scale) + '×' + Math.round(canvas.height * state.scale);
  }

  // ---------- フレーム構築 ----------
  const KEY_STUDIO = normalize([-0.6, 0.78, 0.45]);
  const KEY_ARENA = normalize([-0.35, 0.9, 0.25]);
  function normalize(v) { const l = Math.hypot(...v); return v.map((x) => x / l); }

  function titleFrame(dt) {
    const d = titleDisp;
    const spinRate = 1.1;
    updateDisp(d, dt, spinRate);
    const c = state.cam;
    if (!c.drag && !state.photo) { c.autoT -= dt; if (c.autoT <= 0) c.az += dt * 0.12; }
    let top, contact = null, h;
    if (state.free) {
      const fp = dispFreePose(d, [0, 0, 0], dt);
      top = fp.pos; contact = fp.contact; h = Math.max(0.7, top[1]);
    } else {
      h = centerHeightV(d.vec, d.tilt);
      top = [0, h, 0];
    }
    const target = [0, h * 0.82, 0];
    const fov = 40;
    const aspect = canvas.width / canvas.height;
    // 縦長画面では横幅が足りないので距離を伸ばす
    const dist = c.dist * (aspect < 1.1 ? Math.min(2.6, 1.0 / aspect) : 1);
    const pos0 = [Math.cos(c.az) * Math.cos(c.el) * dist, target[1] + Math.sin(c.el) * dist, Math.sin(c.az) * Math.cos(c.el) * dist];
    const cam0 = makeCamera(pos0, target, fov);
    const halfH = dist * Math.tan(fov * Math.PI / 360);
    let shift;
    if (state.photo) shift = [0, 0, 0];
    else if (aspect > 1.1) shift = cam0.right.map((x) => -x * halfH * aspect * 0.3);
    else shift = cam0.up.map((x) => -x * halfH * 0.5);
    const cam = makeCamera(pos0.map((x, i) => x + shift[i]), target.map((x, i) => x + shift[i]), fov);
    return {
      mode: 1, cam, tops: [dispRender(d, top, spinRate, contact)], keyDir: KEY_STUDIO, keyCol: [3.6, 3.45, 3.25], floorY: 0,
      exposure: 1.0, bloomStr: 0.05,
    };
  }

  function vsFrame(dt) {
    const c = state.cam;
    if (!c.drag && !state.photo) { c.autoT -= dt; if (c.autoT <= 0) c.az = damp(c.az, -Math.PI / 2 + Math.sin(state.time * 0.3) * 0.35, 1.0, dt); }
    const target = [0, 0.75, 0];
    const aspect = canvas.width / canvas.height;
    // 2 体が横に収まる距離を確保（縦長画面対策）
    const dist = Math.min(18, Math.max(c.dist, 3.0 / (Math.tan(20 * Math.PI / 180) * aspect)));
    const pos = [Math.cos(c.az) * Math.cos(c.el) * dist, target[1] + Math.sin(c.el) * dist, Math.sin(c.az) * Math.cos(c.el) * dist];
    const cam = makeCamera(pos, target, 40);
    const base = makeCamera([0, target[1], -c.dist], target, 40);
    const tops = vsDisp.map((d, i) => {
      updateDisp(d, dt, 1.4);
      const side = i === 0 ? -1 : 1;
      if (state.free) {
        const fp = dispFreePose(d, [base.right[0] * 1.6 * side, 0, base.right[2] * 1.6 * side], dt);
        return dispRender(d, fp.pos, 1.4, fp.contact);
      }
      const p = [base.right[0] * 1.6 * side, centerHeightV(d.vec, d.tilt), base.right[2] * 1.6 * side];
      return dispRender(d, p, 1.4);
    });
    return { mode: 1, cam, tops, keyDir: KEY_STUDIO, keyCol: [3.6, 3.45, 3.25], floorY: 0, exposure: 1.0, bloomStr: 0.05 };
  }

  function battleFrame(dt) {
    const b = state.battle;
    b.aspect = canvas.width / canvas.height;
    const move = currentMove();
    b.update(dt, { move });
    const cam = b.getCamera();
    updateHudFrame();
    return {
      mode: 0, cam, tops: b.renderTops(), trails: b.trails(), shock: b.shockUniform(), particles: b.particles(),
      keyDir: KEY_ARENA, keyCol: [3.0, 2.85, 2.65], flash: b.flash, exposure: 1.0, bloomStr: 0.045, arenaGlow: 1.0,
    };
  }

  // ---------- メインループ ----------
  let last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    let dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!R || !R.ready) return;
    state.time += dt;
    adaptScale(dt);
    let F;
    if (state.app === 'title') F = titleFrame(dt);
    else if (state.app === 'vs') F = vsFrame(dt);
    else if (state.app === 'battle') F = battleFrame(dt);
    else return;
    const q = qset();
    F.time = state.time;
    F.scale = state.scale;
    F.quality = q;
    if (state.photo) {
      state.photoFrames++;
      F.staticW = Math.max(1 / state.photoFrames, 0.015);
      F.reset = state.photoFrames === 1;
    } else {
      F.staticW = 0.1;
    }
    F.dynW = 0.15;
    R.render(F);
  }

  // ---------- 起動 ----------
  async function boot() {
    try { const q = localStorage.getItem('mbq'); if (q && (q === 'auto' || QUALITY[q])) state.quality = q; } catch (_) {}
    $('qualitySel').value = state.quality;
    if (IS_TOUCH) { document.body.classList.add('touch'); state.scale = 0.5; }
    resize();
    try {
      R = new Renderer(canvas);
    } catch (e) {
      $('loadMsg').textContent = 'WebGL2 が利用できません: ' + e.message;
      return;
    }
    $('loadMsg').textContent = 'フラクタル・シェーダーを構築中…';
    try {
      await R.compileAll();
    } catch (e) {
      $('loadMsg').textContent = e.message;
      $('loadMsg').classList.add('err');
      return;
    }
    $('loading').classList.add('done');
    titleDisp = makeDisp(TopGen.genTop('MANDELBULB'));
    let m0 = 'axis';
    try { m0 = localStorage.getItem('mbmode') || 'axis'; } catch (_) {}
    setMode(m0 === 'free', true);
    gotoTitle();
  }
  requestAnimationFrame(loop);
  boot();
  // デバッグ用ハンドル
  window.__mb = { state, get R() { return R; }, gotoBattle, gotoVS, gotoTitle, setName: (n) => { $('nameInput').value = n; onName(); } };
})();
