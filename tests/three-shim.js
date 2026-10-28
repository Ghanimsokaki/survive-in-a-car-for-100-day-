export * from '../public/vendor/three.module.js';

export class WebGLRenderer {
  constructor() {
    this.domElement = {
      style: {},
      addEventListener(type, fn) { (this._l ||= {})[type] = fn; },
      setPointerCapture() {}, releasePointerCapture() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
      width: 1280, height: 720, clientWidth: 1280, clientHeight: 720,
    };
    this.shadowMap = {};
    this.outputColorSpace = 'srgb';
    this.toneMapping = 0;
    this.toneMappingExposure = 1;
    this.disposed = false;
  }
  setPixelRatio(v) { this.pixelRatio = v; }
  setSize() {}
  render() { globalThis.__frames = (globalThis.__frames || 0) + 1; }
  dispose() { this.disposed = true; }
}
