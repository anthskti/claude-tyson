import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Renders claude_bot.glb to a data URL for the VS screen CPU portrait.
 *  Returns null if the GLB is unavailable or rendering fails. */
export async function renderBotPortrait(
  _mainRenderer: THREE.WebGLRenderer
): Promise<string | null> {
  try {
    const W = 340, H = 480;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(W, H);
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.4;

    const scene = new THREE.Scene();
    // Dramatic portrait lighting
    const key = new THREE.DirectionalLight(0xffc060, 4.5);
    key.position.set(-2, 3, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x4060ff, 1.2);
    fill.position.set(3, 1, -1);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xff6020, 3.0);
    rim.position.set(0, 2, -3);
    scene.add(rim);
    scene.add(new THREE.AmbientLight(0x111111, 0.5));

    const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 50);
    // Low-angle portrait shot looking up at fighter
    camera.position.set(0.4, 1.1, 2.8);
    camera.lookAt(0, 1.6, 0);

    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync('/claude_bot.glb');
    const bot = gltf.scene;
    bot.position.set(0, 0, 0);
    bot.rotation.y = Math.PI * 0.08; // slight menacing angle
    scene.add(bot);

    renderer.render(scene, camera);
    const dataUrl = canvas.toDataURL('image/png');
    renderer.dispose();
    return dataUrl;
  } catch {
    return null;
  }
}
