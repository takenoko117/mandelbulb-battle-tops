// ============================================================
//  GLSL シェーダー群
//  - SCENE : マンデルバルブ・コマのレイマーチング本体
//  - TAA   : テンポラルAA（再投影 + 分散クリップ）
//  - BLOOM : デュアルフィルタ・ブルーム
//  - COMPOSITE : トーンマップ / 色収差 / ビネット / グレイン
//  - PARTICLE : 火花（深度テスト付き）
// ============================================================
(function (global) {
  'use strict';

  const FULLSCREEN_VS = `#version 300 es
void main(){
  vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2));
  gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);
}`;

  // ----------------------------------------------------------
  //  SCENE
  // ----------------------------------------------------------
  const SCENE_FS = `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;

uniform vec2  uRes;
uniform float uTime;
uniform int   uFrame;
uniform vec3  uCamPos;
uniform mat3  uCamRot;
uniform float uFocal;
uniform vec2  uJitter;
uniform int   uMode;        // 0 = バトルアリーナ, 1 = スタジオ（ショーケース）
uniform int   uIter;        // フラクタル反復回数
uniform int   uSteps;       // レイマーチ最大ステップ
uniform int   uShadowSteps;
uniform int   uReflSteps;
uniform float uFloorY;
uniform vec3  uKeyDir;
uniform vec3  uKeyCol;
uniform float uArenaGlow;

uniform int   uTopCount;
uniform vec3  uTPos[2];
uniform mat3  uTRot[2];
uniform vec4  uTShape[2];   // power, thetaPhase, squash, scale
uniform vec4  uTJulia[2];   // c.xyz, amount
uniform vec4  uTDyn[2];     // phiPhase, spinVis(rad/s), hitFlash, energy
uniform vec4  uTMatA[2];    // metal, rough, vein, irid
uniform vec4  uTMatB[2];    // sss, coat, trapMix, veinThr
uniform vec4  uTMisc[2];    // twist, alive, aura, motion
uniform vec3  uTPalA[2];
uniform vec3  uTPalB[2];
uniform vec3  uTPalC[2];
uniform vec3  uTPalD[2];
uniform vec3  uTGlow[2];
uniform vec3  uTTint[2];
uniform vec4  uTCont[2];    // 接地点(world xyz), 軸なしフラグ

uniform vec4  uTrail[32];   // xz, intensity, -
uniform vec4  uShock;       // x, z, age, strength

#define PI  3.14159265359
// ループの展開を防ぐ（D3D コンパイラが DE を何重にもインライン展開するのを防止）
#define ZERO (min(uFrame,0))
#define TAU 6.28318530718
const float A_BOWL = 0.03;
const float R_BOWL = 7.0;
const float BOUND  = 1.5;

struct Top {
  vec3 pos; mat3 irot;
  float power, thPh, phiPh, squash, scale, twist, jAmt;
  vec3 jc;
  float hb, tipLen, crownTop, alive, axisless;
};
Top gT[2];

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }

void loadTops(float rnd){
  for(int i=0;i<2;i++){
    Top T;
    T.pos = uTPos[i];
    // ピクセル毎のシャッター内回転角 → 確率的モーションブラー（TAAで平均化）
    float ang = (rnd-0.5) * uTDyn[i].y * (1.0/60.0) * 0.45;
    float c = cos(ang), s = sin(ang);
    mat3 blur = mat3(c,0.0,-s, 0.0,1.0,0.0, s,0.0,c);
    T.irot = blur * transpose(uTRot[i]);
    T.power = uTShape[i].x; T.thPh = uTShape[i].y; T.squash = uTShape[i].z; T.scale = uTShape[i].w;
    T.phiPh = uTDyn[i].x; T.twist = uTMisc[i].x;
    T.jc = uTJulia[i].xyz; T.jAmt = uTJulia[i].w;
    T.hb = 1.12*T.squash; T.tipLen = T.hb + 0.38; T.crownTop = T.hb + 0.20;
    T.alive = uTMisc[i].y;
    T.axisless = uTCont[i].w;
    gT[i] = T;
  }
}

// ---------------- SDF primitives ----------------
float sdCappedCone(vec3 p, float h, float r1, float r2){
  vec2 q = vec2(length(p.xz), p.y);
  vec2 k1 = vec2(r2, h);
  vec2 k2 = vec2(r2-r1, 2.0*h);
  vec2 ca = vec2(q.x - min(q.x, (q.y<0.0)?r1:r2), abs(q.y)-h);
  vec2 cb = q - k1 + k2*clamp(dot(k1-q,k2)/dot(k2,k2), 0.0, 1.0);
  float s = (cb.x<0.0 && ca.y<0.0) ? -1.0 : 1.0;
  return s*sqrt(min(dot(ca,ca), dot(cb,cb)));
}
float sdCappedCylinder(vec3 p, float r, float h){
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r,h);
  return min(max(d.x,d.y),0.0) + length(max(d,0.0));
}
bool raySphere(vec3 ro, vec3 rd, vec3 c, float r, out vec2 tt){
  vec3 oc = ro-c; float b = dot(oc,rd); float cc = dot(oc,oc)-r*r; float h = b*b-cc;
  if(h<0.0) return false;
  h = sqrt(h); tt = vec2(-b-h, -b+h);
  return tt.y > 0.0;
}

// ---------------- Mandelbulb DE ----------------
// 極軸 = Y（コマの回転軸）。trap: (|x|,|y|,|z| の最小, r^2 最小)
float bulbDE(vec3 p, Top T, int iters, out vec4 trap){
  vec3 z = p;
  float dr = 1.0;
  float r = length(z);
  trap = vec4(abs(z), r*r);
  float n = T.power;
  vec3 c = mix(p, T.jc, T.jAmt);
  float jk = 1.0 - T.jAmt;
  for(int k=ZERO;k<iters;k++){
    if(r>2.0) break;
    float theta = acos(clamp(z.y/max(r,1e-8), -1.0, 1.0))*n + T.thPh;
    float phi   = atan(z.z, z.x)*n + T.phiPh;
    float rp = pow(r, n-1.0);
    dr = rp*n*dr + jk;
    float st = sin(theta);
    z = (rp*r)*vec3(st*cos(phi), cos(theta), st*sin(phi)) + c;
    r = length(z);
    trap = min(trap, vec4(abs(z), r*r));
  }
  return 0.5*log(max(r,1e-8))*r/dr;
}

// コマ全体の距離関数（ローカル座標, ワールド単位）
// mat: 0 = フラクタル本体, 1 = 金属パーツ, 2 = ジェム, 3 = ドライブリング
float topDE(vec3 q, Top T, int iters, out vec4 trap, out float mat){
  float s = T.scale;
  vec3 p = q/s;
  vec3 b = p;
  float tw = b.y*T.twist;
  float cw = cos(tw), sw = sin(tw);
  b.xz = mat2(cw, sw, -sw, cw)*b.xz;
  b.y /= T.squash;
  float lip = T.squash/(1.0 + abs(T.twist)*0.8);
  float d = bulbDE(b, T, iters, trap)*lip;
  mat = 0.0;
  // 軸なしモード：フラクタル本体のみ
  if(T.axisless > 0.5) return d*s;
  float hb = T.hb;
  // 軸先（ティップ）
  float tTop = -hb*0.5, tBot = -T.tipLen + 0.03;
  float hh = (tTop - tBot)*0.5;
  vec3 tp = p - vec3(0.0, (tTop+tBot)*0.5, 0.0);
  float dTip = sdCappedCone(tp, hh, 0.035, 0.30) - 0.03 + 0.003*sin(p.y*80.0);
  // クラウン（シャフト）
  vec3 cp = p - vec3(0.0, T.crownTop*0.5, 0.0);
  float ca = atan(cp.z, cp.x);
  float dCrown = sdCappedCylinder(cp, 0.115 + 0.012*cos(ca*8.0), T.crownTop*0.5) - 0.012;
  // ジェム
  vec3 gp = p - vec3(0.0, T.crownTop + 0.10, 0.0);
  float dGem = (abs(gp.x) + abs(gp.y)*0.75 + abs(gp.z) - 0.15)*0.55;
  // ドライブリング
  vec3 rp = p - vec3(0.0, -hb*0.62, 0.0);
  float dRing = length(vec2(length(rp.xz)-0.46, rp.y)) - 0.042;
  float dm = min(dTip, dCrown);
  if(dm < d){ d = dm; mat = 1.0; }
  float de = min(dGem, dRing);
  if(de < d){ d = de; mat = (dRing < dGem) ? 3.0 : 2.0; }
  return d*s;
}

// 距離に応じた反復回数 LOD（画素より細かいディテールのちらつきを抑制）
int lodIter(int base, float t, float pixAng, float s){
  float fp = t*pixAng/s;
  return max(base - int(clamp(log2(max(fp, 1e-6)/0.003), 0.0, 3.0)), 4);
}

vec3 topNormal(Top T, vec3 q, float eps, int iters){
  vec3 n = vec3(0.0);
  vec4 tr; float m;
  for(int j=ZERO;j<4;j++){
    vec3 e = 0.5773*(2.0*vec3(float(((j+3)>>1)&1), float((j>>1)&1), float(j&1)) - 1.0);
    n += e*topDE(q + e*eps, T, iters, tr, m);
  }
  return normalize(n);
}

float marchTops(vec3 ro, vec3 rd, float tmax, int steps, int iters, float pixAng, float epsMul,
                out int hitId, out vec4 hitTrap, out float hitMat, out vec2 minD){
  hitId = -1; hitTrap = vec4(1.0); hitMat = 0.0; minD = vec2(1e9);
  float best = tmax;
  for(int i=ZERO;i<2;i++){
    if(i>=uTopCount) break;
    Top T = gT[i];
    if(T.alive < 0.5) continue;
    float s = T.scale;
    vec2 tt;
    if(!raySphere(ro, rd, T.pos, BOUND*s, tt)) continue;
    float t = max(tt.x, 0.0);
    float tEnd = min(tt.y, best);
    if(t >= tEnd) continue;
    vec3 lo = T.irot*(ro - T.pos);
    vec3 ld = T.irot*rd;
    vec4 trap; float mat;
    float md = 1e9;
    bool done = false;
    int it = lodIter(iters, length(ro - T.pos), pixAng, s);
    float d = 1e9;
    for(int k=ZERO;k<steps;k++){
      d = topDE(lo + ld*t, T, it, trap, mat);
      md = min(md, d/s);
      float eps = max(1.5e-4, t*pixAng*epsMul);
      if(d < eps){
        if(t < best){ best = t; hitId = i; hitTrap = trap; hitMat = mat; }
        done = true;
        break;
      }
      t += d*0.82;
      if(t > tEnd){ done = true; break; }
    }
    // ステップを使い切った場合：表面にかなり近ければヒット扱い（スペックル防止）
    if(!done && d < 0.02*s && t < best){ best = t; hitId = i; hitTrap = trap; hitMat = mat; }
    minD[i] = md;
  }
  return hitId >= 0 ? best : -1.0;
}

float shadowTops(vec3 ro, vec3 rd, float k, int iters, int steps){
  float res = 1.0;
  for(int i=ZERO;i<2;i++){
    if(i>=uTopCount) break;
    Top T = gT[i];
    if(T.alive < 0.5) continue;
    float s = T.scale;
    vec2 tt;
    if(!raySphere(ro, rd, T.pos, BOUND*s, tt)) continue;
    float t = max(tt.x, 0.0) + 0.003*s;
    vec3 lo = T.irot*(ro - T.pos);
    vec3 ld = T.irot*rd;
    vec4 tr; float m;
    for(int j=ZERO;j<steps;j++){
      if(t>tt.y) break;
      float d = topDE(lo + ld*t, T, iters, tr, m);
      res = min(res, k*d/t);
      if(res < 0.002) return 0.0;
      t += clamp(d, 0.004*s, 0.2*s);
    }
  }
  res = clamp(res, 0.0, 1.0);
  return res*res*(3.0-2.0*res);
}

float topAO(Top T, vec3 q, vec3 nl, int iters){
  float s = T.scale;
  float occ = 0.0, w = 1.0;
  vec4 tr; float m;
  for(int j=ZERO+1;j<=5;j++){
    float h = s*(0.008 + 0.022*float(j*j));
    float d = topDE(q + nl*h, T, iters, tr, m);
    occ += max(h - d, 0.0)*w;
    w *= 0.72;
  }
  return clamp(1.0 - 2.2*occ/s, 0.0, 1.0);
}

// ---------------- 照明モデル ----------------
vec3 ggx(vec3 n, vec3 v, vec3 l, float rough, vec3 f0){
  vec3 h = normalize(v+l);
  float NoL = max(dot(n,l),0.0), NoV = max(dot(n,v),1e-3), NoH = max(dot(n,h),0.0), VoH = max(dot(v,h),0.0);
  float a = max(rough*rough, 0.0025);
  float a2 = a*a;
  float dd = NoH*NoH*(a2-1.0)+1.0;
  float D = a2/(PI*dd*dd);
  float k = a*0.5;
  float G = 1.0/((NoL*(1.0-k)+k)*(NoV*(1.0-k)+k));
  vec3 F = f0 + (1.0-f0)*pow(1.0-VoH, 5.0);
  return min(D*G*F*0.25, vec3(60.0));
}

float softbox(vec3 d, vec3 c, vec3 u, vec2 size, float rough){
  float k = dot(d,c);
  if(k <= 0.0) return 0.0;
  vec3 v = normalize(cross(c,u));
  vec3 uu = cross(v,c);
  vec2 q = vec2(dot(d,uu), dot(d,v))/k;
  float blur = 0.015 + rough*rough*1.6;
  vec2 e = smoothstep(size+blur, size-blur*0.5, abs(q));
  float area = (size.x+blur)*(size.y+blur);
  return e.x*e.y * min(1.0, (size.x*size.y)/area*1.6);
}

vec3 envBattle(vec3 d, float rough){
  float w = 1.0 + rough*rough*70.0;
  float y = d.y;
  vec3 col = mix(vec3(0.010,0.012,0.020), vec3(0.030,0.036,0.058), smoothstep(0.0, 0.8, y));
  if(y < 0.0){
    col = mix(vec3(0.020,0.024,0.034), vec3(0.006), smoothstep(0.0,-0.6,y));
    col += vec3(0.05,0.18,0.5)*exp(y*7.0/w*1.5)*0.25*uArenaGlow;
  }
  float az = atan(d.z, d.x);
  float el = asin(clamp(y,-1.0,1.0));
  // スタジアム照明のリング
  float N = 10.0;
  float a = (fract(az/TAU*N) - 0.5)*(TAU/N)*cos(el);
  float e = el - 0.62;
  col += vec3(1.0,0.93,0.84)*exp(-(a*a+e*e)*1100.0/w)*(26.0/w);
  float a2 = (fract(az/TAU*N + 0.5) - 0.5)*(TAU/N)*cos(el);
  float e2 = el - 0.30;
  col += vec3(0.45,0.65,1.0)*exp(-(a2*a2*0.4+e2*e2*6.0)*900.0/w)*(10.0/w);
  // 天井のリングライト（細い円環）
  float ry = (y - 0.93)*(28.0/sqrt(w));
  col += vec3(0.75,0.85,1.0)*exp(-ry*ry)*(1.4/sqrt(w));
  // 地平のネオン帯
  col += vec3(0.08,0.40,1.0)*exp(-abs(y-0.06)*(70.0/w))*0.9/sqrt(w)*uArenaGlow;
  // ウォームなサイドライト
  vec3 sd = normalize(vec3(0.8,0.35,-0.5));
  col += vec3(1.0,0.45,0.18)*pow(max(dot(d,sd),0.0), 400.0/w)*(12.0/w);
  return col;
}

vec3 envStudio(vec3 d, float rough){
  float y = d.y;
  vec3 col = vec3(0.006,0.007,0.011) + vec3(0.032,0.036,0.055)*smoothstep(-0.3,1.0,y);
  if(y < 0.0) col = vec3(0.006,0.006,0.008)*(1.0+y);
  float att = 1.0/(1.0 + rough*3.0);
  col += vec3(1.00,0.96,0.90)*softbox(d, vec3(0.0,1.0,0.0), vec3(1.0,0.0,0.0), vec2(0.55,0.55), rough)*3.2;
  col += vec3(0.75,0.85,1.00)*softbox(d, normalize(vec3(-1.0,0.25,0.35)), vec3(0.0,1.0,0.0), vec2(0.7,0.10), rough)*5.0;
  col += vec3(1.00,0.62,0.40)*softbox(d, normalize(vec3(1.0,0.15,-0.45)), vec3(0.0,1.0,0.0), vec2(0.6,0.07), rough)*4.0;
  col += vec3(0.55,0.45,1.00)*softbox(d, normalize(vec3(0.2,0.35,1.0)), vec3(0.0,1.0,0.0), vec2(0.9,0.05), rough)*2.5;
  col += vec3(0.9,0.95,1.0)*pow(max(dot(d, normalize(vec3(-0.5,0.8,-0.6))),0.0), 600.0/(1.0+rough*rough*80.0))*(30.0/(1.0+rough*rough*80.0));
  // カメラ基準の大型キー・ソフトボックス（どの角度でも金属が映える）
  vec3 cf = uCamRot[2], cu = uCamRot[1], cr = uCamRot[0];
  col += vec3(0.95,0.97,1.0)*softbox(d, normalize(-cf*0.75 + cu*0.55 - cr*0.55), cu, vec2(0.55,0.35), rough)*1.8;
  col += vec3(0.85,0.75,1.0)*softbox(d, normalize(-cf*0.5 - cu*0.1 + cr*0.9), cu, vec2(0.12,0.6), rough)*1.2;
  return col*mix(1.0, att*1.6, 0.0);
}

vec3 envMap(vec3 d, float rough){
  return uMode==0 ? envBattle(d, rough) : envStudio(d, rough);
}
// 拡散用の放射照度（解析的近似：環境マップ全体のインライン展開を避ける）
vec3 envIrr(vec3 n){
  float h = n.y*0.5 + 0.5;
  if(uMode == 0){
    vec3 c = mix(vec3(0.016,0.020,0.034), vec3(0.075,0.085,0.115), h);
    c += vec3(0.30,0.28,0.25)*pow(max(n.y,0.0), 2.0)*0.25;
    c += vec3(0.25,0.12,0.05)*max(dot(n, normalize(vec3(0.8,0.35,-0.5))), 0.0)*0.12;
    return c;
  }
  vec3 c = mix(vec3(0.008,0.009,0.012), vec3(0.06,0.062,0.07), h);
  c += vec3(1.00,0.96,0.90)*pow(max(n.y,0.0), 2.0)*0.22;
  c += vec3(0.75,0.85,1.00)*max(dot(n, normalize(vec3(-1.0,0.25,0.35))), 0.0)*0.14;
  c += vec3(1.00,0.62,0.40)*max(dot(n, normalize(vec3(1.0,0.15,-0.45))), 0.0)*0.09;
  return c;
}

float groundY(vec3 p){
  if(uMode==0){ float r = min(length(p.xz), R_BOWL); return A_BOWL*r*r; }
  return uFloorY;
}

// ---------------- コマのシェーディング ----------------
// 注意: 距離関数を呼ぶ処理（マーチ/法線/影/AO）は main() で 1 箇所ずつだけ呼ぶ。
//       HLSL 変換時に全関数がインライン展開されるため、呼び出し箇所を減らすとコンパイルが大幅に速くなる。
vec3 shadeTopSurf(int i, vec3 p, vec3 n, vec3 q, vec3 rd, vec4 trap, float mat, float sh, float aoIn){
  float s = gT[i].scale;
  vec3 V = -rd;
  float NoV = max(dot(n,V), 1e-3);

  float ctA = clamp(sqrt(trap.w), 0.0, 1.3);
  float ctB = clamp(length(trap.xz)*1.1 + trap.y*0.45, 0.0, 1.6);
  float ct = mix(ctA, ctB, uTMatB[i].z);
  vec3 base = clamp(uTPalA[i] + uTPalB[i]*cos(TAU*(uTPalC[i]*ct + uTPalD[i])), 0.0, 1.0);
  float metal = uTMatA[i].x, rough = uTMatA[i].y, vein = uTMatA[i].z, irid = uTMatA[i].w;
  float sss = uTMatB[i].x, coat = uTMatB[i].y, veinThr = uTMatB[i].w;
  vec3 glow = uTGlow[i];
  float energy = uTDyn[i].w, flash = uTDyn[i].z;
  vec3 emis = vec3(0.0);
  float ao = aoIn;

  if(mat < 0.5){
    float tm = min(trap.x, min(trap.y, trap.z));
    float v = 1.0 - smoothstep(0.0, veinThr, tm);
    float pulse = 0.65 + 0.35*sin(uTime*3.0 - ct*18.0);
    emis += glow*v*vein*pulse*(0.55 + 0.7*energy);
    // 軌道トラップによる凹部の暗さ
    ao *= mix(0.4, 1.0, smoothstep(0.05, 0.75, trap.w));
    // ハイライトのカラーバリエーション
    base *= 0.85 + 0.3*smoothstep(0.0, 0.25, tm);
  } else if(mat < 1.5){
    base = uTTint[i]; metal = 1.0; rough = 0.14; vein = 0.0; irid = 0.06; sss = 0.0; coat = 0.0;
    // 細かい旋盤目
    rough += 0.06*sin(q.y/s*160.0);
  } else {
    float ang = atan(q.z, q.x);
    float dash = mat > 2.5 ? (0.25 + 0.75*smoothstep(0.2, 0.95, sin(ang*6.0))) : (0.8 + 0.2*sin(uTime*5.0));
    emis += glow*(1.4 + 5.0*energy)*dash + vec3(1.0)*0.5*dash*energy;
    base = glow*0.25; metal = 0.0; rough = 0.04; coat = 1.0; sss = 0.6; irid = 0.0;
  }

  // 床への近接による遮蔽
  float gocc = clamp((p.y - groundY(p))/(0.8*s), 0.0, 1.0);
  ao *= mix(1.0, mix(0.35, 1.0, gocc), clamp(0.5 - 0.5*n.y, 0.0, 1.0));

  vec3 f0 = mix(vec3(0.04), base, metal);
  vec3 film = 0.5 + 0.5*cos(TAU*(vec3(0.0,0.33,0.67) + 1.8*(1.0-NoV) + ct*0.7 + 0.15));
  f0 = mix(f0, clamp(f0*0.45 + film*0.8, 0.0, 1.0), irid);
  vec3 diff = base*(1.0 - metal);

  vec3 col = vec3(0.0);
  // キーライト（ソフトシャドウ付き）
  vec3 L = uKeyDir;
  float NoLr = dot(n, L);
  float NoL = max(NoLr, 0.0);
  float wrap = max((NoLr + 0.6*sss)/(1.0 + 0.6*sss), 0.0);
  col += uKeyCol*sh*(diff/PI*mix(NoL, wrap, sss*0.7) + ggx(n,V,L,rough,f0)*NoL);
  // リムライト（カメラ基準）
  vec3 cf = uCamRot[2], cu = uCamRot[1], cr = uCamRot[0];
  vec3 Lr = normalize(-cf + cu*0.7 + cr*0.45);
  vec3 rimCol = uMode==0 ? vec3(0.35,0.55,1.0)*2.4 : vec3(0.6,0.72,1.0)*3.0;
  float NoLrim = max(dot(n,Lr), 0.0);
  col += rimCol*(diff/PI*NoLrim*0.5 + ggx(n,V,Lr,max(rough,0.1),f0)*NoLrim);
  // 環境光（拡散）
  col += diff*envIrr(n)*ao;
  // 環境反射（スペキュラ・オクルージョン付き）
  vec3 R = reflect(rd, n);
  vec3 F = f0 + (max(vec3(1.0-rough), f0) - f0)*pow(1.0-NoV, 5.0);
  float so = clamp(pow(NoV + ao, exp2(-16.0*rough - 1.0)) - 1.0 + ao, 0.0, 1.0);
  vec3 envR = envMap(R, rough);
  if(uMode==0 && R.y < 0.0) envR += glow*energy*0.25*smoothstep(0.0,-0.6,R.y);
  col += envR*F*so;
  // クリアコート
  if(coat > 0.0){
    float Fc = 0.04 + 0.96*pow(1.0-NoV, 5.0);
    vec3 cc = envMap(R, 0.03)*Fc*so + uKeyCol*sh*ggx(n,V,L,0.05,vec3(0.04))*NoL;
    col = col*(1.0 - Fc*coat) + cc*coat;
  }
  // 疑似サブサーフェス
  col += base*glow*sss*0.3*pow(1.0-NoV, 2.0)*ao;
  // 床の反射光とドライブリングによる下面照明
  col += diff*vec3(0.03,0.08,0.20)*clamp(-n.y,0.0,1.0)*(uMode==0 ? uArenaGlow : 0.35);
  col += glow*energy*0.5*clamp(-n.y,0.0,1.0)*ao*(diff + f0*0.4);
  col += emis;
  col += glow*pow(1.0-NoV, 4.0)*(0.12 + energy*0.6);
  col += vec3(1.0,0.86,0.72)*flash*(0.6 + 2.5*pow(1.0-NoV, 2.0));
  return col;
}

// ---------------- アリーナ ----------------
float arenaSDF(vec3 p, out float m){
  float r = length(p.xz);
  float rr = min(r, R_BOWL);
  float d = (p.y - A_BOWL*rr*rr)/sqrt(1.0 + 4.0*A_BOWL*A_BOWL*rr*rr);
  m = 0.0;
  float rimY = A_BOWL*R_BOWL*R_BOWL;
  vec2 tq = vec2(r - (R_BOWL + 0.34), p.y - (rimY + 0.02));
  float dr = length(tq) - 0.34;
  if(dr < d){ d = dr; m = 1.0; }
  return d;
}
float traceArena(vec3 ro, vec3 rd, out float m){
  m = 0.0;
  float rimY = A_BOWL*R_BOWL*R_BOWL;
  float top = rimY + 0.75;
  float t = 0.0;
  if(ro.y > top){
    if(rd.y >= 0.0) return -1.0;
    t = (ro.y - top)/(-rd.y);
  }
  for(int i=ZERO;i<200;i++){
    vec3 p = ro + rd*t;
    float d = arenaSDF(p, m);
    if(abs(d) < 0.0006*t + 0.0005) return t;
    t += d*0.95;
    if(t > 150.0 || (p.y > top && rd.y > 0.0)) return -1.0;
  }
  return t < 150.0 ? t : -1.0;
}
vec3 arenaNormal(vec3 p, float t){
  float e = 0.0008*t + 0.0005;
  float m;
  vec2 k = vec2(1.0,-1.0);
  return normalize(k.xyy*arenaSDF(p+k.xyy*e,m) + k.yyx*arenaSDF(p+k.yyx*e,m) + k.yxy*arenaSDF(p+k.yxy*e,m) + k.xxx*arenaSDF(p+k.xxx*e,m));
}

float aaLine(float d, float w, float fw){
  float k = max(fw, 1e-4);
  return clamp((w - d)/k + 0.5, 0.0, 1.0)*clamp(2.0*w/k, 0.0, 1.0);
}
float hexDist(vec2 p){ p = abs(p); return max(p.x*0.8660254 + p.y*0.5, p.y); }

vec3 trailGlow(vec2 p){
  vec3 acc = vec3(0.0);
  for(int k=ZERO;k<2;k++){
    if(k>=uTopCount) break;
    for(int j=ZERO;j<15;j++){
      vec4 a = uTrail[k*16+j], b = uTrail[k*16+j+1];
      if(a.z <= 0.001 || b.z <= 0.001) continue;
      vec2 pa = p - a.xy, ba = b.xy - a.xy;
      float h = clamp(dot(pa,ba)/max(dot(ba,ba),1e-5), 0.0, 1.0);
      vec2 dv = pa - ba*h;
      float d2 = dot(dv,dv);
      if(d2 > 2.0) continue;
      float inten = mix(a.z, b.z, h);
      acc += uTGlow[k]*inten*(exp(-d2*90.0)*0.7 + exp(-sqrt(d2)*5.0)*0.06);
    }
  }
  return acc;
}

// 床のコマ由来の遮蔽・光だまり
void topsOnFloor(vec3 p, vec3 n, out float ao, out vec3 pool){
  ao = 1.0; pool = vec3(0.0);
  for(int i=ZERO;i<2;i++){
    if(i>=uTopCount || gT[i].alive<0.5) continue;
    float s = gT[i].scale;
    vec3 c = gT[i].pos;
    vec3 dv = c - p; float l2 = dot(dv,dv); float l = sqrt(l2);
    float rad = 0.95*s;
    ao *= 1.0 - clamp(max(dot(n, dv/l),0.0)*(rad*rad)/l2, 0.0, 1.0)*0.9;
    vec3 axis = uTRot[i][1];
    vec3 tip = gT[i].axisless > 0.5 ? uTCont[i].xyz + vec3(0.0, 0.05*s, 0.0)
                                    : c - axis*(gT[i].tipLen*s) + vec3(0.0, 0.06*s, 0.0);
    dv = tip - p; l2 = dot(dv,dv); l = sqrt(l2);
    float tr = 0.12*s;
    ao *= 1.0 - clamp(max(dot(n, dv/l),0.0)*(tr*tr)/l2, 0.0, 1.0)*0.8;
    vec2 dxz = p.xz - c.xz;
    float dd = dot(dxz,dxz)/(s*s);
    pool += uTGlow[i]*(uTDyn[i].w*0.8 + 0.12)*(exp(-dd*1.3)*0.9 + exp(-dd*0.22)*0.18);
  }
}

// 床のシェーディング（影 sh は外で計算済み）。反射は「リクエスト」として返す
vec3 shadeArena(vec3 p, vec3 n, vec3 rd, float t, float m, float pixAng, vec3 rnd3, float sh,
                out vec3 reflD, out vec3 reflDEnv, out vec3 reflW, out float reflRough){
  vec3 V = -rd;
  float NoV = max(dot(n,V), 1e-3);
  float r = length(p.xz);
  float fw = t*pixAng/max(NoV, 0.12);
  vec3 albedo = vec3(0.02);
  float rough = 0.25, metal = 0.0;
  vec3 emis = vec3(0.0);
  float ang = atan(p.z, p.x);
  if(m < 0.5){
    if(r < R_BOWL){
      albedo = vec3(0.016,0.018,0.024);
      // 同心円の研磨模様（ラフネス変調）
      float brushed = sin(r*190.0 + sin(ang*3.0)*2.0)*0.5 + 0.5;
      rough = mix(0.16, 0.24, brushed*clamp(1.0 - fw*90.0, 0.0, 1.0));
      float ringD = abs(fract(r + 0.5) - 0.5);
      float secD = abs(fract(ang/TAU*24.0 + 0.5) - 0.5)*(TAU/24.0)*r;
      float g = aaLine(ringD, 0.010, fw)*0.8 + aaLine(secD, 0.007, fw)*0.45*smoothstep(1.4, 2.2, r);
      float hx = hexDist(p.xz);
      g += aaLine(abs(hx - 1.05), 0.018, fw)*1.3 + aaLine(abs(hx - 1.22), 0.008, fw)*0.8;
      float pulse = 0.75 + 0.25*sin(uTime*1.5 - r*0.9);
      emis += vec3(0.07,0.32,1.0)*g*0.55*pulse*uArenaGlow;
      float rb = abs(r - (R_BOWL - 0.25));
      emis += vec3(0.15,0.5,1.25)*(aaLine(rb, 0.028, fw)*2.2 + exp(-rb*6.0)*0.12)*uArenaGlow;
      emis += trailGlow(p.xz);
      if(uShock.w > 0.0){
        float sd = length(p.xz - uShock.xy);
        float rr = uShock.z*10.0;
        float wv = exp(-pow((sd - rr)*9.0, 2.0))*uShock.w*exp(-uShock.z*3.5);
        emis += vec3(0.5,0.75,1.4)*wv*0.7;
      }
    } else {
      albedo = vec3(0.012);
      rough = 0.4;
      float st = abs(fract(ang/TAU*64.0 + 0.5) - 0.5)*(TAU/64.0)*r;
      float band = smoothstep(R_BOWL+0.9, R_BOWL+1.3, r)*smoothstep(R_BOWL+4.5, R_BOWL+2.5, r);
      emis += vec3(1.0,0.35,0.1)*aaLine(st, 0.02, fw)*0.18*band*uArenaGlow;
      emis += vec3(0.1,0.4,1.0)*aaLine(abs(r-(R_BOWL+5.0)), 0.05, fw)*1.4*uArenaGlow;
      emis += vec3(0.1,0.4,1.0)*aaLine(abs(r-(R_BOWL+5.25)), 0.015, fw)*0.8*uArenaGlow;
    }
  } else {
    albedo = vec3(0.55,0.58,0.64); rough = 0.22; metal = 1.0;
    float dash = smoothstep(0.3, 0.9, sin(ang*36.0 - uTime*2.0));
    emis += vec3(0.15,0.55,1.3)*smoothstep(0.75, 0.97, n.y)*(0.8 + 1.2*dash)*uArenaGlow;
  }
  float ao; vec3 pool;
  topsOnFloor(p, n, ao, pool);
  vec3 f0 = mix(vec3(0.05), albedo, metal);
  vec3 diff = albedo*(1.0 - metal);
  vec3 L = uKeyDir;
  float NoL = max(dot(n,L), 0.0);
  vec3 col = uKeyCol*sh*NoL*(diff/PI + ggx(n,V,L,rough,f0));
  col += diff*envIrr(n)*ao;
  col += pool*(diff*5.0 + 0.035)*ao;
  // グロッシー反射（ランダム方向ジッタ → TAAで積分）
  reflDEnv = reflect(rd, n);
  reflD = normalize(reflDEnv + rough*0.25*(rnd3 - 0.5));
  if(dot(reflD,n) < 0.0) reflD = reflect(reflD, n);
  vec3 F = f0 + (1.0 - f0)*pow(1.0 - NoV, 5.0);
  reflW = F*mix(1.0, ao, 0.7);
  reflRough = rough;
  col += emis*mix(1.0, ao, 0.4);
  return col;
}

vec3 studioBg(vec3 rd, vec2 uv){
  float y = rd.y;
  vec3 c = mix(vec3(0.004,0.005,0.009), vec3(0.018,0.022,0.04), smoothstep(-0.1,0.6,y));
  c += vec3(0.035,0.04,0.07)*exp(-length(uv - vec2(0.15,0.05))*1.6);
  c += vec3(0.04,0.02,0.05)*exp(-length(uv - vec2(-1.2,0.6))*1.2);
  return c;
}

vec3 shadeStudioFloor(vec3 p, vec3 rd, float t, float pixAng, vec3 rnd3, float sh,
                      out vec3 reflD, out vec3 reflDEnv, out vec3 reflW, out float reflRough, out float fade){
  vec3 n = vec3(0.0,1.0,0.0);
  vec3 V = -rd;
  float NoV = max(dot(n,V), 1e-3);
  float fw = t*pixAng/max(NoV, 0.12);
  vec3 albedo = vec3(0.012,0.013,0.016);
  float rough = 0.10;
  vec3 emis = vec3(0.0);
  for(int i=ZERO;i<2;i++){
    if(i>=uTopCount || gT[i].alive<0.5) continue;
    float s = gT[i].scale;
    float d = length(p.xz - gT[i].pos.xz);
    float a = atan(p.z - gT[i].pos.z, p.x - gT[i].pos.x);
    float dash = 0.4 + 0.6*smoothstep(-0.2, 0.8, sin(a*20.0 + uTime*1.5));
    emis += uTGlow[i]*(aaLine(abs(d - 1.55*s), 0.012, fw)*1.6*dash + aaLine(abs(d - 1.72*s), 0.005, fw)*0.7);
    emis += uTGlow[i]*exp(-abs(d - 1.55*s)*8.0)*0.06;
  }
  float hexG = 0.0;
  {
    vec2 g = p.xz*1.6;
    vec2 gr = vec2(1.0, 1.7320508);
    vec2 h = gr*0.5;
    vec2 a = mod(g, gr) - h;
    vec2 b = mod(g - h, gr) - h;
    vec2 gv = dot(a,a) < dot(b,b) ? a : b;
    float hd = 0.5 - hexDist(gv.yx);
    hexG = aaLine(hd, 0.012, fw*1.6);
  }
  fade = exp(-dot(p.xz,p.xz)*0.035);
  emis += vec3(0.05,0.08,0.16)*hexG*fade*0.6;
  float ao; vec3 pool;
  topsOnFloor(p, n, ao, pool);
  vec3 f0 = vec3(0.045);
  vec3 L = uKeyDir;
  float NoL = max(dot(n,L), 0.0);
  vec3 col = uKeyCol*sh*NoL*(albedo/PI + ggx(n,V,L,0.45,f0)*0.35);
  col += albedo*envIrr(n)*ao;
  col += pool*(albedo*6.0 + 0.03)*ao;
  reflDEnv = reflect(rd, n);
  reflD = normalize(reflDEnv + rough*0.3*(rnd3 - 0.5));
  if(reflD.y < 0.0) reflD.y = -reflD.y;
  vec3 F = f0 + (1.0 - f0)*pow(1.0 - NoV, 5.0);
  reflW = F*mix(1.0, ao, 0.6)*1.4*fade;
  reflRough = rough;
  col += emis*ao;
  return col*fade;
}

void main(){
  vec2 fc = gl_FragCoord.xy + uJitter;
  vec2 uv = (2.0*fc - uRes)/uRes.y;
  vec3 rd = normalize(uCamRot*vec3(uv, uFocal));
  vec3 ro = uCamPos;
  float pixAng = 2.0/(uRes.y*uFocal);
  float fi = float(uFrame % 1024);
  float rnd = hash12(gl_FragCoord.xy + fi*vec2(37.1, 17.9));
  vec3 rnd3 = vec3(rnd, hash12(gl_FragCoord.yx*1.37 + fi*11.3), hash12(gl_FragCoord.xy*0.71 + fi*5.7 + 3.1));
  loadTops(rnd);

  // 一次レイと床の反射レイを同じループ本体で処理（全ルーチンを 1 箇所だけに展開 → コンパイル高速化）
  vec3 col = vec3(0.0), thr = vec3(1.0);
  vec3 cro = ro, crd = rd, crdEnv = rd;
  float tAcc = 0.0, reflRough = 0.2, depth = 500.0;
  int hid0 = -1;
  bool dyn = false;
  for(int bounce=ZERO; bounce<2; bounce++){
    bool prim = bounce == 0;
    // 反射は粗いコーンとして扱う（LOD と収束閾値を緩め、ちらつきを抑える）
    float pa = prim ? pixAng : pixAng*3.0;
    // ---- 1. 交差判定 ----
    float tA = -1.0, mA = 0.0;
    if(prim){
      if(uMode == 0) tA = traceArena(cro, crd, mA);
      else if(crd.y < 0.0) tA = (uFloorY - cro.y)/crd.y;
    }
    float tmax = tA > 0.0 ? tA : (prim ? 300.0 : 40.0);
    int baseIt = prim ? uIter : max(uIter-2, 4);
    int hid; vec4 trap; float mat; vec2 minD;
    float tT = marchTops(cro, crd, tmax, prim ? uSteps : uReflSteps, baseIt, pa, prim ? 0.5 : 1.0, hid, trap, mat, minD);
    int surf = hid >= 0 ? 0 : (tA > 0.0 ? 1 : 2);
    float tHit = surf == 0 ? tT : (surf == 1 ? tA : 500.0);
    if(prim){ depth = tHit; hid0 = hid; }
    vec3 p = cro + crd*tHit;

    // ---- 2. 法線 ----
    vec3 n = vec3(0.0,1.0,0.0), nl = n, q = vec3(0.0);
    int itTop = 4;
    if(surf == 0){
      float s = gT[hid].scale;
      q = gT[hid].irot*(p - gT[hid].pos);
      itTop = lodIter(baseIt, length(cro - gT[hid].pos), pa, s);
      nl = topNormal(gT[hid], q, max(1.2e-4*s, (tT + tAcc)*pa*0.6), itTop);
      n = transpose(gT[hid].irot)*nl;
      float nv = dot(n,-crd);
      if(nv < 0.02) n = normalize(n - crd*(0.02 - nv));
    } else if(surf == 1 && uMode == 0){
      n = arenaNormal(p, tA);
    }

    // ---- 3. ソフトシャドウ / 4. AO（一次レイのみ）----
    float sh = 1.0, aoT = prim ? 1.0 : 0.8;
    if(prim && surf < 2){
      float NoL = dot(n, uKeyDir);
      float sc = surf == 0 ? gT[hid].scale : 1.0;
      if(NoL > (surf == 0 ? -0.3 : 0.0))
        sh = shadowTops(p + n*(surf == 0 ? 0.012*sc : 0.01), uKeyDir, surf == 0 ? 14.0 : 10.0, max(uIter-3, 4), uShadowSteps);
      else sh = 0.0;
    }
    if(prim && surf == 0) aoT = topAO(gT[hid], q, nl, max(itTop-1, 4));

    // ---- 5. シェーディング ----
    vec3 c;
    vec3 reflD = vec3(0.0,1.0,0.0), reflDEnv = reflD, reflW = vec3(0.0);
    float fade = 1.0;
    if(surf == 0){
      c = shadeTopSurf(hid, p, n, q, crd, trap, mat, sh, aoT);
      if(prim) dyn = uTMisc[hid].w > 0.5;
    } else if(surf == 1){
      if(uMode == 0) c = shadeArena(p, n, crd, tA, mA, pixAng, rnd3, sh, reflD, reflDEnv, reflW, reflRough);
      else {
        c = shadeStudioFloor(p, crd, tA, pixAng, rnd3, sh, reflD, reflDEnv, reflW, reflRough, fade);
        c += studioBg(crd, uv)*(1.0 - fade);
      }
    } else if(prim){
      c = uMode==0 ? envBattle(crd, 0.0)*0.55 : studioBg(crd, uv);
    } else {
      c = uMode==0 ? envBattle(crdEnv, reflRough)*0.35 : envStudio(crdEnv, reflRough)*0.15;
    }
    // エネルギーオーラ（境界球の縁で 0 になるようフェード）
    for(int i=ZERO;i<2;i++){
      if(i>=uTopCount || i==hid || gT[i].alive<0.5) continue;
      vec3 oc = gT[i].pos - cro;
      float cl = length(oc - crd*dot(oc, crd))/(BOUND*gT[i].scale);
      float a = exp(-minD[i]*9.0)*uTMisc[i].z*smoothstep(0.98, 0.55, cl);
      c += uTGlow[i]*a*(0.22 + 1.3*uTDyn[i].w);
    }
    // 反射のファイアフライ抑制（ソフトクランプ）
    if(!prim) c = c/(1.0 + max(c.r, max(c.g, c.b))*0.35);
    col += thr*c;

    // ---- 6. 床なら反射レイへ ----
    if(prim && surf == 1 && max(reflW.x, max(reflW.y, reflW.z)) > 0.002){
      thr = reflW;
      cro = p + n*0.01; crd = reflD; crdEnv = reflDEnv; tAcc = tA;
      continue;
    }
    break;
  }
  int hid = hid0;
  if(uMode==0){
    float f = 1.0 - exp(-max(depth - 14.0, 0.0)*0.035);
    col = mix(col, vec3(0.005,0.007,0.012), f);
  }
  col = max(col, vec3(0.0));
  if(any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  // alpha: 静的 = +depth / コマ = -(depth + id*1000)  → TAA で剛体モーションベクトルに使用
  outColor = vec4(min(col, vec3(80.0)), dyn ? -(depth + float(hid)*1000.0) : depth);
}`;

  // ----------------------------------------------------------
  //  TAA
  // ----------------------------------------------------------
  const TAA_FS = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uCur;
uniform sampler2D uHist;
uniform vec2 uRes;
uniform mat3 uCamRot; uniform vec3 uCamPos; uniform float uFocal;
uniform mat3 uPrevCamRot; uniform vec3 uPrevCamPos;
uniform float uReset;
uniform float uStaticW;
uniform float uDynW;
uniform mat3 uTRot[2]; uniform vec3 uTPos[2];
uniform mat3 uPRot[2]; uniform vec3 uPPos[2];

vec3 toYCoCg(vec3 c){ return vec3(0.25*c.r+0.5*c.g+0.25*c.b, 0.5*c.r-0.5*c.b, -0.25*c.r+0.5*c.g-0.25*c.b); }
vec3 fromYCoCg(vec3 c){ return vec3(c.x+c.y-c.z, c.x+c.z, c.x-c.y-c.z); }
vec3 tm(vec3 c){ return c/(1.0+max(c.r,max(c.g,c.b))); }
vec3 itm(vec3 c){ return c/max(1.0-max(c.r,max(c.g,c.b)), 1e-4); }

vec3 sampleCatmull(sampler2D tex, vec2 uv, vec2 ts){
  vec2 sp = uv*ts;
  vec2 tp1 = floor(sp - 0.5) + 0.5;
  vec2 f = sp - tp1;
  vec2 w0 = f*(-0.5 + f*(1.0 - 0.5*f));
  vec2 w1 = 1.0 + f*f*(-2.5 + 1.5*f);
  vec2 w2 = f*(0.5 + f*(2.0 - 1.5*f));
  vec2 w3 = f*f*(-0.5 + 0.5*f);
  vec2 w12 = w1 + w2;
  vec2 o12 = w2/w12;
  vec2 tp0 = (tp1 - 1.0)/ts;
  vec2 tp3 = (tp1 + 2.0)/ts;
  vec2 tp12 = (tp1 + o12)/ts;
  vec3 r = vec3(0.0);
  r += texture(tex, vec2(tp12.x, tp0.y)).rgb*w12.x*w0.y;
  r += texture(tex, vec2(tp0.x, tp12.y)).rgb*w0.x*w12.y;
  r += texture(tex, vec2(tp12.x, tp12.y)).rgb*w12.x*w12.y;
  r += texture(tex, vec2(tp3.x, tp12.y)).rgb*w3.x*w12.y;
  r += texture(tex, vec2(tp12.x, tp3.y)).rgb*w12.x*w3.y;
  float ws = w12.x*w0.y + w0.x*w12.y + w12.x*w12.y + w3.x*w12.y + w12.x*w3.y;
  return max(r/ws, 0.0);
}

void main(){
  vec2 fc = gl_FragCoord.xy;
  ivec2 ip = ivec2(fc);
  vec4 cur = texelFetch(uCur, ip, 0);
  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  bool anyDyn = false;
  for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){
    vec4 s = texelFetch(uCur, clamp(ip+ivec2(x,y), ivec2(0), ivec2(uRes)-1), 0);
    vec3 c = toYCoCg(tm(s.rgb));
    m1 += c; m2 += c*c;
    anyDyn = anyDyn || s.a < 0.0;
  }
  m1 /= 9.0; m2 /= 9.0;
  vec3 sig = sqrt(max(m2 - m1*m1, 0.0));
  float gamma = anyDyn ? 1.0 : 1.4;
  vec3 mn = m1 - gamma*sig, mx = m1 + gamma*sig;

  float depth = cur.a;
  bool dyn = cur.a < 0.0;
  int id = -1;
  if(dyn){ float dd = -cur.a; id = dd >= 1000.0 ? 1 : 0; depth = dd - float(id)*1000.0; }
  vec2 ndc = (2.0*fc - uRes)/uRes.y;
  vec3 rd = normalize(uCamRot*vec3(ndc, uFocal));
  vec3 P = uCamPos + rd*depth;
  if(id >= 0){
    // 剛体変換による前フレーム位置（回転・傾き・移動を含む）
    vec3 l = transpose(uTRot[id])*(P - uTPos[id]);
    P = uPRot[id]*l + uPPos[id];
  }
  vec3 v = transpose(uPrevCamRot)*(P - uPrevCamPos);
  vec2 puv = v.xy/max(v.z,1e-4)*uFocal;
  vec2 pfc = (puv*uRes.y + uRes)*0.5;
  vec2 huv = pfc/uRes;
  bool valid = v.z > 0.0 && huv.x > 0.0 && huv.y > 0.0 && huv.x < 1.0 && huv.y < 1.0 && uReset < 0.5;
  vec3 res = cur.rgb;
  if(valid){
    vec3 hist = sampleCatmull(uHist, huv, uRes);
    vec3 hc = clamp(toYCoCg(tm(hist)), mn, mx);
    hist = itm(fromYCoCg(hc));
    float w = (dyn || anyDyn) ? uDynW : uStaticW;
    res = mix(hist, cur.rgb, w);
  }
  o = vec4(max(res, 0.0), cur.a);
}`;

  // ----------------------------------------------------------
  //  BLOOM
  // ----------------------------------------------------------
  const BRIGHT_FS = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uSrc;
uniform sampler2D uPart;
uniform vec2 uTexel;  // 1/srcSize
uniform float uThreshold;
void main(){
  vec2 uv = gl_FragCoord.xy*2.0*uTexel;
  vec3 c = vec3(0.0);
  c += texture(uSrc, uv + uTexel*vec2(-0.5,-0.5)).rgb + texture(uPart, uv + uTexel*vec2(-0.5,-0.5)).rgb;
  c += texture(uSrc, uv + uTexel*vec2( 0.5,-0.5)).rgb + texture(uPart, uv + uTexel*vec2( 0.5,-0.5)).rgb;
  c += texture(uSrc, uv + uTexel*vec2(-0.5, 0.5)).rgb + texture(uPart, uv + uTexel*vec2(-0.5, 0.5)).rgb;
  c += texture(uSrc, uv + uTexel*vec2( 0.5, 0.5)).rgb + texture(uPart, uv + uTexel*vec2( 0.5, 0.5)).rgb;
  c *= 0.25;
  float br = max(c.r, max(c.g, c.b));
  float knee = uThreshold*0.6;
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0*knee);
  soft = soft*soft/(4.0*knee + 1e-4);
  float contrib = max(soft, br - uThreshold)/max(br, 1e-4);
  o = vec4(min(c*contrib, vec3(200.0)), 1.0);
}`;

  const DOWN_FS = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel; // 1/srcSize
void main(){
  vec2 uv = gl_FragCoord.xy*2.0*uTexel;
  vec2 hp = uTexel;
  vec3 s = texture(uSrc, uv).rgb*4.0;
  s += texture(uSrc, uv - hp).rgb;
  s += texture(uSrc, uv + hp).rgb;
  s += texture(uSrc, uv + vec2(hp.x,-hp.y)).rgb;
  s += texture(uSrc, uv - vec2(hp.x,-hp.y)).rgb;
  o = vec4(s/8.0, 1.0);
}`;

  const UP_FS = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel;   // 1/srcSize (smaller level)
uniform vec2 uDstSize;
uniform float uWeight;
void main(){
  vec2 uv = gl_FragCoord.xy/uDstSize;
  vec2 hp = uTexel*0.5;
  vec3 s = vec3(0.0);
  s += texture(uSrc, uv + vec2(-hp.x*2.0, 0.0)).rgb;
  s += texture(uSrc, uv + vec2(-hp.x, hp.y)).rgb*2.0;
  s += texture(uSrc, uv + vec2(0.0, hp.y*2.0)).rgb;
  s += texture(uSrc, uv + vec2(hp.x, hp.y)).rgb*2.0;
  s += texture(uSrc, uv + vec2(hp.x*2.0, 0.0)).rgb;
  s += texture(uSrc, uv + vec2(hp.x, -hp.y)).rgb*2.0;
  s += texture(uSrc, uv + vec2(0.0, -hp.y*2.0)).rgb;
  s += texture(uSrc, uv + vec2(-hp.x, -hp.y)).rgb*2.0;
  o = vec4(s/12.0*uWeight, 1.0);
}`;

  // ----------------------------------------------------------
  //  COMPOSITE
  // ----------------------------------------------------------
  const COMPOSITE_FS = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uHdr;
uniform sampler2D uPart;
uniform sampler2D uBloom;
uniform vec2 uOutRes;
uniform vec2 uSrcTexel;
uniform float uExposure;
uniform float uBloomStr;
uniform float uTime;
uniform float uCA;
uniform float uFlash;
uniform float uVignette;
uniform float uSharpen;
uniform float uSat;

vec3 hdrAt(vec2 uv){ return texture(uHdr, uv).rgb + texture(uPart, uv).rgb; }
vec3 aces(vec3 x){
  const float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }

void main(){
  vec2 uv = gl_FragCoord.xy/uOutRes;
  vec2 d = uv - 0.5;
  float r2 = dot(d,d);
  vec2 off = d*uCA*r2;
  vec3 c;
  c.r = hdrAt(uv - off).r;
  c.g = hdrAt(uv).g;
  c.b = hdrAt(uv + off).b;
  // シャープン（TAAのボケを補正）
  vec3 nb = hdrAt(uv + vec2(uSrcTexel.x,0.0)) + hdrAt(uv - vec2(uSrcTexel.x,0.0)) + hdrAt(uv + vec2(0.0,uSrcTexel.y)) + hdrAt(uv - vec2(0.0,uSrcTexel.y));
  vec3 lc = c/(1.0+c), ln = (nb*0.25)/(1.0+nb*0.25);
  vec3 sh = clamp(lc + (lc - ln)*uSharpen, 0.0, 0.999);
  c = sh/(1.0 - sh);
  vec3 bl = texture(uBloom, uv).rgb;
  c += bl*uBloomStr;
  c *= uExposure;
  c = aces(c);
  float l = dot(c, vec3(0.2126,0.7152,0.0722));
  c = max(mix(vec3(l), c, uSat), 0.0);
  c *= mix(1.0, smoothstep(0.95, 0.15, length(d*vec2(1.0, 0.85))*1.15), uVignette);
  c = pow(c, vec3(1.0/2.2));
  c += (hash12(gl_FragCoord.xy + fract(uTime)*731.0) - 0.5)*0.022;
  c = mix(c, vec3(1.0), uFlash);
  o = vec4(c, 1.0);
}`;

  // ----------------------------------------------------------
  //  PARTICLES (火花)
  // ----------------------------------------------------------
  const PART_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aA;
layout(location=1) in vec3 aB;
layout(location=2) in vec2 aCorner;
layout(location=3) in vec4 aCol;
uniform mat3 uCamRot; uniform vec3 uCamPos; uniform float uFocal; uniform vec2 uRes;
out vec4 vCol; out vec2 vUV; out float vDist;
vec3 proj(vec3 P){ vec3 v = transpose(uCamRot)*(P - uCamPos); return vec3(v.xy/max(v.z,1e-3)*uFocal, v.z); }
void main(){
  vec3 a = proj(aA), b = proj(aB);
  if(a.z < 0.1 || b.z < 0.1){ gl_Position = vec4(3.0,3.0,3.0,1.0); vCol = vec4(0.0); return; }
  vec2 dir = b.xy - a.xy; float len = length(dir);
  dir = len > 1e-6 ? dir/len : vec2(1.0,0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float w = max(aCol.a/a.z*uFocal, 2.2/uRes.y);
  vec2 base = mix(a.xy, b.xy, aCorner.x) + dir*w*(aCorner.x*2.0 - 1.0);
  vec2 pos = base + nrm*w*aCorner.y;
  gl_Position = vec4(pos.x*uRes.y/uRes.x, pos.y, 0.0, 1.0);
  vCol = vec4(aCol.rgb, 1.0);
  vUV = aCorner;
  vDist = mix(length(aA - uCamPos), length(aB - uCamPos), aCorner.x);
}`;
  const PART_FS = `#version 300 es
precision highp float;
in vec4 vCol; in vec2 vUV; in float vDist;
uniform sampler2D uDepth;
out vec4 o;
void main(){
  float a = texelFetch(uDepth, ivec2(gl_FragCoord.xy), 0).a;
  float sd = a >= 0.0 ? a : (-a >= 1000.0 ? -a - 1000.0 : -a);
  if(vDist > sd + 0.08) discard;
  float f = exp(-vUV.y*vUV.y*3.5);
  float along = mix(1.0, 0.25, vUV.x);
  o = vec4(vCol.rgb*f*along, 1.0);
}`;

  global.Shaders = { FULLSCREEN_VS, SCENE_FS, TAA_FS, BRIGHT_FS, DOWN_FS, UP_FS, COMPOSITE_FS, PART_VS, PART_FS };
})(window);
