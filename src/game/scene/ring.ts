import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// boxing_ring.glb is the arena. Its Arena.Floor quad is authored about 2.8 m up,
// so loadRing() shifts that surface to y = 0. The primitive ring is only the
// load-failure fallback.
//
// Blender export conventions the game expects: +Y up, 1 unit = 1 m, canvas top at
// y = 0, ring centred on the origin.

export const RING_HALF = 3; // 6 m inside the ropes
const POST_HEIGHT = 1.6;
const ROPE_HEIGHTS = [0.45, 0.85, 1.25];

// ── Shared toon gradient map (3-step: shadow / mid / highlight) ───────────
// Created once and reused across all MeshToonMaterials.
const _toonGradientData = new Uint8Array([0, 128, 255]);
const toonGradientMap = new THREE.DataTexture(_toonGradientData, 3, 1, THREE.RedFormat);
toonGradientMap.minFilter = THREE.NearestFilter;
toonGradientMap.magFilter = THREE.NearestFilter;
toonGradientMap.needsUpdate = true;

/** Cel-shaded material with the shared 3-step gradient. */
function toon(color: number, emissive = 0x000000, emissiveIntensity = 0): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: toonGradientMap, emissive, emissiveIntensity });
}

export function buildPlaceholderRing(): THREE.Group {
  const ring = new THREE.Group();
  ring.name = 'placeholder-ring';

  // Vivid CR-style ring colors
  const canvasMat = toon(0x1a50cc);  // vivid blue canvas
  const apronMat  = toon(0x102070);  // dark navy apron
  const ropeMat   = toon(0xffd830);  // bright gold ropes
  const postMat   = toon(0xffc820);  // CR gold posts

  // Canvas + apron skirt below it.
  const canvas = new THREE.Mesh(new THREE.BoxGeometry(RING_HALF * 2 + 1, 0.12, RING_HALF * 2 + 1), canvasMat);
  canvas.position.y = -0.06;
  canvas.receiveShadow = true;
  ring.add(canvas);

  const apron = new THREE.Mesh(new THREE.BoxGeometry(RING_HALF * 2 + 1.2, 1.1, RING_HALF * 2 + 1.2), apronMat);
  apron.position.y = -0.65;
  ring.add(apron);

  // Centre logo circle — contrasting vivid yellow
  const logo = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1.1, 48),
    toon(0xffd830)
  );
  logo.rotation.x = -Math.PI / 2;
  logo.position.y = 0.003;
  ring.add(logo);

  // Inner star on centre circle
  const innerCircle = new THREE.Mesh(new THREE.CircleGeometry(0.7, 48), toon(0x2a60ee));
  innerCircle.rotation.x = -Math.PI / 2;
  innerCircle.position.y = 0.004;
  ring.add(innerCircle);

  // Corner posts: bold cartoon colours
  const corners: [number, number, number][] = [
    [-RING_HALF, -RING_HALF, 0xee3322],  // player — vivid red
    [ RING_HALF,  RING_HALF, 0xaa22ee],  // Claude — vivid purple
    [ RING_HALF, -RING_HALF, 0xffd830],  // neutral — gold
    [-RING_HALF,  RING_HALF, 0xffd830],  // neutral — gold
  ];
  const cornerPos = corners.map(([x, z, padColor]) => {
    // Chunkier posts (0.09 radius)
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, POST_HEIGHT, 12), postMat);
    post.position.set(x, POST_HEIGHT / 2, z);
    post.castShadow = true;
    ring.add(post);

    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, ROPE_HEIGHTS[2] - ROPE_HEIGHTS[0] + 0.22, 0.28),
      toon(padColor)
    );
    pad.position.set(x, (ROPE_HEIGHTS[0] + ROPE_HEIGHTS[2]) / 2, z);
    ring.add(pad);
    return new THREE.Vector3(x, 0, z);
  });

  // Fatter ropes (0.035 radius)
  const order = [0, 2, 1, 3];
  for (let i = 0; i < 4; i++) {
    const a = cornerPos[order[i]];
    const b = cornerPos[order[(i + 1) % 4]];
    for (const h of ROPE_HEIGHTS) {
      const curve = new THREE.LineCurve3(a.clone().setY(h), b.clone().setY(h));
      const rope = new THREE.Mesh(new THREE.TubeGeometry(curve, 1, 0.035, 8), ropeMat);
      rope.castShadow = true;
      ring.add(rope);
    }
  }

  return ring;
}

