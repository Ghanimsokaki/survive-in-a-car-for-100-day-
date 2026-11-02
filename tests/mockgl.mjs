/**
 * A RECORDING WEBGL CONTEXT — the sandbox has no GPU, but a WebGL context is a
 * plain JS object: enough of one lets the *real* three.js run its whole render
 * pipeline (program setup, attribute binding, texture upload, uniform refresh,
 * shadow passes) and throw wherever a browser would.
 *
 * It records draw calls so a lane can tell "drew nothing" from "drew fine", and
 * every constant/method three reaches for is present, including the ones a real
 * driver supplies through extensions.
 */

const K = {};
['ARRAY_BUFFER', 'ELEMENT_ARRAY_BUFFER', 'TEXTURE_2D', 'TEXTURE_CUBE_MAP',
  'TEXTURE_CUBE_MAP_POSITIVE_X', 'TEXTURE_CUBE_MAP_NEGATIVE_X', 'TEXTURE_CUBE_MAP_POSITIVE_Y',
  'TEXTURE_CUBE_MAP_NEGATIVE_Y', 'TEXTURE_CUBE_MAP_POSITIVE_Z', 'TEXTURE_CUBE_MAP_NEGATIVE_Z',
  'FRAMEBUFFER', 'RENDERBUFFER', 'STATIC_DRAW', 'DYNAMIC_DRAW', 'STREAM_DRAW', 'FLOAT', 'HALF_FLOAT',
  'UNSIGNED_BYTE', 'UNSIGNED_SHORT', 'UNSIGNED_INT', 'SHORT', 'BYTE', 'INT', 'TRIANGLES',
  'TRIANGLE_STRIP', 'LINES', 'POINTS', 'LINE_STRIP', 'VERTEX_SHADER', 'FRAGMENT_SHADER',
  'COMPILE_STATUS', 'LINK_STATUS', 'ACTIVE_UNIFORMS', 'ACTIVE_ATTRIBUTES', 'DEPTH_TEST', 'BLEND',
  'ONE', 'ZERO', 'SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA', 'LEQUAL', 'LESS', 'GREATER', 'ALWAYS',
  'CULL_FACE', 'BACK', 'FRONT', 'COLOR_BUFFER_BIT', 'DEPTH_BUFFER_BIT', 'STENCIL_BUFFER_BIT',
  'TEXTURE0', 'TEXTURE1', 'TEXTURE2', 'TEXTURE3', 'TEXTURE4', 'TEXTURE5', 'TEXTURE6', 'TEXTURE7',
  'CLAMP_TO_EDGE', 'REPEAT', 'MIRRORED_REPEAT', 'LINEAR', 'NEAREST', 'LINEAR_MIPMAP_LINEAR',
  'LINEAR_MIPMAP_NEAREST', 'NEAREST_MIPMAP_LINEAR', 'NEAREST_MIPMAP_NEAREST', 'RGBA', 'RGB',
  'ALPHA', 'LUMINANCE', 'DEPTH_COMPONENT', 'DEPTH_COMPONENT16', 'DEPTH_COMPONENT24',
  'UNSIGNED_SHORT_4_4_4_4', 'UNSIGNED_SHORT_5_5_5_1', 'UNSIGNED_SHORT_5_6_5', 'FRAMEBUFFER_COMPLETE',
  'MAX_TEXTURE_SIZE', 'MAX_CUBE_MAP_TEXTURE_SIZE', 'MAX_TEXTURE_IMAGE_UNITS',
  'MAX_VERTEX_TEXTURE_IMAGE_UNITS', 'MAX_COMBINED_TEXTURE_IMAGE_UNITS', 'MAX_VERTEX_UNIFORM_VECTORS',
  'MAX_FRAGMENT_UNIFORM_VECTORS', 'MAX_VARYING_VECTORS', 'MAX_VERTEX_ATTRIBS', 'MAX_SAMPLES',
  'MAX_RENDERBUFFER_SIZE', 'SCISSOR_TEST', 'DEPTH_WRITEMASK', 'COLOR_WRITEMASK', 'CURRENT_PROGRAM',
  'VIEWPORT', 'UNPACK_FLIP_Y_WEBGL', 'UNPACK_PREMULTIPLY_ALPHA_WEBGL', 'UNPACK_ALIGNMENT',
  'POLYGON_OFFSET_FILL', 'SAMPLE_ALPHA_TO_COVERAGE', 'STENCIL_TEST', 'FUNC_ADD', 'FUNC_SUBTRACT',
  'EQUAL', 'NOTEQUAL', 'GEQUAL', 'MULTIPLY', 'REPLACE', 'SCISSOR_BOX', 'VERSION',
  'SHADING_LANGUAGE_VERSION', 'VENDOR', 'RENDERER', 'MAX_ARRAY_TEXTURE_LAYERS',
  'MAX_3D_TEXTURE_SIZE', 'VERTEX_ARRAY_BINDING'].forEach((name, i) => { K[name] = 1000 + i; });
