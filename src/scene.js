// Three.js scene scaffolding: renderer, camera, orbit controls, lights, the
// textured Earth, the starfield, and the render loop. Also owns camera moves
// that ride the loop (focus easing) or touch the controls (orbit wheel).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EARTH_R, EARTH_TEX, EARTH_BUMP, EARTH_SPEC } from './config.js';

export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070d);

export const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.0005, 200);
camera.position.set(2.6, 1.4, 2.6);

export const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.002; // zoom essentially all the way in (and through the surface)
controls.maxDistance = 100;   // and far out
controls.zoomToCursor = true; // Google-Maps-like: zoom toward cursor
controls.zoomSpeed = 1.1;
controls.rotateSpeed = 0.6;

scene.add(new THREE.AmbientLight(0xffffff, 0.45));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(5, 3, 5);
scene.add(sun);

// --- textured Earth (semi-transparent so internal depths show through) ---
const texLoader = new THREE.TextureLoader();
texLoader.crossOrigin = 'anonymous';

const oceanMaskTex = texLoader.load(EARTH_SPEC); // water = bright, land = dark
export const earthMat = new THREE.MeshPhongMaterial({
  map:         texLoader.load(EARTH_TEX),
  normalMap:   texLoader.load(EARTH_BUMP),
  specularMap: oceanMaskTex,
  specular:    new THREE.Color(0x222233),
  shininess:   18,
  transparent: true,
  opacity:     0.78, // glassy: continents clear, quakes inside still visible
  depthWrite:  false,
});
// Use the ocean mask as an alpha mask so water fragments become fully
// transparent — "remove the water from view", leaving only land.
earthMat.onBeforeCompile = (shader) => {
  shader.uniforms.uOceanMask = { value: oceanMaskTex };
  shader.fragmentShader = 'uniform sampler2D uOceanMask;\n' + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <dithering_fragment>',
    `#include <dithering_fragment>
     float _water = texture2D(uOceanMask, vMapUv).r;
     gl_FragColor.a *= smoothstep(0.65, 0.45, _water); // <0.45 land=opaque, >0.65 water=clear`
  );
};
export const earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 96, 96), earthMat);
// Draw the globe AFTER internal geometry so its alpha composites over the depth
// lines/quakes — true proportional see-through, not a depth-cull pop.
earth.renderOrder = 10;
scene.add(earth);

// --- starfield background ---
const starGeo = new THREE.BufferGeometry();
const STAR_COUNT = 4000;
const starPos = new Float32Array(STAR_COUNT * 3);
for (let i = 0; i < STAR_COUNT; i++) {
  const r = 40 + Math.random() * 20;
  const t = Math.random() * Math.PI * 2;
  const p = Math.acos(2 * Math.random() - 1);
  starPos[i * 3]     = r * Math.sin(p) * Math.cos(t);
  starPos[i * 3 + 1] = r * Math.cos(p);
  starPos[i * 3 + 2] = r * Math.sin(p) * Math.sin(t);
}
starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.05, sizeAttenuation: true })));

// --- camera moves ---
let focusTween = null; // point we're easing controls.target toward

// Double-click handler asks us to recenter on a picked point; the render loop
// eases controls.target there so the move feels smooth.
export function setFocus(point) { focusTween = point.clone(); }

// Spin the camera horizontally around the current pivot — view the same point
// from another diagonal while it stays centered.
const ORBIT_AXIS = new THREE.Vector3(0, 1, 0);
export function orbitAroundTarget(deltaRad) {
  const offset = camera.position.clone().sub(controls.target);
  offset.applyAxisAngle(ORBIT_AXIS, deltaRad);
  camera.position.copy(controls.target).add(offset);
  controls.update();
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

export function startRenderLoop() {
  (function animate() {
    requestAnimationFrame(animate);
    if (focusTween) {
      controls.target.lerp(focusTween, 0.15);
      if (controls.target.distanceTo(focusTween) < 1e-4) {
        controls.target.copy(focusTween); focusTween = null;
      }
    }
    controls.update();
    renderer.render(scene, camera);
  })();
}
