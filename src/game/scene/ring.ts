import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// boxing_ring.glb is the arena. Its Arena.Floor quad is authored about 2.8 m up,
// so loadRing() shifts that surface to y = 0. The primitive ring is only the
// load-failure fallback.
//
// Blender export conventions the game expects: +Y up, 1 unit = 1 m, canvas top at
// y = 0, ring centred on the origin.

export const RING_HALF = 3; // 6 m inside the ropes
const POST_HEIGHT = 1.5;
const ROPE_HEIGHTS = [0.45, 0.85, 1.25];

export function buildPlaceholderRing(): THREE.Group {
  const ring = new THREE.Group();
  ring.name = 'placeholder-ring';

  const canvasMat = new THREE.MeshStandardMaterial({ color: 0x1a1d26, roughness: 0.85 });
  const apronMat = new THREE.MeshStandardMaterial({ color: 0x0e1420, roughness: 0.8 });
  const ropeMat = new THREE.MeshStandardMaterial({ color: 0xffcc44, metalness: 0.4, roughness: 0.35 });
  const postMat = new THREE.MeshStandardMaterial({ color: 0xc0aa60, metalness: 0.9, roughness: 0.2 });

  // Canvas + apron skirt below it.
  const canvas = new THREE.Mesh(new THREE.BoxGeometry(RING_HALF * 2 + 1, 0.1, RING_HALF * 2 + 1), canvasMat);
  canvas.position.y = -0.05;
  canvas.receiveShadow = true;
  ring.add(canvas);

  const apron = new THREE.Mesh(new THREE.BoxGeometry(RING_HALF * 2 + 1.1, 1.0, RING_HALF * 2 + 1.1), apronMat);
  apron.position.y = -0.6;
  ring.add(apron);

  // Centre logo ring painted on the canvas.
  const logo = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1.05, 64),
    new THREE.MeshStandardMaterial({ color: 0xffc020, emissive: 0xffa000, emissiveIntensity: 0.15, roughness: 0.7 })
  );
  logo.rotation.x = -Math.PI / 2;
  logo.position.y = 0.002;
  ring.add(logo);

  // Corner posts: red and blue corners, two neutral (white) corners.
  const corners: [number, number, number][] = [
    [-RING_HALF, -RING_HALF, 0xd63031],
    [RING_HALF, RING_HALF, 0x0984e3],
    [RING_HALF, -RING_HALF, 0xffffff],
    [-RING_HALF, RING_HALF, 0xffffff],
  ];
  const cornerPos = corners.map(([x, z, padColor]) => {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, POST_HEIGHT, 16), postMat);
    post.position.set(x, POST_HEIGHT / 2, z);
    post.castShadow = true;
    ring.add(post);

    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, ROPE_HEIGHTS[2] - ROPE_HEIGHTS[0] + 0.2, 0.22),
      new THREE.MeshStandardMaterial({ color: padColor, roughness: 0.6 })
    );
    pad.position.set(x, (ROPE_HEIGHTS[0] + ROPE_HEIGHTS[2]) / 2, z);
    ring.add(pad);
    return new THREE.Vector3(x, 0, z);
  });

  // Ropes run between adjacent corners.
  const order = [0, 2, 1, 3];
  for (let i = 0; i < 4; i++) {
    const a = cornerPos[order[i]];
    const b = cornerPos[order[(i + 1) % 4]];
    for (const h of ROPE_HEIGHTS) {
      const curve = new THREE.LineCurve3(a.clone().setY(h), b.clone().setY(h));
      const rope = new THREE.Mesh(new THREE.TubeGeometry(curve, 1, 0.025, 8), ropeMat);
      rope.castShadow = true;
      ring.add(rope);
    }
  }

  return ring;
}

