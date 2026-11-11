// Three.js view of the tower. Reads the Game; the only thing it tells the
// Game is when the hand has finished lowering a piece (via the callback
// passed to startDrop).

import * as THREE from '../vendor/three.module.min.js';
import { runs } from './game.js';

const TIER_COLOURS = [0x4f8fd6, 0xe6b422, 0xd9534f]; // light, medium, heavy
const WOOD_A = new THREE.Color(0xdcae6e), WOOD_B = new THREE.Color(0xc18d4f);
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export class View {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.game = game;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
    this.orbitState = { theta: 0.75, phi: 1.12, radius: 15 };
    this.target = new THREE.Vector3(1.5, 2.6, 1.5);
    this.raycaster = new THREE.Raycaster();
    this.groups = new Map(); // block id -> THREE.Group
    this.pullInfo = new Map(); // block id -> { can, tier }
    this.hoverId = null;
    this.selectedId = null;
    this.clock = 0;
    this.drop = null; // running hand animation
    this.handY = 30;
    this.handShown = false;
    this.grip = 1;
    this.heldKey = '';

    this.buildStage();
    this.buildHand();
    this.resize();
  }

  // ---------------------------------------------------------------- scene

  buildStage() {
    const { scene } = this;
    const sky = document.createElement('canvas');
    sky.width = 4; sky.height = 256;
    const g = sky.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#8fc4e8');
    grad.addColorStop(0.6, '#d7ecf6');
    grad.addColorStop(1, '#f3ead9');
    g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
    const tex = new THREE.CanvasTexture(sky);
    tex.colorSpace = THREE.SRGBColorSpace;
    scene.background = tex;

    scene.add(new THREE.HemisphereLight(0xffffff, 0xa08c74, 1.25));
    const sun = new THREE.DirectionalLight(0xfff1d8, 2.2);
    sun.position.set(7, 16, 9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 14, bottom: -6, near: 1, far: 50 });
    sun.shadow.bias = -0.0005;
    sun.target.position.set(1.5, 2, 1.5);
    scene.add(sun, sun.target);

    const table = new THREE.Mesh(new THREE.CircleGeometry(26, 64),
      new THREE.MeshStandardMaterial({ color: 0x9b7a55, roughness: 0.9 }));
    table.rotation.x = -Math.PI / 2;
    table.position.set(1.5, -1.5, 1.5);
    table.receiveShadow = true;
    scene.add(table);

    const plinth = new THREE.Mesh(new THREE.BoxGeometry(3.7, 1.5, 3.7),
      new THREE.MeshStandardMaterial({ color: 0x6b6259, roughness: 0.85 }));
    plinth.position.set(1.5, -0.75, 1.5);
    plinth.castShadow = true; plinth.receiveShadow = true;
    scene.add(plinth);

    this.ghost = new THREE.Group();
    scene.add(this.ghost);
    // Arrow that shows which way a chosen block will slide. Built pointing along +x.
    const arrowMat = new THREE.MeshBasicMaterial({ color: 0x14110f });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.1, 12), arrowMat);
    shaft.rotation.z = -Math.PI / 2;
    shaft.position.x = 0.55;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.55, 16), arrowMat);
    head.rotation.z = -Math.PI / 2;
    head.position.x = 1.35;
    this.arrow = new THREE.Group();
    this.arrow.add(shaft, head);
    this.arrow.visible = false;
    scene.add(this.arrow);
  }

  pieceMesh(cells, material, edgeColour = 0x3d2a14) {
    const h = this.game.cfg.cellHeight;
    const group = new THREE.Group();
    for (const run of runs(cells)) {
      const geo = new THREE.BoxGeometry(run.w - 0.03, h - 0.02, run.d - 0.03);
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.set(run.x + run.w / 2, 0, run.z + run.d / 2);
      mesh.castShadow = true; mesh.receiveShadow = true;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: edgeColour, transparent: true, opacity: 0.55 }));
      mesh.add(edges);
      group.add(mesh);
    }
    return group;
  }

  woodMaterial(tone) {
    return new THREE.MeshStandardMaterial({ color: WOOD_A.clone().lerp(WOOD_B, tone), roughness: 0.78 });
  }

  buildHand() {
    const skin = new THREE.MeshStandardMaterial({ color: 0xf0c8a4, roughness: 0.65 });
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x3f6fa8, roughness: 0.8 });
    const hand = new THREE.Group();
    const palm = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.34, 1), skin);
    palm.castShadow = true;
    hand.add(palm);
    const knuckles = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 1.16, 6, 12), skin);
    knuckles.rotation.z = Math.PI / 2;
    hand.add(knuckles);
    this.knuckles = knuckles;

    const finger = (x) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, -0.05, 0.5);
      const a = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.36, 6, 10), skin);
      a.position.y = -0.3; a.castShadow = true;
      const b = new THREE.Mesh(new THREE.CapsuleGeometry(0.135, 0.26, 6, 10), skin);
      b.position.y = -0.72; b.castShadow = true;
      pivot.add(a, b);
      hand.add(pivot);
      return pivot;
    };
    this.fingers = [-0.56, -0.19, 0.19, 0.56].map(finger);
    const thumb = new THREE.Group();
    thumb.position.set(-0.3, -0.05, -0.5);
    const t1 = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.5, 6, 10), skin);
    t1.position.y = -0.38; t1.castShadow = true;
    thumb.add(t1);
    hand.add(thumb);
    this.thumb = thumb;

    const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 1.2, 20), skin);
    wrist.position.y = 0.7;
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.56, 60, 20), sleeve);
    arm.position.y = 31.2; arm.castShadow = true;
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.68, 0.68, 0.5, 20),
      new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.8 }));
    cuff.position.y = 1.35;
    hand.add(wrist, arm, cuff);

    this.held = new THREE.Group(); // the piece under the palm
    hand.add(this.held);
    hand.visible = false;
    this.hand = hand;
    this.palm = palm;
    this.scene.add(hand);
  }

  // Fit the fingers to the piece being held and rebuild its mesh if it changed.
  fitHand() {
    const g = this.game;
    const cells = g.piece.cells;
    const key = g.piece.kind + JSON.stringify(cells);
    const { w, d } = g.pieceSize();
    if (key !== this.heldKey) {
      this.heldKey = key;
      this.held.clear();
      const mesh = this.pieceMesh(cells, this.woodMaterial(0.3));
      mesh.position.set(-w / 2, 0, -d / 2);
      this.held.add(mesh);
      this.ghost.clear();
      const gm = this.pieceMesh(cells, new THREE.MeshBasicMaterial({ color: 0xffa726, transparent: true, opacity: 0.38, depthWrite: false }), 0xd9820f);
      gm.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
      this.ghost.add(gm);
    }
    const h = g.cfg.cellHeight;
    this.held.position.y = -(0.17 + h / 2 + 0.02);
    const half = d / 2 + 0.16;
    this.palm.scale.set(Math.max(0.8, Math.min(1.25, w / 2 + 0.25)), 1, (half * 2) / 1);
    for (const f of this.fingers) f.position.z = half;
    this.thumb.position.z = -half;
    this.knuckles.position.z = half;
  }

  // ---------------------------------------------------------------- sizing and camera

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 55 : 40;
    this.camera.updateProjectionMatrix();
  }

  orbit(dx, dy) {
    const o = this.orbitState;
    o.theta -= dx * 0.008;
    o.phi = Math.max(0.12, Math.min(1.5, o.phi - dy * 0.006));
  }

  zoom(delta) {
    const o = this.orbitState;
    o.radius = Math.max(6, Math.min(34, o.radius * Math.exp(delta * 0.0012)));
  }

  // Unit vector, in the ground plane, from the tower towards the camera.
  cameraDir() {
    const o = this.orbitState;
    return { x: Math.sin(o.theta), z: Math.cos(o.theta) };
  }

  placeCamera() {
    const o = this.orbitState;
    const wantY = Math.max(2.2, (this.game.topY || 4.8) * 0.5 + 0.6);
    this.target.y += (wantY - this.target.y) * 0.05;
    const sp = Math.sin(o.phi);
    this.camera.position.set(
      this.target.x + o.radius * sp * Math.sin(o.theta),
      this.target.y + o.radius * Math.cos(o.phi),
      this.target.z + o.radius * sp * Math.cos(o.theta));
    this.camera.lookAt(this.target);
  }

  ray(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray;
  }

  // Which block is under the pointer?
  pickBlock(clientX, clientY) {
    this.ray(clientX, clientY);
    // Test the solid boxes only; the outline lines would give false hits.
    const boxes = [];
    for (const grp of this.groups.values()) boxes.push(...grp.children);
    const hit = this.raycaster.intersectObjects(boxes, false)[0];
    return hit ? this.game.blocks.get(hit.object.parent.userData.blockId) || null : null;
  }

  // Where the pointer meets the top of the tower.
  aimPoint(clientX, clientY) {
    const ray = this.ray(clientX, clientY);
    const y = this.game.topY;
    if (Math.abs(ray.direction.y) < 1e-4) return null;
    const t = (y - ray.origin.y) / ray.direction.y;
    if (t <= 0) return null;
    return { x: ray.origin.x + ray.direction.x * t, z: ray.origin.z + ray.direction.z * t };
  }

  screenPos(v) {
    const p = new THREE.Vector3(v.x, v.y, v.z).project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * window.innerWidth, y: (-p.y * 0.5 + 0.5) * window.innerHeight };
  }

  // ---------------------------------------------------------------- hand

  // Lower the piece to `y`, let go (onRelease creates the real block), leave.
  startDrop(y, onRelease) {
    this.drop = { t: 0, fromY: this.handY, toY: y + this.game.cfg.cellHeight / 2 + 0.19, released: false, onRelease };
  }

  updateHand(dt) {
    const g = this.game;
    const h = g.cfg.cellHeight;
    const sky = (g.topY || 5) + 16;
    const aiming = g.state === 'aim';

    if (this.drop) {
      const d = this.drop;
      d.t += dt;
      if (d.t < 0.45) {
        this.handY = d.fromY + (d.toY - d.fromY) * ease(d.t / 0.45);
      } else if (!d.released) {
        this.handY = d.toY;
        d.released = true;
        this.held.visible = false;
        d.onRelease();
      } else if (d.t < 0.7) {
        this.grip = Math.max(0, 1 - (d.t - 0.45) / 0.2);
      } else if (d.t < 1.5) {
        this.handY = d.toY + (sky - d.toY) * ease((d.t - 0.7) / 0.8);
      } else {
        this.drop = null;
        this.handShown = false;
      }
    } else if (aiming) {
      this.fitHand();
      const { w, d } = g.pieceSize();
      const cx = g.aim.ix + w / 2, cz = g.aim.iz + d / 2;
      const landing = g.landingY();
      const hoverY = Math.max(landing + 1.7, g.topY + 1.5) + h / 2 + 0.19;
      if (!this.handShown) {
        // a new piece arrives from the sky
        this.handShown = true;
        this.handY = sky;
        this.hand.position.set(cx, sky, cz);
        this.held.visible = true;
        this.grip = 1;
      }
      this.handY += (hoverY - this.handY) * Math.min(1, dt * 6);
      this.hand.position.x += (cx - this.hand.position.x) * Math.min(1, dt * 14);
      this.hand.position.z += (cz - this.hand.position.z) * Math.min(1, dt * 14);
      this.ghost.visible = true;
      this.ghost.position.set(g.aim.ix, landing, g.aim.iz);
    } else {
      this.handShown = false;
    }
    if (!aiming) this.ghost.visible = false;

    this.hand.visible = this.handShown || !!this.drop;
    this.hand.position.y = this.handY;
    // fingers curl in around the piece when gripping, swing out when open
    const curl = -0.12 * this.grip + 0.75 * (1 - this.grip);
    for (const f of this.fingers) f.rotation.x = curl;
    this.thumb.rotation.x = -curl;
  }

  // ---------------------------------------------------------------- blocks

  // Work out once, when the Puller's move begins, what can be pulled.
  refreshPullInfo() {
    this.pullInfo.clear();
    for (const blk of this.game.blocks.values()) {
      const can = this.game.canPull(blk);
      this.pullInfo.set(blk.id, { can, tier: can ? this.game.tier(blk) : 0 });
    }
  }

  syncBlocks() {
    const g = this.game;
    for (const id of g.removed) {
      const grp = this.groups.get(id);
      if (grp) { this.scene.remove(grp); this.groups.delete(id); }
    }
    g.removed.length = 0;
    const choosing = g.state === 'choose';
    const pulse = 0.5 + 0.5 * Math.sin(this.clock * 6);
    for (const blk of g.blocks.values()) {
      let grp = this.groups.get(blk.id);
      if (!grp) {
        const cells = blk.cells.map((c) => [c.lx - 0.5, c.lz - 0.5]);
        grp = this.pieceMesh(cells, this.woodMaterial(blk.tone));
        grp.userData.blockId = blk.id;
        grp.userData.wood = grp.children[0].material.color.clone();
        this.groups.set(blk.id, grp);
        this.scene.add(grp);
      }
      grp.position.set(blk.pos.x, blk.pos.y, blk.pos.z);
      grp.quaternion.set(blk.rot.x, blk.rot.y, blk.rot.z, blk.rot.w);

      const mat = grp.children[0].material;
      const info = this.pullInfo.get(blk.id);
      if (choosing && info) {
        if (info.can) mat.color.setHex(TIER_COLOURS[info.tier]);
        else mat.color.copy(grp.userData.wood).multiplyScalar(0.5);
      } else {
        mat.color.copy(grp.userData.wood);
      }
      const hot = choosing && info && info.can && (blk.id === this.hoverId || blk.id === this.selectedId);
      const sel = blk.id === this.selectedId;
      mat.emissive.setHex(hot ? 0xffffff : 0x000000);
      mat.emissiveIntensity = hot ? (sel ? 0.25 + 0.2 * pulse : 0.18) : 0;
    }

    // arrow showing which way the chosen block will slide
    const id = this.selectedId ?? this.hoverId;
    const blk = choosing && id != null ? g.blocks.get(id) : null;
    const info = blk && this.pullInfo.get(blk.id);
    if (blk && info && info.can) {
      const dir = g.pullDir(blk, this.cameraDir());
      if (dir) {
        const c = g.centre(blk);
        // start just outside the end of the block
        let reach = 0;
        for (const cell of blk.cells) {
          const p = g.cellPos(blk, cell);
          reach = Math.max(reach, (p.x - c.x) * dir.x + (p.z - c.z) * dir.z + 0.5);
        }
        const off = reach + 0.15 + 0.15 * pulse;
        this.arrow.position.set(c.x + dir.x * off, c.y, c.z + dir.z * off);
        this.arrow.rotation.y = Math.atan2(-dir.z, dir.x);
        this.arrow.visible = true;
      } else this.arrow.visible = false;
    } else {
      this.arrow.visible = false;
    }
  }

  render(dt) {
    this.clock += dt;
    if (this.game.world) {
      this.syncBlocks();
      this.updateHand(dt);
    }
    this.placeCamera();
    this.renderer.render(this.scene, this.camera);
  }
}
