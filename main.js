import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import {
  EARTH_RADIUS_KM,
  LAUNCH,
  eciToThree,
  eciToLatLon,
  latLonToLocal,
  gmstRad,
  sunEci,
  getMissions,
  sampleAt,
  formatMET,
  formatClock,
} from "./trajectory.js";

// World frame matches trajectory.js: three +Y is north, earth.rotation.y = GMST.
// Ship nose is local +Y (cylinder / cone axis), aimed with setFromUnitVectors.

const WORLD_R = 5;
const TEX = "https://unpkg.com/three-globe@2.31.1/example/img/";

const PHASES = {
  ascent: "Ascent",
  coast: "Coasting to orbit",
  insertion: "Orbital insertion burn",
  deploy: "Deploying Starlink",
  orbit: "On orbit",
  deorbit: "Leaving orbit",
  entry: "Reentry",
};

const PHASE_COLOR = {
  ascent: [1.0, 0.69, 0.13],
  coast: [1.0, 0.82, 0.45],
  insertion: [1.0, 0.97, 0.9],
  deploy: [0.49, 0.88, 1.0],
  orbit: [0.49, 0.88, 1.0],
  deorbit: [1.0, 0.54, 0.36],
  entry: [1.0, 0.32, 0.24],
};

const LAP_COLORS = [0x7ee0ff, 0x6aa4ff, 0xc084fc, 0xff7ad9, 0xffb020, 0x7dffb3, 0xff6b4a];

const NOSE = new THREE.Vector3(0, 1, 0);
const UP = new THREE.Vector3(0, 1, 0);

const missions = getMissions();

addEventListener("error", (event) => {
  const banner = document.createElement("pre");
  banner.id = "err";
  banner.textContent = `${event.message}\n${event.filename || ""}:${event.lineno || ""}`;
  banner.style.cssText =
    "position:fixed;left:24px;bottom:200px;z-index:9;max-width:50vw;white-space:pre-wrap;background:#3a1010;color:#ffd0d0;padding:10px 12px;border-radius:10px;";
  document.body.appendChild(banner);
});

const state = {
  mode: "flown",
  met: 0,
  playing: true,
  speed: 300,
  exag: 7,
  follow: false,
  ghost: false,
};

const $ = (id) => document.getElementById(id);
const viewport = $("viewport");
const labelLayer = $("labels");

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x070a10);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.05, 400);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 5.35;
controls.maxDistance = 48;
controls.target.set(0, 0, 0);

scene.add(new THREE.AmbientLight(0x8ea2c2, 0.08));
const sunLight = new THREE.DirectionalLight(0xfff4e4, 2.15);
scene.add(sunLight);
const sun = sunEci(LAUNCH.timeMs);
const sunThree = eciToThree(sun);
sunLight.position.set(sunThree[0], sunThree[1], sunThree[2]);

const stars = makeStars();
scene.add(stars);

const earthPivot = new THREE.Group();
scene.add(earthPivot);
const earth = new THREE.Mesh(
  new THREE.SphereGeometry(WORLD_R, 96, 64),
  new THREE.MeshPhongMaterial({ color: 0x16365c, shininess: 8 })
);
earthPivot.add(earth);

