// Starship Flight 14 route reconstruction.
//
// Frame (one convention, used everywhere):
//   ECI  +X  vernal equinox, +Y  90° east of that, +Z  north. Right-handed.
//   Three.js world: (x, y, z) = (ECI.x, ECI.z, -ECI.y), so +Y is north.
//   Check: ECI X × Y = Z maps to three (1,0,0) × (0,0,-1) = (0,1,0).
//
// The orbit is Keplerian from the post-flight elements (about 262 × 275 km,
// 30.5°). Ascent is a smooth guided curve that leaves the pad and meets the
// published SECO state. This is not SpaceX telemetry.

export const EARTH_RADIUS_KM = 6371;
export const MU = 398600.4418;
export const OMEGA_EARTH = 7.292115e-5;

export const LAUNCH = {
  name: "Starbase OLP-2",
  lat: 25.99677,
  lon: -97.15799,
  timeMs: Date.UTC(2026, 8, 28, 12, 48, 59),
};

export const INCLINATION_DEG = 30.5;
export const ORBIT_ALT_KM = 270;

const DEG = Math.PI / 180;
const R = EARTH_RADIUS_KM;

const T_SECO = 8 * 60 + 11;
const T_INS0 = 25 * 60 + 28;
const T_INS1 = 25 * 60 + 47;
const T_DEPLOY0 = 34 * 60 + 18;
const T_DEPLOY1 = 1 * 3600 + 4 * 60 + 50;

const PROFILES = {
  flown: {
    id: "flown",
    title: "What flew",
    deorbit: 2 * 3600 + 12 * 60,
    // Webcast-aligned: plasma ~32 min after the deorbit burn, splash at 3 h 08 m.
    // The often-quoted "six orbits" was the plan that got called off.
    entryDelay: 32 * 60,
    splash: 3 * 3600 + 8 * 60 + 30,
  },
  planned: {
    id: "planned",
    title: "The six-orbit plan",
    deorbit: 8 * 3600 + 52 * 60 + 37,
    entryDelay: 36 * 60 + 15,
    splash: 9 * 3600 + 50 * 60 + 30,
  },
};

const DT = 5;

export function gmstRad(unixMs) {
  const jd = unixMs / 86400000 + 2440587.5;
  const d = jd - 2451545.0;
  const T = d / 36525;
  let deg =
    280.46061837 +
    360.98564736629 * d +
    0.000387933 * T * T -
    (T * T * T) / 38710000;
  deg = ((deg % 360) + 360) % 360;
  return deg * DEG;
}

export function eciToThree(e) {
  return [e[0], e[2], -e[1]];
}

export function threeToEci(t) {
  return [t[0], -t[2], t[1]];
}

// SphereGeometry local position: u = 0 is longitude -180°. Lat/lon in radians.
export function latLonToLocal(lat, lon, radius) {
  const phi = lon + Math.PI;
  const cl = Math.cos(lat);
  return [
    -radius * Math.cos(phi) * cl,
    radius * Math.sin(lat),
    radius * Math.sin(phi) * cl,
  ];
}

export function eciToLatLon(eci, unixMs) {
  const g = gmstRad(unixMs);
  let lon = Math.atan2(eci[1], eci[0]) - g;
  lon = Math.atan2(Math.sin(lon), Math.cos(lon));
  const lat = Math.atan2(eci[2], Math.hypot(eci[0], eci[1]));
  return { lat, lon };
}