export function buildArena(scene: THREE.Scene) {
  // CR deep-navy arena background
  scene.background = new THREE.Color(0x0a1428);
  scene.fog = new THREE.FogExp2(0x0a1428, 0.04);

  // ── Hardwood floor — bright warm orange planks ───────────────────────────
  // y = -1.2: avoids Z-fighting with ring apron bottom (y = -0.6 - 0.5 = -1.1)
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    toon(0xe8982a)  // warm orange wood
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Plank dividers — dark strips along Z, cartoon-flat
  const plankMat = toon(0x8a5010);
  for (let x = -18; x <= 18; x += 0.65) {
    const plank = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 80), plankMat);
    plank.rotation.x = -Math.PI / 2;
    plank.position.set(x, -1.195, 0);
    scene.add(plank);
  }

  // ── Hanging heavy bags — bright cartoon red ──────────────────────────────
  const bagMat   = toon(0xcc2810);  // vivid red bag
  const capMat   = toon(0x991e08);  // darker red cap
  const chainMat = toon(0xb0a888);  // light grey chain

  for (const [bx, bz] of [[-9, -8], [9, -8]] as [number, number][]) {
    const bag = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.2, 1.6, 12), bagMat);
    bag.position.set(bx, 5.6, bz);
    bag.castShadow = true;
    scene.add(bag);

    const capGeo = new THREE.SphereGeometry(0.25, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.set(bx, 6.4, bz);
    scene.add(cap);

    // Chunky chain links — alternating small cylinders
    for (let cy = 0; cy < 4; cy++) {
      const link = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.018, 5, 8), chainMat);
      link.rotation.x = cy % 2 === 0 ? 0 : Math.PI / 2;
      link.position.set(bx, 7.0 + cy * 0.22, bz);
      scene.add(link);
    }
  }

  // ── Overhead light rigs — cartoon lamp style ──────────────────────────────
  const rigMat  = toon(0x223355);
  const lampMat = toon(0xfff0a0, 0xffe040, 1.2);  // glowing yellow lamp

  for (const rx of [-3.5, 3.5] as const) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 5.0), rigMat);
    beam.position.set(rx, 8.8, -1.5);
    scene.add(beam);

    // Lamp cone (inverted cone = shade)
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.5, 10), toon(0x223355));
    shade.rotation.x = Math.PI;  // point down
    shade.position.set(rx, 8.45, -1.5);
    shade.castShadow = true;
    scene.add(shade);

    // Glowing bulb inside
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), lampMat);
    bulb.position.set(rx, 8.35, -1.5);
    scene.add(bulb);
  }

  // ── Floor mat under the ring — dark blue square ──────────────────────────
  const mat = new THREE.Mesh(
    new THREE.BoxGeometry(RING_HALF * 2 + 3.5, 0.04, RING_HALF * 2 + 3.5),
    toon(0x0e1e50)
  );
  mat.position.set(0, -1.18, 0);
  scene.add(mat);

  // ── Lighting — cartoon-friendly: strong ambient + 1 clean directional ────
  // High ambient keeps toon shadow areas colourful, not black.
  scene.add(new THREE.AmbientLight(0x8aa8dd, 1.4));

  // Clean overhead directional — creates the toon light/shadow split
  const key = new THREE.DirectionalLight(0xfff4cc, 3.5);
  key.position.set(2, 10, 4);
  key.target.position.set(0, 0, -1);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  // Without bias the canvas self-shadows into acne (the "noisy floor").
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);

  // Red corner fill — player side warmth
  const rimRed = new THREE.PointLight(0xff4422, 20, 16, 1.4);
  rimRed.position.set(-6, 5, 5);
  scene.add(rimRed);

  // Purple corner fill — Claude side
  const rimPurple = new THREE.PointLight(0xaa22ff, 20, 16, 1.4);
  rimPurple.position.set(6, 5, -8);
  scene.add(rimPurple);
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

export async function loadRing(url = '/boxing_ring.glb'): Promise<THREE.Object3D> {
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