const night = new THREE.Mesh(
  new THREE.SphereGeometry(WORLD_R * 1.001, 96, 64),
  new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL1,
    uniforms: {
      map: { value: null },
      sunDir: { value: new THREE.Vector3(...sunThree).normalize() },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vNormal;
      void main() {
        vUv = uv;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      uniform vec3 sunDir;
      varying vec2 vUv;
      varying vec3 vNormal;
      void main() {
        float dark = smoothstep(0.18, -0.25, dot(normalize(vNormal), sunDir));
        vec3 city = texture2D(map, vUv).rgb;
        gl_FragColor = vec4(city * 1.35, dark);
      }
    `,
  })
);
earthPivot.add(night);

const atmos = new THREE.Mesh(
  new THREE.SphereGeometry(WORLD_R * 1.055, 64, 48),
  new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL1,
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: `
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - clamp(dot(normalize(vNormal), viewDir), 0.0, 1.0), 2.8);
        gl_FragColor = vec4(0.42, 0.68, 1.0, fres * 1.05);
      }
    `,
  })
);
scene.add(atmos);

const ring = makeSolidLine(orbitRingPoints(state.exag), 0x9fb4c8, 1.1, 0.16);
scene.add(ring);

const plane = new THREE.Mesh(
  new THREE.CircleGeometry(1, 96),
  new THREE.MeshBasicMaterial({
    color: 0x7ee0ff,
    transparent: true,
    opacity: 0.05,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
);
plane.quaternion.setFromUnitVectors(
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(...eciToThree(missions.orbit.normal)).normalize()
);
plane.visible = false;
scene.add(plane);

const path = makeColoredLine();
const ground = new THREE.Group();
const ghostGround = new THREE.Group();
earthPivot.add(ground);
earthPivot.add(ghostGround);
scene.add(path);

const stalkGeom = new THREE.BufferGeometry();
stalkGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
const stalk = new THREE.Line(
  stalkGeom,
  new THREE.LineBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.55 })
);
scene.add(stalk);

const ship = makeShip();
scene.add(ship);

const pins = {
  pad: addPin(LAUNCH.lat, LAUNCH.lon, 0xffb020),
  hawaii: addPin(21.31, -157.86, 0x8aa0b8),
  splash: addPin(0, 0, 0xff5a36),
};
const labels = {
  pad: makeLabel("Starbase"),
  hawaii: makeLabel("Hawaii"),
  splash: makeLabel("Splashdown"),
  ship: makeLabel("Ship 41"),
  north: makeLabel("N"),
};
labels.ship.classList.add("ship");

loadTextures();
placeCamera();
rebuildPaths();
bindUI();
renderCopy();

controls.addEventListener("start", () => {
  state.follow = false;
  $("follow").checked = false;
});

let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (state.playing) {
    state.met = Math.min(active().duration, state.met + dt * state.speed);
    if (state.met >= active().duration) state.playing = false;
  }
  updateFrame(dt);
  controls.update();
  renderer.render(scene, camera);
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  for (const line of [path, ring, ...ground.children, ...ghostGround.children]) {
    if (line.material?.resolution) line.material.resolution.set(innerWidth, innerHeight);
  }
});

addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    togglePlay();
  } else if (e.key === "f") {
    state.follow = !state.follow;
    $("follow").checked = state.follow;
  }
});

function active() {
  return missions[state.mode];
}
function other() {
  return missions[state.mode === "flown" ? "planned" : "flown"];
}

function updateFrame(dt) {
  const mission = active();
  const sample = sampleAt(mission, state.met);
  const unix = LAUNCH.timeMs + state.met * 1000;
  earthPivot.rotation.y = gmstRad(unix);

  const shipPos = eciKmToWorld(sample.eci, state.exag);
  ship.position.copy(shipPos);
  const vel = new THREE.Vector3(...eciToThree(sample.v));
  if (vel.lengthSq() > 1e-8) {
    ship.quaternion.setFromUnitVectors(NOSE, vel.normalize());
  }
  const dist = camera.position.distanceTo(ship.position);
  ship.scale.setScalar(THREE.MathUtils.clamp(dist * 0.011, 0.035, 0.22));

  const ll = eciToLatLon(sample.eci, unix);
  const groundPoint = geoWorld(ll.lat, ll.lon, WORLD_R * 1.004);
  const pos = stalk.geometry.attributes.position;
  pos.setXYZ(0, shipPos.x, shipPos.y, shipPos.z);
  pos.setXYZ(1, groundPoint.x, groundPoint.y, groundPoint.z);
  pos.needsUpdate = true;

  if (state.follow) {
    const radial = shipPos.clone().normalize();
    const back = vel.lengthSq() > 0.5 ? vel.clone().multiplyScalar(-1.3) : new THREE.Vector3();
    const desired = shipPos.clone().addScaledVector(radial, 2.4).add(back);
    const k = 1 - Math.pow(0.0008, dt);
    camera.position.lerp(desired, k);
    controls.target.lerp(shipPos.clone().multiplyScalar(0.2), k);
  }

  $("met").textContent = formatMET(state.met);
  $("utc").textContent = formatClock(state.met);
  $("phase").textContent = PHASES[sample.phase] || sample.phase;
  const alt = Math.max(0, Math.hypot(...sample.eci) - EARTH_RADIUS_KM);
  $("alt").textContent = `${alt.toFixed(alt < 20 ? 1 : 0)} km`;
  $("spd").textContent = `${Math.hypot(...sample.v).toFixed(2)} km/s`;
  $("ll").textContent = formatLatLon((ll.lat * 180) / Math.PI, (ll.lon * 180) / Math.PI);
  $("laps").textContent = sample.laps.toFixed(2);
  $("scrub").value = String(Math.round(state.met));
  $("play").textContent = state.playing ? "Pause" : "Play";

  placeLabel(labels.ship, shipPos, null, true);
  placeLabel(labels.pad, pins.pad.getWorldPosition(new THREE.Vector3()), pins.pad.getWorldPosition(new THREE.Vector3()).normalize());
  placeLabel(labels.hawaii, pins.hawaii.getWorldPosition(new THREE.Vector3()), pins.hawaii.getWorldPosition(new THREE.Vector3()).normalize());
  placeLabel(labels.splash, pins.splash.getWorldPosition(new THREE.Vector3()), pins.splash.getWorldPosition(new THREE.Vector3()).normalize());
  const north = geoWorld(Math.PI / 2, 0, WORLD_R * 1.02);
  placeLabel(labels.north, north, UP);
}

function rebuildPaths() {
  setLinePositions(path, coloredPositions(active(), state.exag, 0));
  fillGround(ground, active(), false);
  fillGround(ghostGround, other(), true);
  ghostGround.visible = state.ghost;
  setLinePositions(ring, orbitRingPoints(state.exag));
  const visR = WORLD_R * (1 + (missions.orbit.rOrb - EARTH_RADIUS_KM) * state.exag / EARTH_RADIUS_KM);
  plane.scale.setScalar(visR);
  const splash = active().splash;
  setPin(pins.splash, splash.lat, splash.lon);
  labels.splash.textContent = "Splashdown";
  buildTicks();
  $("scrub").max = String(Math.round(active().duration));
}

function renderCopy() {
  const m = active();
  const where = formatLatLon(m.splash.lat, m.splash.lon);
  if (state.mode === "flown") {
    $("deck").textContent =
      "Ship 41 reached orbit, let 26 Starlink satellites go, and was brought home early. It did not fly the six laps in the original timeline.";
    $("note").textContent =
      `Reconstructed splashdown ${where}, about ${m.splash.laps.toFixed(1)} revolutions after liftoff — a little over one of them spent in orbit.`;
  } else {
    $("deck").textContent =
      "The profile published before launch: stay up almost ten hours, circle about six times, and come down in the Pacific west of Chile.";
    $("note").textContent =
      `That route ends near ${where}, ${m.splash.laps.toFixed(1)} revolutions from the pad. An engine shutdown on ascent is why they didn't fly it.`;
  }
  $("fine").textContent =
    "One ring in space. Earth turns underneath it, so each lap draws a new line on the ground — those are the “six orbits,” not six different paths. " +
    "Drawn from the published timeline and a 30.5° orbit near 270 km, not from telemetry. Height is exaggerated so the ring is visible.";
}

