// Temporal anti-aliasing. MSAA alone leaves the far city's thin edges (window frames, poles,
// roof lines a pixel or less wide) crawling as the camera moves: each frame the 4 samples
// land on a different part of them. Here every frame is drawn shifted by a sub-pixel jitter
// (a Halton 2,3 sequence of JITTER_FRAMES, JITTER_SPREAD of a pixel: the MSAA samples cover
// the rest, a wider jitter only softens), into a 4x MSAA target, and blended into the
// history of the frames before at where each pixel was last frame:
//   - the camera's motion: each pixel's point (from the frame's depth: log depth decoded, the
//     cut-outs' holes show what is behind them) seen from last frame's camera;
//   - plus the object's own: a velocity pass draws the opaque meshes again with this frame's
//     model matrix against last frame's (0 for the city; the cab, traffic, people move);
//   - the history is read there (Catmull-Rom, so it doesn't blur), clipped to the colours
//     around the pixel in this frame (YCoCg mean +- sigma, inside the min / max: what was
//     behind a moving edge, or is new, is not dragged along) and CURRENT_WEIGHT of this frame
//     is mixed in, MOTION_WEIGHT more per pixel it moved (up to MAX_WEIGHT: what moves fast,
//     the street beside the cab, stays sharp; the far city moves a fraction of a pixel).
// Headless Chrome, 640 x 480, the camera drifting past the Arcade city 1500-3000 away: pixels
// flickering frame to frame (a second difference over 60) 7300 / 1600 / 5 against MSAA's
// 13300 / 5000 / 150 (3 x 3 supersampling: 10900 / 3800 / 8); edges ~20% softer in motion.
// ?taa=0 draws straight to the canvas as before. Needs float render targets (velocity).
import * as THREE from 'three';

export const JITTER_FRAMES = 8;
export const CURRENT_WEIGHT = 0.1;
export const JITTER_SPREAD = 0.5;
export const MOTION_WEIGHT = 0.1;
export const MAX_WEIGHT = 0.5;
const VELOCITY_LAYER = 31;

/** The Halton sequence's i-th value in a base (0..1). */
export function halton(i, base) {
  let f = 1, r = 0;
  for (let n = i; n > 0; n = Math.floor(n / base)) { f /= base; r += f * (n % base); }
  return r;
}

/** The jitter of frame n in pixels (-0.5..0.5 on each axis). */
export function jitter(n) {
  const i = (n % JITTER_FRAMES) + 1;
  return [halton(i, 2) - 0.5, halton(i, 3) - 0.5];
}

/** Whether a mesh is drawn in the velocity pass: the opaque, depth-tested, colour-writing ones. */
export function movesInVelocity(o) {
  if (!o.isMesh) return false;
  const m = Array.isArray(o.material) ? o.material[0] : o.material;
  return !!m && m.colorWrite !== false && m.transparent !== true && m.depthTest !== false;
}

// An object's own motion, in uv units: its point now and where it was, both seen from last
// frame's camera (the camera's own motion is the resolve's, from the depth).
const velocityMaterial = () => new THREE.ShaderMaterial({
  uniforms: { prevViewProjection: { value: new THREE.Matrix4() }, prevModel: { value: new THREE.Matrix4() } },
  vertexShader: /* glsl */`
#include <common>
#include <skinning_pars_vertex>
uniform mat4 prevViewProjection;
uniform mat4 prevModel;
varying vec4 vNow;
varying vec4 vPrev;
void main() {
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 world = modelMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * viewMatrix * world;
  vNow = prevViewProjection * world;
  vPrev = prevViewProjection * prevModel * vec4(transformed, 1.0);
}`,
  fragmentShader: /* glsl */`
varying vec4 vNow;
varying vec4 vPrev;
void main() {
  gl_FragColor = vec4((vNow.xy / vNow.w - vPrev.xy / vPrev.w) * 0.5, 0.0, 1.0);
}`,
  side: THREE.DoubleSide,
});

