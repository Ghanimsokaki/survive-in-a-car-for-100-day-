// Minimal DOM + WebGL + audio stubs so game/account modules run under Node.
function makeCtx() {
  const noop = () => {};
  return {
    canvas: null, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1, lineCap: 'butt',
    fillRect: noop, clearRect: noop, strokeRect: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, arc: noop, ellipse: noop, rect: noop, roundRect: noop,
    fill: noop, stroke: noop, save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    fillText: noop, strokeText: noop, createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }), createConicGradient: () => ({ addColorStop: noop }),
    measureText: () => ({ width: 80 }), drawImage: noop, setTransform: noop,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }), putImageData: noop,
    quadraticCurveTo: noop, bezierCurveTo: noop, clip: noop,
  };
}

class ClassList {
  constructor(initial = []) { this.set = new Set(initial); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    on ? this.set.add(c) : this.set.delete(c);
    return on;
  }
  contains(c) { return this.set.has(c); }
  get value() { return [...this.set].join(' '); }
}

export class El {
  constructor(tag = 'div', id = '') {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.style = { cssText: '', setProperty() {} };
    this.dataset = {};
    this.classList = new ClassList();
    this.children = [];
    this._html = '';
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.type = '';
    this.width = 320; this.height = 200;
    this.clientWidth = 320; this.clientHeight = 200;
    this.listeners = {};
    this._parent = null;
  }
  get firstChild() { return this.children[0] || { textContent: '', style: {} }; }
  appendChild(c) { c._parent = this; this.children.push(c); return c; }
  prepend(...c) { c.forEach((x) => { x._parent = this; }); this.children.unshift(...c); }
  append(...c) { this.children.push(...c); }
  remove() {
    if (this._parent) {
      const i = this._parent.children.indexOf(this);
      if (i >= 0) this._parent.children.splice(i, 1);
    }
  }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener() {}
  dispatch(t, ev = {}) {
    (this.listeners[t] || []).forEach((f) => f({ preventDefault() {}, stopPropagation() {}, ...ev }));
  }
  querySelector(sel) {
    this._qs ||= new Map();
    if (!this._qs.has(sel)) this._qs.set(sel, new El('span'));
    return this._qs.get(sel);
  }
  querySelectorAll() { return []; }
  getContext() { return makeCtx(); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 320, height: 200 }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  focus() { this.dispatch('focus'); }
  blur() { this.dispatch('blur'); }
  setAttribute() {}
  getAttribute() { return null; }
  set innerHTML(v) {
    this._html = String(v);
    if (this._html === '') this.children.length = 0;  // real DOM drops the children too
  }
  get innerHTML() { return this._html; }
  set innerText(v) { this.textContent = v; }
  get innerText() { return this.textContent; }
}

const els = new Map();

export function installDOM({ width = 1280, height = 720 } = {}) {
  const doc = {
    getElementById(id) {
      if (!els.has(id)) {
        const isCanvas = ['app', 'radar', 'previewCanvas', 'previewCanvasLobby'].includes(id) ? false : false;
        const el = new El(id === 'radar' || id.startsWith('previewCanvas') ? 'canvas' : 'div', id);
        el.width = 220; el.height = 220;
        if (el.tagName === 'CANVAS') el.getContext = () => makeCtx();
        els.set(id, el);
      }
      return els.get(id);
    },
    querySelectorAll(sel) {
      if (sel === '.meter') return ['engine', 'chassis', 'tires', 'fuel'].map((k) => {
        const el = new El('div');
        el.dataset.k = k;
        return el;
      });
      return [];
    },
    querySelector() { return new El('div'); },
    createElement(tag) {
      const el = new El(tag);
      if (tag === 'canvas') { const ctx = makeCtx(); el.getContext = () => ctx; }
      return el;
    },
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    body: new El('body'),
    documentElement: (() => {
      // real <html>: classList + inline style, both used by the auto-landscape path
      const set = new Set();
      return {
        style: { setProperty() {}, removeProperty() {} },
        classList: {
          add: (c) => set.add(c),
          remove: (c) => set.delete(c),
          contains: (c) => set.has(c),
          toggle: (c, on) => { const want = on === undefined ? !set.has(c) : on; want ? set.add(c) : set.delete(c); return want; },
        },
      };
    })(),
    addEventListener() {},
  };

  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
  };

  const listeners = {};
  const win = {
    innerWidth: width, innerHeight: height, devicePixelRatio: 2,
    screen: { width: width, height: height },
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
    removeEventListener() {},
    dispatch: (t, ev) => (listeners[t] || []).forEach((f) => f(ev)),
    matchMedia: (q) => ({ matches: /coarse/.test(q) ? Boolean(globalThis.__COARSE__) : false, addEventListener() {}, addListener() {} }),
    location: { search: globalThis.__SEARCH__ || '', host: '127.0.0.1:8000', protocol: 'http:', reload() {} },
    localStorage,
    AudioContext: undefined, webkitAudioContext: undefined,
    BroadcastChannel: undefined, WebSocket: undefined,
    visualViewport: null,
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance,
    navigator: { maxTouchPoints: globalThis.__TOUCH__ ? 2 : 0, hardwareConcurrency: 8 },
    requestAnimationFrame: () => 0,
  };

  globalThis.document = doc;
  globalThis.window = win;
  try { Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true }); } catch {}
  globalThis.localStorage = localStorage;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.matchMedia = win.matchMedia;
  globalThis.location = win.location;
  globalThis.screen = win.screen;
  globalThis.devicePixelRatio = win.devicePixelRatio;
  return { els, El, win, localStorage };
}