function bindUI() {
  document.querySelectorAll(".modes button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".modes button").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      state.mode = btn.dataset.mode;
      state.met = Math.min(state.met, active().duration);
      rebuildPaths();
      renderCopy();
    });
  });
  $("play").addEventListener("click", togglePlay);
  document.querySelectorAll(".speeds button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".speeds button").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      state.speed = Number(btn.dataset.speed);
      state.playing = true;
    });
  });
  $("scrub").addEventListener("input", () => {
    state.met = Number($("scrub").value);
    state.playing = false;
  });
  $("exag").addEventListener("input", () => {
    state.exag = Number($("exag").value);
    $("exag-val").textContent = state.exag === 1 ? "1× true" : `${state.exag}×`;
    rebuildPaths();
  });
  $("true-scale").addEventListener("click", () => {
    state.exag = 1;
    $("exag").value = "1";
    $("exag-val").textContent = "1× true";
    rebuildPaths();
  });
  $("ghost").addEventListener("change", () => {
    state.ghost = $("ghost").checked;
    ghostGround.visible = state.ghost;
  });
  $("follow").addEventListener("change", () => {
    state.follow = $("follow").checked;
  });
}

function togglePlay() {
  if (!state.playing && state.met >= active().duration - 0.5) state.met = 0;
  state.playing = !state.playing;
}

function buildTicks() {
  const host = $("ticks");
  host.innerHTML = "";
  const duration = active().duration;
  const keep = new Set(["Liftoff", "Orbital insertion", "Starlink deploy", "Deorbit burn", "Splashdown"]);
  for (const ev of active().events) {
    if (ev.t > duration || !keep.has(ev.label)) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    const short = {
      Liftoff: "Liftoff",
      "Orbital insertion": "Orbit",
      "Starlink deploy": "Deploy",
      "Deorbit burn": "Deorbit",
      Splashdown: "Splash",
    };
    btn.textContent = short[ev.label] || ev.label;
    btn.style.left = `${(ev.t / duration) * 100}%`;
    btn.addEventListener("click", () => {
      state.met = ev.t;
      state.playing = false;
    });
    host.appendChild(btn);
  }
}