const resolveMaterial = () => new THREE.ShaderMaterial({
  uniforms: {
    current: { value: null }, history: { value: null }, velocity: { value: null }, depth: { value: null },
    size: { value: new THREE.Vector2() }, jittered: { value: new THREE.Vector4() }, unjittered: { value: new THREE.Matrix4() },
    viewToPrevClip: { value: new THREE.Matrix4() }, near: { value: 1 }, far: { value: 1 }, logDepth: { value: 0 },
    historyValid: { value: 0 }, currentWeight: { value: CURRENT_WEIGHT }, motionWeight: { value: MOTION_WEIGHT }, maxWeight: { value: MAX_WEIGHT },
  },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: /* glsl */`
uniform sampler2D current;
uniform sampler2D history;
uniform sampler2D velocity;
uniform sampler2D depth;
uniform vec2 size;
uniform vec4 jittered;        // the frame's projection: x, y scale, x, y offset (elements 0, 5, 8, 9)
uniform mat4 unjittered;
uniform mat4 viewToPrevClip;  // last frame's view x projection x this frame's camera
uniform float near;
uniform float far;
uniform float logDepth;
uniform float historyValid;
uniform float currentWeight;
uniform float motionWeight;
uniform float maxWeight;
varying vec2 vUv;
vec3 toYCoCg(vec3 c) { return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b); }
vec3 fromYCoCg(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
// Catmull-Rom from 5 bilinear taps (the corners' weights are small enough to drop).
vec3 historyAt(vec2 uv) {
  vec2 at = uv * size, t1 = floor(at - 0.5) + 0.5, f = at - t1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = (t1 - 1.0) / size, t3 = (t1 + 2.0) / size, t12 = (t1 + w2 / w12) / size;
  float a = w12.x * w0.y, b = w0.x * w12.y, c = w12.x * w12.y, d = w3.x * w12.y, e = w12.x * w3.y;
  vec3 s = texture2D(history, vec2(t12.x, t0.y)).rgb * a + texture2D(history, vec2(t0.x, t12.y)).rgb * b
    + texture2D(history, t12).rgb * c + texture2D(history, vec2(t3.x, t12.y)).rgb * d + texture2D(history, vec2(t12.x, t3.y)).rgb * e;
  return max(s / (a + b + c + d + e), 0.0);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), last = ivec2(size) - 1;
  vec3 now = texelFetch(current, p, 0).rgb;
  vec3 m1 = vec3(0.0), m2 = vec3(0.0), lo = vec3(1e9), hi = vec3(-1e9);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 c = toYCoCg(texelFetch(current, clamp(p + ivec2(x, y), ivec2(0), last), 0).rgb);
      m1 += c; m2 += c * c; lo = min(lo, c); hi = max(hi, c);
    }
  }
  vec3 mean = m1 / 9.0, sigma = sqrt(max(m2 / 9.0 - mean * mean, 0.0));
  // (never without the pixel itself: a thin line lies outside its neighbours' spread)
  vec3 here = toYCoCg(now);
  vec3 boxLo = min(max(lo, mean - sigma), here), boxHi = max(min(hi, mean + sigma), here);
  // The pixel's point in view space (w: its distance along the view axis; the sky: the far plane).
  float d = texelFetch(depth, p, 0).r;
  float w = logDepth > 0.5 ? exp2(d * log2(far + 1.0)) - 1.0 : near * far / (far - d * (far - near));
  vec2 ndc = (gl_FragCoord.xy / size) * 2.0 - 1.0;
  vec4 view = vec4((ndc + jittered.zw) * w / jittered.xy, -w, 1.0);
  vec4 nowClip = unjittered * view, wasClip = viewToPrevClip * view;
  vec2 motion = (nowClip.xy / nowClip.w - wasClip.xy / wasClip.w) * 0.5 + texelFetch(velocity, p, 0).xy;
  vec2 back = vUv - motion;
  vec3 result = now;
  if (historyValid > 0.5 && all(greaterThanEqual(back, vec2(0.0))) && all(lessThanEqual(back, vec2(1.0)))) {
    vec3 h = toYCoCg(historyAt(back));
    // Clip toward the box's centre (not a per-channel clamp: keeps the hue).
    vec3 centre = 0.5 * (boxHi + boxLo), extent = max(0.5 * (boxHi - boxLo), vec3(1e-4));
    vec3 off = h - centre, r = abs(off / extent);
    float m = max(r.x, max(r.y, r.z));
    if (m > 1.0) h = centre + off / m;
    float moved = length(motion * size);   // pixels since last frame
    result = mix(fromYCoCg(h), now, min(currentWeight + motionWeight * moved, maxWeight));
  }
  gl_FragColor = vec4(result, 1.0);
}`,
  depthTest: false, depthWrite: false,
});