export function sunEci(unixMs) {
  const yearStart = Date.UTC(new Date(unixMs).getUTCFullYear(), 0, 0);
  const doy = (unixMs - yearStart) / 86400000;
  const decl = -23.44 * DEG * Math.cos(((360 / 365) * (doy + 10) * Math.PI) / 180);
  const date = new Date(unixMs);
  const hours =
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const subLon = -15 * (hours - 12) * DEG;
  const alpha = gmstRad(unixMs) + subLon;
  return [
    Math.cos(decl) * Math.cos(alpha),
    Math.cos(decl) * Math.sin(alpha),
    Math.sin(decl),
  ];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function mag(a) {
  return Math.hypot(a[0], a[1], a[2]);
}
function norm(a) {
  return scale(a, 1 / mag(a));
}
function lerp(a, b, f) {
  return a.map((v, i) => v + (b[i] - v) * f);
}
function smoothstep(s) {
  const x = Math.min(1, Math.max(0, s));
  return x * x * (3 - 2 * x);
}

function eccFromTrue(nu, e) {
  return Math.atan2(Math.sqrt(1 - e * e) * Math.sin(nu), e + Math.cos(nu));
}
function timeFromPeri(nu, a, e) {
  let E = eccFromTrue(nu, e);
  if (E < 0) E += 2 * Math.PI;
  const n = Math.sqrt(MU / (a * a * a));
  return (E - e * Math.sin(E)) / n;
}
function trueFromTime(t, a, e) {
  const n = Math.sqrt(MU / (a * a * a));
  const M = n * t;
  let E = M;
  for (let k = 0; k < 14; k++) E = M + e * Math.sin(E);
  return (
    2 *
    Math.atan2(
      Math.sqrt(1 + e) * Math.sin(E / 2),
      Math.sqrt(1 - e) * Math.cos(E / 2)
    )
  );
}

function solveOrbit() {
  const i = INCLINATION_DEG * DEG;
  const lat = LAUNCH.lat * DEG;
  const lon = LAUNCH.lon * DEG;
  const g0 = gmstRad(LAUNCH.timeMs);
  const ra = g0 + lon;
  const sinAz = Math.min(1, Math.cos(i) / Math.cos(lat));
  // Southeast heading (Starbase flies over the Gulf, not inland).
  const azimuth = Math.PI - Math.asin(sinAz);
  const uPad = Math.PI - Math.asin(Math.sin(lat) / Math.sin(i));

  const perifocal = (u) => {
    const cu = Math.cos(u);
    const su = Math.sin(u);
    return [cu, su * Math.cos(i), su * Math.sin(i)];
  };
  const node = perifocal(uPad);
  const omegaNode =
    Math.atan2(Math.cos(lat) * Math.sin(ra), Math.cos(lat) * Math.cos(ra)) -
    Math.atan2(node[1], node[0]);

  const eciFromU = (u, radius) => {
    const p = perifocal(u);
    const c = Math.cos(omegaNode);
    const s = Math.sin(omegaNode);
    return [
      (c * p[0] - s * p[1]) * radius,
      (s * p[0] + c * p[1]) * radius,
      p[2] * radius,
    ];
  };
  const alongHat = (u) => {
    const du = 1e-4;
    return norm(eciFromU(u + du, 1).map((v, k) => v - eciFromU(u, 1)[k]));
  };

  // Suborbital coast: apogee at the insertion burn, SECO one coast earlier.
  const raKm = R + ORBIT_ALT_KM;
  const coast = T_INS0 - T_SECO;
  let best = null;
  for (let rp = 6300; rp <= 6520; rp += 2) {
    const a = (raKm + rp) / 2;
    const e = (raKm - rp) / (raKm + rp);
    const tAp = timeFromPeri(Math.PI, a, e);
    let lo = 0.4;
    let hi = Math.PI - 0.02;
    for (let k = 0; k < 48; k++) {
      const mid = (lo + hi) / 2;
      const dt = tAp - timeFromPeri(mid, a, e);
      if (dt > coast) lo = mid;
      else hi = mid;
    }
    const nu = (lo + hi) / 2;
    const p = a * (1 - e * e);
    const rNu = p / (1 + e * Math.cos(nu));
    const alt = rNu - R;
    const err = Math.abs(alt - 175);
    if (!best || err < best.err) {
      best = { rp, a, e, nu, alt, err, tAp };
    }
  }

  const { a: aCoast, e: eCoast, nu: nuSeco } = best;
  const pCoast = aCoast * (1 - eCoast * eCoast);
  const rSeco = pCoast / (1 + eCoast * Math.cos(nuSeco));
  const hCoast = Math.sqrt(MU * pCoast);
  const vrSeco = (MU / hCoast) * eCoast * Math.sin(nuSeco);
  const vtSeco = (MU / hCoast) * (1 + eCoast * Math.cos(nuSeco));
  // Pick the downrange angle so the geometric ascent arrives near this speed.
  const duAscent = (vtSeco * T_SECO) / (1.75 * rSeco);
  const uSeco = uPad + duAscent;
  const argPeri = uSeco - nuSeco;
  const tSecoPeri = timeFromPeri(nuSeco, aCoast, eCoast);

  const coastState = (t) => {
    const nu = trueFromTime(tSecoPeri + (t - T_SECO), aCoast, eCoast);
    const rMag = pCoast / (1 + eCoast * Math.cos(nu));
    const u = argPeri + nu;
    const rHat = norm(eciFromU(u, 1));
    const tHat = alongHat(u);
    const vr = (MU / hCoast) * eCoast * Math.sin(nu);
    const vt = (MU / hCoast) * (1 + eCoast * Math.cos(nu));
    return {
      eci: scale(rHat, rMag),
      v: add(scale(rHat, vr), scale(tHat, vt)),
      u,
      alt: rMag - R,
    };
  };

  const seco = coastState(T_SECO);
  const uBlend = 50;
  const ascentRaw = (t) => {
    const s = Math.min(1, Math.max(0, t / T_SECO));
    const su = s ** 1.75;
    const sa = s ** 1.35;
    const u = uPad + duAscent * su;
    const rMag = R + (rSeco - R) * sa;
    const duDt = (duAscent * 1.75 * s ** 0.75) / T_SECO;
    const drDt = ((rSeco - R) * 1.35 * (s === 0 ? 0 : s ** 0.35)) / T_SECO;
    const rHat = norm(eciFromU(u, 1));
    const tHat = alongHat(u);
    return {
      eci: scale(rHat, rMag),
      v: add(scale(rHat, drDt), scale(tHat, duDt * rMag)),
      u,
    };
  };
  const ascentState = (t) => {
    if (t >= T_SECO - uBlend) {
      const f = smoothstep((t - (T_SECO - uBlend)) / uBlend);
      const a = ascentRaw(T_SECO - uBlend);
      return {
        eci: lerp(a.eci, seco.eci, f),
        v: lerp(a.v, seco.v, f),
        u: a.u + (seco.u - a.u) * f,
      };
    }
    return ascentRaw(t);
  };

  const rOrb = raKm;
  const vCirc = Math.sqrt(MU / rOrb);
  const nOrb = Math.sqrt(MU / (rOrb * rOrb * rOrb));
  const uAp = argPeri + Math.PI;

  const orbitState = (t) => {
    const u = uAp + nOrb * (t - T_INS0);
    const rHat = norm(eciFromU(u, 1));
    const tHat = alongHat(u);
    let speed = vCirc;
    if (t < T_INS1) {
      const f = (t - T_INS0) / (T_INS1 - T_INS0);
      const vAp = mag(coastState(T_INS0).v);
      speed = vAp + (vCirc - vAp) * f;
    }
    return {
      eci: scale(rHat, rOrb),
      v: scale(tHat, speed),
      u,
    };
  };

  const nodeVec = norm(eciFromU(0, 1));
  const normal = norm(cross(nodeVec, alongHat(0)));

  return {
    i,
    azimuth,
    uPad,
    omegaNode,
    eciFromU,
    alongHat,
    ascentState,
    coastState,
    orbitState,
    nodeVec,
    normal,
    rOrb,
    vCirc,
    nOrb,
    uAp,
    secoAlt: rSeco - R,
    duAscent,
  };
}

const ORBIT = solveOrbit();

function gravity(r) {
  const r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
  const inv = -MU / (r2 * Math.sqrt(r2));
  return [r[0] * inv, r[1] * inv, r[2] * inv];
}

function rk4(r, v, dt) {
  const a1 = gravity(r);
  const r2 = add(r, scale(v, dt / 2));
  const v2 = add(v, scale(a1, dt / 2));
  const a2 = gravity(r2);
  const r3 = add(r, scale(v2, dt / 2));
  const v3 = add(v, scale(a2, dt / 2));
  const a3 = gravity(r3);
  const r4 = add(r, scale(v3, dt));
  const v4 = add(v, scale(a3, dt));
  const a4 = gravity(r4);
  const dr = scale(
    add(add(v, scale(v2, 2)), add(scale(v3, 2), v4)),
    dt / 6
  );
  const dv = scale(
    add(add(a1, scale(a2, 2)), add(scale(a3, 2), a4)),
    dt / 6
  );
  return [add(r, dr), add(v, dv)];
}

function argumentOf(eci) {
  const radial = norm(eci);
  const x = dot(radial, ORBIT.nodeVec);
  const y = dot(radial, ORBIT.alongHat(0));
  let u = Math.atan2(y, x);
  if (u < 0) u += 2 * Math.PI;
  return u;
}

function coastToEntry(dv, deorbit, limit) {
  const atBurn = ORBIT.orbitState(deorbit);
  let r = atBurn.eci.slice();
  let v = scale(norm(atBurn.v), mag(atBurn.v) - dv);
  let t = deorbit;
  const step = 1;
  while (t < limit) {
    const alt = mag(r) - R;
    if (alt <= 100) return { t, r, v, alt };
    [r, v] = rk4(r, v, step);
    t += step;
  }
  return null;
}

function pickDeltaV(profile) {
  const target = profile.deorbit + profile.entryDelay;
  let lo = 0.03;
  let hi = 0.45;
  let best = null;
  for (let k = 0; k < 18; k++) {
    const mid = (lo + hi) / 2;
    const hit = coastToEntry(mid, profile.deorbit, profile.splash);
    if (!hit) {
      lo = mid;
      continue;
    }
    best = { dv: mid, ...hit };
    if (hit.t > target) lo = mid;
    else hi = mid;
  }
  if (!best) {
    const fallback = coastToEntry(0.4, profile.deorbit, profile.splash + 3600);
    if (!fallback) throw new Error("deorbit never reaches the atmosphere");
    return { dv: 0.4, ...fallback };
  }
  return best;
}

function phaseFor(t, profile, entryT) {
  if (t < T_SECO) return "ascent";
  if (t < T_INS0) return "coast";
  if (t < T_INS1) return "insertion";
  if (t < T_DEPLOY1 && t >= T_DEPLOY0) return "deploy";
  if (t < profile.deorbit) return "orbit";
  if (t < entryT) return "deorbit";
  return "entry";
}

function pushSample(samples, t, eci, v, u, phase) {
  const laps = (u - ORBIT.uPad) / (2 * Math.PI);
  samples.push({
    t,
    eci,
    v,
    u,
    phase,
    rev: Math.max(0, Math.floor(laps + 1e-9)),
    laps,
  });
}

function buildOne(profile) {
  const burn = pickDeltaV(profile);
  const samples = [];
  let uTrack = ORBIT.uPad;

  const adoptU = (uRaw) => {
    let u = uRaw;
    while (u < uTrack - Math.PI) u += 2 * Math.PI;
    while (u > uTrack + Math.PI) u -= 2 * Math.PI;
    uTrack = u;
    return u;
  };

  for (let t = 0; t <= profile.deorbit; t += DT) {
    let s;
    if (t < T_SECO) s = ORBIT.ascentState(t);
    else if (t < T_INS0) s = ORBIT.coastState(t);
    else s = ORBIT.orbitState(t);
    pushSample(samples, t, s.eci, s.v, adoptU(s.u), phaseFor(t, profile, burn.t));
  }

  // Deorbit coast, 1 s steps collapsed onto the 5 s grid.
  let r = ORBIT.orbitState(profile.deorbit).eci.slice();
  let v = scale(
    norm(ORBIT.orbitState(profile.deorbit).v),
    mag(ORBIT.orbitState(profile.deorbit).v) - burn.dv
  );
  let t = profile.deorbit;
  const entryT = burn.t;
  while (t < entryT - 1e-6) {
    const next = Math.min(entryT, t + DT);
    const span = next - t;
    const sub = span > 2 ? 1 : span;
    let left = span;
    while (left > 1e-8) {
      const h = Math.min(sub, left);
      [r, v] = rk4(r, v, h);
      left -= h;
    }
    t = next;
    pushSample(
      samples,
      t,
      r.slice(),
      v.slice(),
      adoptU(argumentOf(r)),
      "deorbit"
    );
  }

  const entry = samples[samples.length - 1];
  const uEntry = entry.u;
  const vEntry = mag(entry.v);
  const entrySpan = Math.max(30, profile.splash - entry.t);
  for (let t = entry.t + DT; t <= profile.splash + 1e-6; t += DT) {
    const s = Math.min(1, (t - entry.t) / entrySpan);
    const alt = 100 * (1 - s) ** 1.7;
    const speed = Math.max(0.08, vEntry * (1 - s) ** 0.62);
    const u = uEntry + ((vEntry * entrySpan) / (R + 40)) * (1 - (1 - s) ** 1.62) / 1.62;
    // Integral of vEntry*(1-s)^0.62 is not exactly that. Integrate the angle
    // from the same speed law so position and speed agree.
    const rMag = R + alt;
    const rHat = norm(ORBIT.eciFromU(u, 1));
    const tHat = ORBIT.alongHat(u);
    const gamma = -0.18 * s;
    const vr = -speed * Math.sin(Math.max(0, -gamma));
    const vt = speed * Math.cos(Math.max(0, -gamma));
    pushSample(
      samples,
      Math.min(t, profile.splash),
      scale(rHat, rMag),
      add(scale(rHat, vr), scale(tHat, vt)),
      u,
      "entry"
    );
    uTrack = u;
  }

  // Recompute the entry arc with an integrated angle so it is continuous
  // with the deorbit state and reaches the surface at splash.
  const entryStart = samples.findIndex((s) => s.phase === "entry");
  if (entryStart > 0) {
    let u = samples[entryStart - 1].u;
    const t0 = samples[entryStart - 1].t;
    const v0 = mag(samples[entryStart - 1].v);
    for (let i = entryStart; i < samples.length; i++) {
      const s = samples[i];
      const prevT = i === entryStart ? t0 : samples[i - 1].t;
      const f = Math.min(1, (s.t - t0) / entrySpan);
      const alt = 100 * (1 - f) ** 1.7;
      const speed = Math.max(0.05, v0 * (1 - f) ** 0.62);
      u += (speed * (s.t - prevT)) / (R + alt);
      const rMag = R + alt;
      const rHat = norm(ORBIT.eciFromU(u, 1));
      const tHat = ORBIT.alongHat(u);
      s.eci = scale(rHat, rMag);
      s.v = scale(tHat, speed);
      s.u = u;
      s.laps = (u - ORBIT.uPad) / (2 * Math.PI);
      s.rev = Math.max(0, Math.floor(s.laps + 1e-9));
    }
  }

  const last = samples[samples.length - 1];
  const splashLl = eciToLatLon(last.eci, LAUNCH.timeMs + last.t * 1000);
  const deorbitLl = eciToLatLon(
    ORBIT.orbitState(profile.deorbit).eci,
    LAUNCH.timeMs + profile.deorbit * 1000
  );

  const events = [
    { t: 0, label: "Liftoff" },
    { t: 2 * 60 + 22, label: "Hot staging" },
    { t: T_SECO, label: "Ship engine cutoff" },
    { t: T_INS0, label: "Orbital insertion" },
    { t: T_DEPLOY0, label: "Starlink deploy" },
    { t: profile.deorbit, label: "Deorbit burn" },
    { t: entryT, label: "Entry interface" },
    { t: profile.splash, label: "Splashdown" },
  ];

  return {
    id: profile.id,
    title: profile.title,
    duration: profile.splash,
    samples,
    events,
    dv: burn.dv,
    entryT,
    normal: ORBIT.normal,
    rOrb: ORBIT.rOrb,
    splash: {
      lat: (splashLl.lat * 180) / Math.PI,
      lon: (splashLl.lon * 180) / Math.PI,
      laps: last.laps,
    },
    deorbit: {
      lat: (deorbitLl.lat * 180) / Math.PI,
      lon: (deorbitLl.lon * 180) / Math.PI,
    },
    secoAlt: ORBIT.secoAlt,
  };
}

let CACHE = null;
export function getMissions() {
  if (!CACHE) {
    CACHE = {
      flown: buildOne(PROFILES.flown),
      planned: buildOne(PROFILES.planned),
      orbit: {
        normal: ORBIT.normal,
        rOrb: ORBIT.rOrb,
        azimuthDeg: ORBIT.azimuth / DEG,
        uPad: ORBIT.uPad,
      },
    };
  }
  return CACHE;
}

export function sampleAt(mission, t) {
  const s = mission.samples;
  if (t <= s[0].t) return s[0];
  const last = s[s.length - 1];
  if (t >= last.t) return last;
  const step = s[1].t - s[0].t;
  let i = Math.floor(t / step);
  if (i >= s.length - 1) i = s.length - 2;
  while (s[i + 1] && s[i + 1].t < t) i++;
  while (i > 0 && s[i].t > t) i--;
  const a = s[i];
  const b = s[i + 1];
  const f = (t - a.t) / (b.t - a.t);
  return {
    t,
    eci: lerp(a.eci, b.eci, f),
    v: lerp(a.v, b.v, f),
    u: a.u + (b.u - a.u) * f,
    phase: f < 0.5 ? a.phase : b.phase,
    rev: a.rev,
    laps: a.laps + (b.laps - a.laps) * f,
  };
}

export function formatMET(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function formatClock(met) {
  const d = new Date(LAUNCH.timeMs + met * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss} UTC`;
}

export { DT, ORBIT };
