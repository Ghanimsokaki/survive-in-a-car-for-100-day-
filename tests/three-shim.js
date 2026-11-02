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
    // real three keeps this object and reads `checkShaderErrors` on the first
    // draw of every material. The shim has to model it, or a line that nulls it
    // (which broke FUEL RUN in the browser) draws perfectly here.
    this.debug = { checkShaderErrors: true, onShaderError: null };
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