const copyMaterial = () => new THREE.ShaderMaterial({
  uniforms: { map: { value: null } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: /* glsl */`
uniform sampler2D map;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(map, vUv);
  #include <colorspace_fragment>
}`,
  depthTest: false, depthWrite: false,
});

/** The TAA, or null where float render targets aren't drawable (then draw as before). */
export function createTAA(renderer) {
  if (!renderer.extensions.has('EXT_color_buffer_float') && !renderer.extensions.has('EXT_color_buffer_half_float')) return null;
  return new TAA(renderer);
}

export class TAA {
  constructor(renderer) {
    this.renderer = renderer;
    const colour = { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    const depth = new THREE.DepthTexture(1, 1, THREE.UnsignedInt248Type);   // with the stencil (the shadow volumes)
    depth.format = THREE.DepthStencilFormat;
    this.scene = new THREE.WebGLRenderTarget(1, 1, { ...colour, samples: 4, depthBuffer: true, stencilBuffer: true, depthTexture: depth });
    this.velocity = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    this.history = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { ...colour, depthBuffer: false }));
    this.velocityMaterial = velocityMaterial();
    this.velocityMaterial.onBeforeRender = (r, s, c, g, object) => this._motion(object);
    this.resolve = resolveMaterial();
    this.copy = copyMaterial();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.resolve);
    this.quad.frustumCulled = false;
    this.quadCamera = new THREE.Camera();
    this.frame = 0;
    this.spread = JITTER_SPREAD;
    this.valid = false;
    this.prevWorld = new WeakMap();
    this.moved = [];
    this.prevViewProjection = new THREE.Matrix4();
    this.viewProjection = new THREE.Matrix4();
    this.unjittered = new THREE.Matrix4();
    this._size = new THREE.Vector2();
    this._clear = new THREE.Color();
  }

  _motion(object) {
    const u = this.velocityMaterial.uniforms;
    u.prevModel.value.copy(this.prevWorld.get(object) || object.matrixWorld);
    this.velocityMaterial.uniformsNeedUpdate = true;
  }

  setSize(w, h) {
    if (this.scene.width === w && this.scene.height === h) return;
    for (const t of [this.scene, this.velocity, ...this.history]) t.setSize(w, h);
    this.valid = false;
  }

  /** Draw `scene` from `camera` to the canvas, anti-aliased with the frames before. */
  render(scene, camera) {
    const r = this.renderer;
    r.getDrawingBufferSize(this._size);
    this.setSize(this._size.x, this._size.y);
    const w = this._size.x, h = this._size.y;
    const autoReset = r.info.autoReset;   // renderer.info: the whole frame's passes (the probes read it)
    if (autoReset) r.info.reset();
    r.info.autoReset = false;

    // This frame's jitter, in the projection (sub-pixel; restored after).
    camera.updateMatrixWorld();
    this.unjittered.copy(camera.projectionMatrix);
    const [jx, jy] = jitter(this.frame++).map((v) => v * this.spread);
    camera.projectionMatrix.elements[8] += jx * 2 / w;
    camera.projectionMatrix.elements[9] += jy * 2 / h;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

    r.setRenderTarget(this.scene);
    r.render(scene, camera);

    // The objects' own motion: the opaque meshes on the velocity layer, the rest cleared to 0.
    this.moved.length = 0;
    scene.traverseVisible((o) => {
      if (movesInVelocity(o)) { o.layers.enable(VELOCITY_LAYER); this.moved.push(o); } else o.layers.disable(VELOCITY_LAYER);
    });
    const background = scene.background, override = scene.overrideMaterial, layers = camera.layers.mask, alpha = r.getClearAlpha();
    r.getClearColor(this._clear);
    scene.background = null;
    scene.overrideMaterial = this.velocityMaterial;
    camera.layers.set(VELOCITY_LAYER);
    this.velocityMaterial.uniforms.prevViewProjection.value.copy(this.prevViewProjection);
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.velocity);
    r.render(scene, camera);
    r.setClearColor(this._clear, alpha);
    camera.layers.mask = layers;
    scene.overrideMaterial = override;
    scene.background = background;

    camera.projectionMatrix.copy(this.unjittered);
    camera.projectionMatrixInverse.copy(this.unjittered).invert();
    this.viewProjection.multiplyMatrices(this.unjittered, camera.matrixWorldInverse);

    // Resolve into the other history, then show it.
    const [read, write] = this.frame % 2 ? this.history : [this.history[1], this.history[0]];
    const u = this.resolve.uniforms;
    u.current.value = this.scene.texture;
    u.history.value = read.texture;
    u.velocity.value = this.velocity.texture;
    u.size.value.set(w, h);
    u.depth.value = this.scene.depthTexture;
    const e = camera.projectionMatrix.elements;
    u.jittered.value.set(e[0], e[5], e[8] + jx * 2 / w, e[9] + jy * 2 / h);
    u.unjittered.value.copy(this.unjittered);
    u.viewToPrevClip.value.multiplyMatrices(this.prevViewProjection, camera.matrixWorld);
    u.near.value = camera.near;
    u.far.value = camera.far;
    u.logDepth.value = r.capabilities.logarithmicDepthBuffer ? 1 : 0;
    u.historyValid.value = this.valid ? 1 : 0;
    this.quad.material = this.resolve;
    r.setRenderTarget(write);
    r.render(this.quad, this.quadCamera);
    this.copy.uniforms.map.value = write.texture;
    this.quad.material = this.copy;
    r.setRenderTarget(null);
    r.render(this.quad, this.quadCamera);

    // Last frame's matrices, for the next.
    for (const o of this.moved) {
      const m = this.prevWorld.get(o);
      if (m) m.copy(o.matrixWorld); else this.prevWorld.set(o, o.matrixWorld.clone());
    }
    this.prevViewProjection.copy(this.viewProjection);
    this.valid = true;
    r.info.autoReset = autoReset;
  }
}