function eciKmToWorld(eci, exag, biasKm = 0) {
  const r = Math.hypot(eci[0], eci[1], eci[2]);
  const alt = r - EARTH_RADIUS_KM;
  const rVis = EARTH_RADIUS_KM + Math.max(0, alt) * exag + biasKm;
  const t = eciToThree(eci);
  const s = (rVis / r) * (WORLD_R / EARTH_RADIUS_KM);
  return new THREE.Vector3(t[0] * s, t[1] * s, t[2] * s);
}

function geoWorld(lat, lon, radius) {
  const local = latLonToLocal(lat, lon, radius);
  return new THREE.Vector3(...local).applyAxisAngle(UP, earthPivot.rotation.y);
}

function coloredPositions(mission, exag, biasKm) {
  const positions = [];
  const colors = [];
  for (const s of mission.samples) {
    const p = eciKmToWorld(s.eci, exag, biasKm);
    positions.push(p.x, p.y, p.z);
    const c = PHASE_COLOR[s.phase] || PHASE_COLOR.orbit;
    colors.push(c[0], c[1], c[2]);
  }
  return { positions, colors };
}

function orbitRingPoints(exag) {
  const positions = [];
  const r = missions.orbit.rOrb;
  for (let i = 0; i <= 256; i++) {
    const u = (i / 256) * Math.PI * 2;
    const eci = sampleOrbitEci(u, r);
    const p = eciKmToWorld(eci, exag, 0);
    positions.push(p.x, p.y, p.z);
  }
  return { positions };
}

