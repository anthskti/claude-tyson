import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Placeholder ring built from primitives. Swap in the Blender scene by exporting it
// as glTF binary to client/public/models/ring.glb — loadRing() prefers that file and
// falls back to this one when it's missing.
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
  scene.fog = new THREE.Fog(0x07080c, 8, 30);

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
  scene.add(key, key.target);

  for (const [x, z, color] of [[-6, -6, 0xff5a5a], [6, 6, 0x5a8cff]] as const) {
    const rim = new THREE.SpotLight(color, 40, 25, Math.PI / 6, 0.6, 1.2);
    rim.position.set(x, 7, z);
    rim.target.position.set(0, 1, 0);
    scene.add(rim, rim.target);
  }
}

export async function loadRing(url = '/models/ring.glb'): Promise<THREE.Object3D> {
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    gltf.scene.traverse(o => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return gltf.scene;
  } catch {
    return buildPlaceholderRing();
  }
}