export function buildArena(scene: THREE.Scene) {
  scene.background = new THREE.Color(0x02030a);
  // Fog starts far enough to see all 4 rings clearly; ends where floor edge would be visible.
  scene.fog = new THREE.FogExp2(0x02030a, 0.018);

  // Dark polished floor — near-black with metallic sheen.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(140, 140),
    new THREE.MeshStandardMaterial({ color: 0x07090f, roughness: 0.55, metalness: 0.35 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.1;
  floor.receiveShadow = true;
  scene.add(floor);

  // Sky: dark cool blue from above, deep warm ember from below.
  scene.add(new THREE.HemisphereLight(0x506888, 0x1f0e04, 0.55));

  // === Four per-ring overhead spotlights — one at each ring origin in the 2×2 grid ===
  // Ring grid offset when focused on ring 0: rings at (0,0), (16,0,0), (0,0,16), (16,0,16).
  for (const [rx, rz] of [[0,0],[16,0],[0,16],[16,16]] as const) {
    const spot = new THREE.SpotLight(0xfff4d8, 240, 26, Math.PI / 5.5, 0.28, 1.3);
    spot.position.set(rx, 11, rz);
    spot.target.position.set(rx, 0, rz);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.bias = -0.0005;
    spot.shadow.normalBias = 0.02;
    scene.add(spot, spot.target);

    // Red + blue coloured rim per ring
    for (const [dx, dz, col] of [[-6,-6,0xff3020],[6,6,0x2060ff]] as const) {
      const rim = new THREE.SpotLight(col, 70, 22, Math.PI / 7, 0.6, 1.3);
      rim.position.set(rx + dx, 9, rz + dz);
      rim.target.position.set(rx, 1, rz);
      scene.add(rim, rim.target);
    }

    // Warm orange under-bounce at each ring base
    const bounce = new THREE.PointLight(0xff6010, 18, 8, 2);
    bounce.position.set(rx, -0.6, rz);
    scene.add(bounce);
  }

  // === Global accent — distant purple back-fill and orange front kicker ===
  for (const [x, y, z, col, intensity] of [
    [8, 12, -20, 0x6010b0, 28],
    [8, 6,   30, 0xff7020, 22],
    [-18, 8,  8, 0x204090, 15],
    [34, 8,   8, 0x204090, 15],
  ] as const) {
    const l = new THREE.PointLight(col, intensity, 50, 1.5);
    l.position.set(x, y, z);
    scene.add(l);
  }

  // === Crowd — two tiers of silhouette figures surrounding the venue ===
  addCrowd(scene);

  // === Overhead lighting rig bars (dark structural elements above rings) ===
  addLightingRig(scene);
}

function addCrowd(scene: THREE.Scene) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x06080f, roughness: 1 });
  const matBack = new THREE.MeshStandardMaterial({ color: 0x04060c, roughness: 1 });

  // Front tier — close, taller
  const FRONT_R = 32, FRONT_N = 64;
  for (let i = 0; i < FRONT_N; i++) {
    const angle = (i / FRONT_N) * Math.PI * 2;
    const jitter = (Math.random() - 0.5) * 5;
    const cx = 8 + Math.cos(angle) * (FRONT_R + jitter);
    const cz = 8 + Math.sin(angle) * (FRONT_R + jitter);
    const h = 1.55 + Math.random() * 0.65;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, h, 0.28), mat);
    body.position.set(cx, h / 2 - 1.1, cz);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 5), mat);
    head.position.set(cx, h - 1.1 + 0.24, cz);
    scene.add(body, head);
  }

  // Back tier — further, raised on bleachers
  const BACK_R = 44, BACK_N = 80;
  for (let i = 0; i < BACK_N; i++) {
    const angle = (i / BACK_N) * Math.PI * 2;
    const cx = 8 + Math.cos(angle) * (BACK_R + (Math.random() - 0.5) * 6);
    const cz = 8 + Math.sin(angle) * (BACK_R + (Math.random() - 0.5) * 6);
    const h = 1.6 + Math.random() * 0.5;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.45, h, 0.25), matBack);
    body.position.set(cx, h / 2 + 0.8, cz); // raised on bleachers
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 5, 4), matBack);
    head.position.set(cx, h + 0.8 + 0.23, cz);
    scene.add(body, head);
  }
}

function addLightingRig(scene: THREE.Scene) {
  // Horizontal truss bars spanning across the arena overhead
  const truss = new THREE.MeshStandardMaterial({ color: 0x0e1018, metalness: 0.7, roughness: 0.5 });
  for (const [x1, x2, z, y] of [
    [-4, 20, 0,  14],
    [-4, 20, 16, 14],
    [0,  16, -4, 14],
    [0,  16, 20, 14],
  ] as const) {
    const len = Math.sqrt((x2-x1)**2 + (z-z)**2);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, len, 6), truss);
    bar.rotation.z = Math.PI / 2;
    bar.position.set((x1+x2)/2, y, z);
    scene.add(bar);
  }
}

/** World-space Y of the Arena.Floor quad, the surface the bot stands on. */
function canvasTopY(root: THREE.Object3D): number | null {
  root.updateMatrixWorld(true);
  let top: number | null = null;
  const v = new THREE.Vector3();
  root.traverse(obj => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const floor = mats.findIndex(m => m?.name === 'Arena.Floor');
    if (floor < 0) return;
    const pos = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const group = mesh.geometry.groups.find(g => g.materialIndex === floor);
    const start = group?.start ?? 0;
    const count = group?.count ?? (index ? index.count : pos.count);
    for (let i = start; i < start + count; i++) {
      const vi = index ? index.getX(i) : i;
      v.fromBufferAttribute(pos, vi);
      mesh.localToWorld(v);
      if (top === null || v.y > top) top = v.y;
    }
  });
  return top;
}

let ringAsset: Promise<THREE.Object3D> | undefined;

/** A copy of the ring; every ring in the arena shares one load and its geometry. */
export async function loadRing(): Promise<THREE.Object3D> {
  ringAsset ??= loadRingModel('/boxing_ring.glb');
  return (await ringAsset).clone();
}

async function loadRingModel(url: string): Promise<THREE.Object3D> {
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    gltf.scene.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.receiveShadow = true;
      // The canvas/apron plane only receives; letting it cast too makes it shadow itself.
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mesh.castShadow = !mats.some(m => m?.name === 'Arena.Floor');
      for (const m of mats as THREE.MeshStandardMaterial[]) {
        // Blender exports everything double-sided; render shadows from back faces only.
        m.shadowSide = THREE.BackSide;
        // The canvas texture is seen at grazing angles; three clamps this to the GPU max.
        if (m.map) m.map.anisotropy = 8;
      }
    });
    const top = canvasTopY(gltf.scene);
    if (top !== null) gltf.scene.position.y -= top;
    return gltf.scene;
  } catch {
    return buildPlaceholderRing();
  }
}