function sampleOrbitEci(u, radius) {
  // Same plane as the flown orbit: node × along-track, argument u from the node.
  const n = missions.orbit.normal;
  const node = cross(n, [0, 0, 1]);
  const nodeMag = Math.hypot(...node);
  const nodeU = nodeMag < 1e-6 ? [1, 0, 0] : node.map((v) => v / nodeMag);
  const along = cross(n, nodeU);
  const cu = Math.cos(u);
  const su = Math.sin(u);
  return [
    (nodeU[0] * cu + along[0] * su) * radius,
    (nodeU[1] * cu + along[1] * su) * radius,
    (nodeU[2] * cu + along[2] * su) * radius,
  ];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function fillGround(group, mission, ghost) {
  for (const child of group.children) {
    child.geometry.dispose();
    child.material.dispose();
  }
  group.clear();
  let batch = [];
  let rev = mission.samples[0].rev;
  const flush = () => {
    if (batch.length < 6) return;
    const color = ghost ? 0x9aa8b8 : LAP_COLORS[rev % LAP_COLORS.length];
    const line = makeSolidLine({ positions: batch }, color, ghost ? 1.2 : 2.4, ghost ? 0.28 : 0.95);
    group.add(line);
  };
  for (const s of mission.samples) {
    if (s.rev !== rev && batch.length) {
      const p = groundLocal(s);
      batch.push(p.x, p.y, p.z);
      flush();
      batch = [p.x, p.y, p.z];
      rev = s.rev;
    } else {
      const p = groundLocal(s);
      batch.push(p.x, p.y, p.z);
      rev = s.rev;
    }
  }
  flush();
}

function groundLocal(sample) {
  const ll = eciToLatLon(sample.eci, LAUNCH.timeMs + sample.t * 1000);
  const p = latLonToLocal(ll.lat, ll.lon, WORLD_R * 1.003);
  return new THREE.Vector3(p[0], p[1], p[2]);
}

function makeColoredLine() {
  const geom = new LineGeometry();
  geom.setPositions([0, 0, 0, 0, 0, 0.001]);
  geom.setColors([1, 1, 1, 1, 1, 1]);
  const mat = new LineMaterial({
    vertexColors: true,
    linewidth: 2.6,
    transparent: true,
    opacity: 1,
    worldUnits: false,
  });
  mat.resolution.set(innerWidth, innerHeight);
  const line = new Line2(geom, mat);
  line.frustumCulled = false;
  return line;
}

function makeSolidLine(data, color, width, opacity) {
  const geom = new LineGeometry();
  const positions = data.positions?.length >= 6 ? data.positions : [0, 0, 0, 0, 0, 0.001];
  geom.setPositions(positions);
  const mat = new LineMaterial({
    color,
    linewidth: width,
    transparent: true,
    opacity,
    worldUnits: false,
    depthWrite: false,
  });
  mat.resolution.set(innerWidth, innerHeight);
  const line = new Line2(geom, mat);
  line.frustumCulled = false;
  line.computeLineDistances();
  return line;
}

function setLinePositions(line, data) {
  line.geometry.setPositions(data.positions);
  if (data.colors) line.geometry.setColors(data.colors);
  line.computeLineDistances();
}

function addPin(lat, lon, color) {
  const pin = new THREE.Mesh(
    new THREE.SphereGeometry(0.018, 12, 10),
    new THREE.MeshBasicMaterial({ color })
  );
  setPin(pin, lat, lon);
  earthPivot.add(pin);
  return pin;
}

function setPin(pin, lat, lon) {
  const p = latLonToLocal((lat * Math.PI) / 180, (lon * Math.PI) / 180, WORLD_R * 1.006);
  pin.position.set(p[0], p[1], p[2]);
}

function makeLabel(text) {
  const el = document.createElement("div");
  el.className = "label";
  el.textContent = text;
  labelLayer.appendChild(el);
  return el;
}

function placeLabel(el, worldPos, normal, isShip = false) {
  if (!isShip && normal && normal.dot(camera.position.clone().sub(worldPos)) <= 0) {
    el.style.display = "none";
    return;
  }
  if (isShip && occluded(worldPos)) {
    el.style.display = "none";
    return;
  }
  const ndc = worldPos.clone().project(camera);
  if (ndc.z > 1) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  el.style.left = `${(ndc.x * 0.5 + 0.5) * innerWidth}px`;
  el.style.top = `${(-ndc.y * 0.5 + 0.5) * innerHeight}px`;
}

function occluded(point) {
  const o = camera.position;
  const d = point.clone().sub(o);
  const t = THREE.MathUtils.clamp(-o.dot(d) / d.lengthSq(), 0, 1);
  const closest = o.clone().addScaledVector(d, t);
  return closest.length() < WORLD_R * 0.99 && t > 0.02 && t < 0.98;
}

function makeShip() {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({
    color: 0xd5dbe2,
    metalness: 0.72,
    roughness: 0.32,
    emissive: 0x1b140c,
    emissiveIntensity: 0.4,
  });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.86, 16), metal);
  body.position.y = -0.05;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.32, 16), metal);
  nose.position.y = 0.54;
  const flapMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.4, roughness: 0.45 });
  for (const side of [-1, 1]) {
    const flap = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.16), flapMat);
    flap.position.set(side * 0.2, -0.28, 0);
    flap.rotation.z = side * 0.5;
    g.add(flap);
  }
  g.add(body, nose);
  return g;
}

function makeStars() {
  const n = 1600;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(70 + Math.random() * 50);
    pos[i * 3] = v.x;
    pos[i * 3 + 1] = v.y;
    pos[i * 3 + 2] = v.z;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(
    geom,
    new THREE.PointsMaterial({
      color: 0xd5e2f2,
      size: 0.18,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85,
    })
  );
}

function placeCamera() {
  const pad = eciKmToWorld(missions.flown.samples[0].eci, 1);
  camera.position.copy(pad.normalize().multiplyScalar(17));
  camera.position.y += 6.5;
  camera.position.x -= 3;
  camera.lookAt(0, 0, 0);
  controls.target.set(0, 0, 0);
  controls.update();
}

function loadTextures() {
  const loader = new THREE.TextureLoader();
  const day = loader.load(TEX + "earth-blue-marble.jpg");
  const bump = loader.load(TEX + "earth-topology.png");
  const spec = loader.load(TEX + "earth-water.png");
  const lights = loader.load(TEX + "earth-night.jpg");
  for (const tex of [day, bump, spec, lights]) {
    tex.colorSpace = tex === bump || tex === spec ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    tex.anisotropy = 8;
  }
  earth.material.map = day;
  earth.material.bumpMap = bump;
  earth.material.bumpScale = 0.03;
  earth.material.specularMap = spec;
  earth.material.specular = new THREE.Color(0x6e88a4);
  earth.material.needsUpdate = true;
  night.material.uniforms.map.value = lights;
}

function formatLatLon(lat, lon) {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(1)}°${ns} ${Math.abs(lon).toFixed(1)}°${ew}`;
}
