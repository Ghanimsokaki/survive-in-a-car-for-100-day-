import * as THREE from '../vendor/three.module.js';
import { buildAvatar } from './avatar.js';
import { Game } from './game.js';
import { rand } from './utils.js';

const BODY_COLORS = ['#ffb347', '#ff6b6b', '#5ff0ff', '#8bf5b4', '#c9a0ff', '#ffd166', '#f78fb3', '#e8ecf4', '#7f8ab0'];
const CAR_COLORS = ['#d24a2b', '#2b6ad2', '#3aa06a', '#d2b02b', '#8a3ad2', '#38505e', '#c0c6d0', '#7a2b2b'];

const saved = (() => {
  try { return JSON.parse(localStorage.getItem('outrun-profile') || '{}'); } catch { return {}; }
})();

const state = {
  name: saved.name || 'WANDERER',
  color: saved.color || BODY_COLORS[0],
  carColor: saved.carColor || CAR_COLORS[0],
  room: saved.room || 'highway-01',
};

const $ = (id) => document.getElementById(id);
const lobby = $('lobby');
const loading = $('loading');
const nameInput = $('nameInput');
const roomInput = $('roomInput');
const playBtn = $('playBtn');
const netStatus = $('netStatus');

nameInput.value = state.name;
roomInput.value = state.room;

// ---------------------------------------------------------------- swatches
function buildSwatches(container, colors, key) {
  container.innerHTML = '';
  colors.forEach((c) => {
    const b = document.createElement('button');
    b.className = `swatch ${state[key] === c ? 'on' : ''}`;
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => {
      state[key] = c;
      [...container.children].forEach((x) => x.classList.toggle('on', x === b));
      if (key === 'color') updatePreview(true);
      save();
    });
    container.appendChild(b);
  });
}
buildSwatches($('colorRow'), BODY_COLORS, 'color');
buildSwatches($('carRow'), CAR_COLORS, 'carColor');

function save() {
  try { localStorage.setItem('outrun-profile', JSON.stringify(state)); } catch {}
}
nameInput.addEventListener('input', () => {
  state.name = nameInput.value.trim().toUpperCase().slice(0, 14) || 'WANDERER';
  updatePreview(true);
  save();
});
roomInput.addEventListener('input', () => {
  state.room = roomInput.value.toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 12) || 'highway-01';
  roomInput.value = state.room;
  save();
});
$('randomRoom').addEventListener('click', () => {
  const words = ['highway', 'ash', 'storm', 'rust', 'convoy', 'dust', 'chrome', 'deadwind'];
  state.room = `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(Math.random() * 89 + 10)}`;
  roomInput.value = state.room;
  save();
});

// ---------------------------------------------------------------- preview
let renderer, scene, camera, avatar, previewTargetYaw = 0, previewYaw = 0, previewReady = false;

function initPreview() {
  const canvas = $('previewCanvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
  camera.position.set(0, 1.55, 5.1);
  camera.lookAt(0, 1.2, 0);

  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x3b2c1b, 1.5);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffd9a0, 3.2);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x5ff0ff, 1.4);
  rim.position.set(-4, 2, -3);
  scene.add(rim);

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(2.4, 40),
    new THREE.MeshStandardMaterial({ color: 0x1a2029, roughness: 0.9, metalness: 0.2 })
  );
  disc.rotation.x = -Math.PI / 2;
  scene.add(disc);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.35, 2.5, 44),
    new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  scene.add(ring);

  updatePreview();
  previewReady = true;
  resizePreview();
  animatePreview();
}

function updatePreview(rebuild = false) {
  if (!scene) return;
  if (avatar) scene.remove(avatar.root);
  avatar = buildAvatar({ color: new THREE.Color(state.color).getHex(), name: state.name });
  avatar.root.rotation.y = -0.35;
  scene.add(avatar.root);
  previewYaw = -0.35;
  previewTargetYaw = -0.35;
}

function resizePreview() {
  const canvas = $('previewCanvas');
  const w = canvas.clientWidth || 400, h = canvas.clientHeight || 238;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

let previewDragging = false, previewLastX = 0;
function bindPreviewDrag() {
  const canvas = $('previewCanvas');
  canvas.addEventListener('pointerdown', (e) => { previewDragging = true; previewLastX = e.clientX; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!previewDragging) return;
    previewTargetYaw += (e.clientX - previewLastX) * 0.012;
    previewLastX = e.clientX;
  });
  canvas.addEventListener('pointerup', (e) => { previewDragging = false; canvas.releasePointerCapture?.(e.pointerId); });
}

function animatePreview() {
  requestAnimationFrame(animatePreview);
  if (lobby.classList.contains('show') && avatar) {
    previewYaw += (previewTargetYaw - previewYaw) * 0.12;
    if (!previewDragging) previewTargetYaw += 0.0024;
    avatar.root.rotation.y = previewYaw;
    avatar.animate(0.016, 0.18, false);
    renderer.render(scene, camera);
  }
}

// ---------------------------------------------------------------- net check
async function probeRelay() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      netStatus.textContent = `● RELAY READY (${data.mode || 'node'}) — SHARE THE ROOM CODE TO PLAY TOGETHER`;
      netStatus.className = 'net-status ok';
      return;
    }
  } catch {}
  netStatus.textContent = '● STATIC MODE — ONLINE NEEDS THE RELAY; OPEN TWO TABS FOR LOCAL CO-OP';
  netStatus.className = 'net-status warn';
}

// ---------------------------------------------------------------- start game
let game = null;
let starting = false;

async function startRun() {
  if (starting) return;
  starting = true;
  state.name = (nameInput.value.trim() || 'WANDERER').toUpperCase().slice(0, 14);
  state.room = (roomInput.value.trim() || 'highway-01').toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 12);
  save();

  playBtn.innerHTML = 'WARMING THE ENGINE…';
  loading.classList.remove('gone');

  await new Promise((r) => setTimeout(r, 120));
  lobby.classList.remove('show');

  try {
    game = new Game({
      mount: $('app'),
      profile: { name: state.name, color: new THREE.Color(state.color).getHex(), carColor: new THREE.Color(state.carColor).getHex() },
      room: state.room,
      onQuit: () => location.reload(),
    });
    game.audio.init();
    game.audio.blip(560, 0.18, 'square', 0.1);
    game.started = true;
    game.hud.show();
    game.hud.chat('', `ROOM ${state.room.toUpperCase()} — SHARE THE CODE TO SURVIVE TOGETHER`, '#ffd9a0', true);
    game.hud.toast('DAY 1 · OAKHAVEN OUTSKIRTS', 'warn');
    setTimeout(() => game?.hud.toast('COLLECT FUEL · REACH THE HIGHWAY', ''), 1600);
  } catch (err) {
    console.error(err);
    netStatus.textContent = `FAILED TO START: ${err.message}`;
    loading.classList.add('gone');
    lobby.classList.add('show');
    playBtn.innerHTML = 'START THE RUN <span>▸</span>';
    starting = false;
    return;
  }

  setTimeout(() => loading.classList.add('gone'), 250);
  starting = false;
}

playBtn.addEventListener('click', startRun);
[nameInput, roomInput].forEach((el) => el.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startRun();
}));

window.addEventListener('resize', () => { if (previewReady) resizePreview(); });

// boot
initPreview();
bindPreviewDrag();
probeRelay();
setTimeout(() => loading.classList.add('gone'), 700);
window.__outrun = { state, get game() { return game; } };
