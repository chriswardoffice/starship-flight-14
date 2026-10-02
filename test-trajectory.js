import {
  LAUNCH,
  EARTH_RADIUS_KM,
  INCLINATION_DEG,
  ORBIT_ALT_KM,
  gmstRad,
  eciToThree,
  threeToEci,
  latLonToLocal,
  eciToLatLon,
  getMissions,
  sampleAt,
} from "./trajectory.js";

const DEG = 180 / Math.PI;
let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL:", msg);
  }
}
function near(a, b, tol, msg) {
  assert(Math.abs(a - b) <= tol, `${msg} (${a} vs ${b}, tol ${tol})`);
}

function rotY(v, g) {
  const c = Math.cos(g);
  const s = Math.sin(g);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

const { flown, planned, orbit } = getMissions();

// Pad at liftoff sits on the published coordinates, and the mesh frame
// round-trips through the same rotation the globe uses.
const pad = flown.samples[0];
const ll0 = eciToLatLon(pad.eci, LAUNCH.timeMs);
near(ll0.lat * DEG, LAUNCH.lat, 0.05, "liftoff latitude");
near(ll0.lon * DEG, LAUNCH.lon, 0.05, "liftoff longitude");
near(Math.hypot(...pad.eci), EARTH_RADIUS_KM, 1, "liftoff radius");

const g0 = gmstRad(LAUNCH.timeMs);
const local = latLonToLocal(ll0.lat, ll0.lon, EARTH_RADIUS_KM);
const world = rotY(local, g0);
const three = eciToThree(pad.eci);
for (let k = 0; k < 3; k++) near(world[k], three[k], 0.05, `frame axis ${k}`);
const back = threeToEci(three);
for (let k = 0; k < 3; k++) near(back[k], pad.eci[k], 1e-6, `eci roundtrip ${k}`);

// Cross-product check: ECI X × Y = Z maps to three +Y.
const x = eciToThree([1, 0, 0]);
const y = eciToThree([0, 1, 0]);
const z = eciToThree([0, 0, 1]);
const cross = [
  x[1] * y[2] - x[2] * y[1],
  x[2] * y[0] - x[0] * y[2],
  x[0] * y[1] - x[1] * y[0],
];
near(cross[0], z[0], 1e-9, "frame cross x");
near(cross[1], z[1], 1e-9, "frame cross y");
near(cross[2], z[2], 1e-9, "frame cross z");

function report(m) {
  const at = (t) => sampleAt(m, t);
  const row = (label, t) => {
    const s = at(t);
    const ll = eciToLatLon(s.eci, LAUNCH.timeMs + t * 1000);
    const alt = Math.hypot(...s.eci) - EARTH_RADIUS_KM;
    const spd = Math.hypot(...s.v);
    console.log(
      `${m.id.padEnd(8)} ${label.padEnd(16)} alt ${alt.toFixed(1).padStart(7)}  ` +
        `${(spd).toFixed(2).padStart(5)} km/s  ` +
        `${((ll.lat * 180) / Math.PI).toFixed(1).padStart(6)}° ${((ll.lon * 180) / Math.PI).toFixed(1).padStart(7)}°  ` +
        `laps ${s.laps.toFixed(2)}  ${s.phase}`
    );
    return { alt, spd, lat: (ll.lat * 180) / Math.PI, lon: (ll.lon * 180) / Math.PI, s };
  };
  console.log(`\n${m.title}  dv ${(m.dv * 1000).toFixed(0)} m/s  entry T+${m.entryT}s`);
  const a = row("liftoff", 0);
  const b = row("T+3 min", 180);
  const c = row("SECO", 491);
  const d = row("insertion", 25 * 60 + 47);
  row("T+90 min", 90 * 60);
  row("deorbit", m.id === "flown" ? 2 * 3600 + 12 * 60 : 8 * 3600 + 52 * 60 + 37);
  row("splash", m.duration);
  return { a, b, c, d };
}

const f = report(flown);
const p = report(planned);

assert(f.b.lon > f.a.lon, "ship flies east, not west");
assert(f.b.lat < f.a.lat + 1, "southeast heading does not climb in latitude");
assert(f.c.alt > 120 && f.c.alt < 240, "SECO altitude");
assert(f.d.alt > 250 && f.d.alt < 290, "insertion altitude");
near(f.d.spd, Math.sqrt(398600.4418 / (EARTH_RADIUS_KM + ORBIT_ALT_KM)), 0.05, "circular speed");

// Inclination from angular momentum after insertion.
const ins = sampleAt(flown, 26 * 60);
const r = ins.eci;
const v = ins.v;
const h = [
  r[1] * v[2] - r[2] * v[1],
  r[2] * v[0] - r[0] * v[2],
  r[0] * v[1] - r[1] * v[0],
];
const inc = Math.acos(h[2] / Math.hypot(...h)) * DEG;
near(inc, INCLINATION_DEG, 0.05, "inclination");

assert(flown.splash.laps > 1.05 && flown.splash.laps < 2.4, `flown laps ${flown.splash.laps}`);
assert(planned.splash.laps > 5.3 && planned.splash.laps < 7.2, `planned laps ${planned.splash.laps}`);
assert(planned.splash.lat < -15, `planned splash should be well south, got ${planned.splash.lat}`);
assert(flown.splash.lat > 5, `flown splash should be northern, got ${flown.splash.lat}`);

let minAlt = Infinity;
let maxStep = 0;
for (const m of [flown, planned]) {
  for (let i = 0; i < m.samples.length; i++) {
    const s = m.samples[i];
    for (const n of [...s.eci, ...s.v, s.u, s.laps]) assert(Number.isFinite(n), "finite");
    const alt = Math.hypot(...s.eci) - EARTH_RADIUS_KM;
    if (alt < minAlt) minAlt = alt;
    assert(alt > -0.5, `${m.id} altitude ${alt.toFixed(2)} at t=${s.t}`);
    if (i > 0) {
      const p0 = m.samples[i - 1].eci;
      const jump = Math.hypot(s.eci[0] - p0[0], s.eci[1] - p0[1], s.eci[2] - p0[2]);
      if (jump > maxStep) maxStep = jump;
      assert(jump < 80, `${m.id} position jump ${jump.toFixed(1)} km at t=${s.t}`);
    }
  }
}

// Ship actually moves.
const moved = Math.hypot(
  ...sampleAt(flown, 600).eci.map((v, i) => v - flown.samples[0].eci[i])
);
assert(moved > 500, "ship moves");

console.log(`\nmin alt ${minAlt.toFixed(2)} km, max step ${maxStep.toFixed(1)} km`);
console.log(`azimuth ${orbit.azimuthDeg.toFixed(2)}°`);
console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