const byValue = Object.fromEntries(Object.entries(K).map(([name, value]) => [value, name]));

export const calls = { draws: 0, arrays: 0 };

export function makeGL() {
  const extension = () => new Proxy({}, {
    get(target, key) {
      if (key === 'then') return undefined;
      return () => (/SUPPORTED|isInstance/i.test(String(key)) ? true : {});
    },
  });
  const base = {
    ...K,
    canvas: null,
    drawingBufferWidth: 412,
    drawingBufferHeight: 915,
    getContextAttributes: () => ({ alpha: false, antialias: true, depth: true, stencil: false }),
    getExtension: () => extension(),
    getSupportedExtensions: () => [],
    getParameter(name) {
      const key = byValue[name] || '';
      if (key === 'MAX_TEXTURE_SIZE' || key === 'MAX_CUBE_MAP_TEXTURE_SIZE' || key === 'MAX_RENDERBUFFER_SIZE') return 8192;
      if (key === 'MAX_SAMPLES') return 4;
      if (/MAX_.*TEXTURE_IMAGE_UNITS|MAX_VERTEX_ATTRIBS|MAX_.*VECTORS|MAX_ARRAY_TEXTURE_LAYERS/.test(key)) return 32;
      if (key === 'MAX_3D_TEXTURE_SIZE') return 2048;
      if (key === 'VERSION') return 'WebGL 1.0 (headless)';
      if (key === 'SHADING_LANGUAGE_VERSION') return 'WebGL GLSL ES 1.0 (headless)';
      if (key === 'VENDOR' || key === 'RENDERER') return 'arena headless';
      if (key === 'VIEWPORT' || key === 'SCISSOR_BOX') return new Int32Array([0, 0, 412, 915]);
      if (key === 'DEPTH_WRITEMASK' || key === 'COLOR_WRITEMASK') return true;
      return 0;
    },
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}),
    createTexture: () => ({}), createFramebuffer: () => ({}), createRenderbuffer: () => ({}),
    createVertexArray: () => ({}), createQuery: () => ({}),
    shaderSource() {}, compileShader() {}, attachShader() {}, linkProgram() {},
    getShaderParameter: () => true, getShaderInfoLog: () => '', getProgramInfoLog: () => '',
    getProgramParameter: () => 0,
    getActiveUniform: () => ({ name: 'none', size: 1, type: 1 }),
    getActiveAttrib: () => ({ name: 'none', size: 1, type: 1 }),
    getUniformLocation: () => ({}), getAttribLocation: () => 0, getShaderSource: () => '',
    bindAttribLocation() {}, deleteShader() {}, deleteProgram() {}, deleteBuffer() {},
    deleteTexture() {}, deleteFramebuffer() {}, deleteRenderbuffer() {}, deleteVertexArray() {},
    bufferData() {}, bufferSubData() {}, texImage2D() {}, texSubImage2D() {}, texParameteri() {},
    texParameterf() {}, pixelStorei() {}, generateMipmap() {}, compressedTexImage2D() {},
    activeTexture() {}, bindTexture() {}, bindFramebuffer() {}, bindRenderbuffer() {},
    framebufferTexture2D() {}, framebufferRenderbuffer() {}, renderbufferStorage() {},
    checkFramebufferStatus: () => K.FRAMEBUFFER_COMPLETE,
    clear() {}, clearColor() {}, clearDepth() {}, clearStencil() {}, colorMask() {}, depthMask() {},
    depthFunc() {}, enable() {}, disable() {}, blendFunc() {}, blendFuncSeparate() {},
    blendEquation() {}, blendEquationSeparate() {}, cullFace() {}, frontFace() {}, viewport() {},
    scissor() {}, useProgram() {}, bindBuffer() {}, bindVertexArray() {},
    enableVertexAttribArray() {}, disableVertexAttribArray() {},
    vertexAttribPointer() {}, vertexAttribIPointer() {}, vertexAttribDivisor() {},
    drawArrays() { calls.draws += 1; calls.arrays += 1; },
    drawElements() { calls.draws += 1; },
    drawArraysInstanced() { calls.draws += 1; }, drawElementsInstanced() { calls.draws += 1; },
    uniform1f() {}, uniform1i() {}, uniform2f() {}, uniform3f() {}, uniform4f() {}, uniform2fv() {},
    uniform3fv() {}, uniform4fv() {}, uniformMatrix2fv() {}, uniformMatrix3fv() {},
    uniformMatrix4fv() {}, uniform1iv() {}, uniform2iv() {}, uniform3iv() {},
    readPixels() {}, finish() {}, flush() {}, isContextLost: () => false,
    getUniformBlockIndex: () => 0, getActiveUniformBlockParameter: () => 0,
  };
  return new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'string' && /^[A-Z0-9_]+$/.test(key)) return K[key] ?? 0;
      return () => ({});
    },
  });
}


export { K };
