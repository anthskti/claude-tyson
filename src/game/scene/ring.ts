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

  const canvasMat = new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.9 });
  const apronMat = new THREE.MeshStandardMaterial({ color: 0x1d2a4a, roughness: 0.7 });
  const ropeMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 });
  const postMat = new THREE.MeshStandardMaterial({ color: 0x8a8f99, metalness: 0.8, roughness: 0.3 });

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
    new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.9 })
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
  scene.background = new THREE.Color(0x07080c);
  // Far enough to make out the neighbouring rings (arena.ts), close enough to hide the floor's edge.
  scene.fog = new THREE.Fog(0x07080c, 12, 48);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshStandardMaterial({ color: 0x111318, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.1;
  floor.receiveShadow = true;
  scene.add(floor);

  scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x10121a, 0.35));

  // Overhead rig: one shadow-casting key over the ring plus coloured rim lights.
  const key = new THREE.SpotLight(0xfff4e0, 120, 20, Math.PI / 5, 0.4, 1.4);
  key.position.set(0, 9, 0);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  // Without bias the canvas self-shadows into acne (the "noisy floor").
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);

  for (const [x, z, color] of [[-6, -6, 0xff5a5a], [6, 6, 0x5a8cff]] as const) {
    const rim = new THREE.SpotLight(color, 40, 25, Math.PI / 6, 0.6, 1.2);
    rim.position.set(x, 7, z);
    rim.target.position.set(0, 1, 0);
    scene.add(rim, rim.target);
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
