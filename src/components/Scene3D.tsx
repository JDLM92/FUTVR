import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Actor, Annotation, Scene3DProps, Vec2 } from "../domain/types";

type Interaction = "explore" | "move" | "arrow" | "zone";
type CameraView = "overview" | "player";
type Controller = ReturnType<THREE.WebGLRenderer["xr"]["getController"]>;
type Drag = {
  actorId?: string;
  start: Vec2;
  end: Vec2;
  offset?: Vec2;
  controller?: THREE.Group;
  pointerId?: number;
};
type ActorMesh = {
  group: THREE.Group;
  pick: THREE.Mesh;
  label: THREE.Sprite;
  signature: string;
};
type Runtime = {
  setInteraction: (mode: Interaction) => void;
  view: (view: CameraView) => void;
  enterXR: () => Promise<void>;
  cancel: () => void;
  sync: () => void;
  redraw: () => void;
  playPause: () => void;
  undo: () => void;
};
const TEAM_COLORS = {
  a: "#f47345",
  b: "#86acd3",
  unknown: "#b8bcc4",
  official: "#f4d164",
};
const ANNOTATION_COLOR = "#ffe387";

function disposeTree(object: THREE.Object3D) {
  object.traverse((child) => {
    if (
      child instanceof THREE.Mesh ||
      child instanceof THREE.Line ||
      child instanceof THREE.Sprite
    ) {
      if ("geometry" in child) child.geometry?.dispose();
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      materials.forEach((material) => {
        if ("map" in material && material.map instanceof THREE.Texture)
          material.map.dispose();
        material.dispose();
      });
    }
  });
}

function textTexture(
  text: string,
  color = "#f8faf7",
  background = "#163b2d",
  width = 512,
  height = 128,
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = background;
  context.beginPath();
  context.roundRect(0, 0, width, height, 24);
  context.fill();
  context.font = `600 ${height * 0.39}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = color;
  const display = text.length > 24 ? `${text.slice(0, 23)}…` : text;
  context.fillText(display, width / 2, height / 2, width - 40);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function labelSprite(text: string) {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: textTexture(text),
      depthTest: false,
      transparent: true,
    }),
  );
  sprite.scale.set(7.5, 1.8, 1);
  sprite.position.y = 3.5;
  sprite.renderOrder = 10;
  return sprite;
}

function makeActor(actor: Actor): ActorMesh {
  const group = new THREE.Group();
  group.userData.actorId = actor.id;
  const color = TEAM_COLORS[actor.team];
  const material = (value: string) =>
    new THREE.MeshLambertMaterial({ color: value });
  const add = (
    geometry: THREE.BufferGeometry,
    fill: string,
    position: [number, number, number],
    rotation?: [number, number, number],
  ) => {
    const mesh = new THREE.Mesh(geometry, material(fill));
    mesh.position.set(...position);
    if (rotation) mesh.rotation.set(...rotation);
    group.add(mesh);
    return mesh;
  };
  if (actor.role === "ball") {
    add(new THREE.IcosahedronGeometry(0.33, 1), "#f8f7e9", [0, 0.34, 0]);
    add(new THREE.OctahedronGeometry(0.16), "#233b34", [0, 0.38, 0.24]);
  } else {
    add(new THREE.CylinderGeometry(0.33, 0.39, 0.7, 8), color, [0, 1.18, 0]);
    add(
      new THREE.CylinderGeometry(0.35, 0.32, 0.32, 8),
      actor.team === "b" ? "#2e3a72" : "#854c3c",
      [0, 0.69, 0],
    );
    add(new THREE.SphereGeometry(0.28, 10, 8), "#d8aa87", [0, 1.78, 0]);
    add(
      new THREE.SphereGeometry(0.29, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.43),
      "#3d3028",
      [0, 1.81, 0],
    );
    for (const side of [-1, 1]) {
      add(new THREE.CylinderGeometry(0.085, 0.075, 0.45, 6), "#f6eedb", [
        side * 0.16,
        0.35,
        0,
      ]);
      const boot = add(new THREE.SphereGeometry(0.14, 8, 6), "#243a31", [
        side * 0.16,
        0.105,
        0.075,
      ]);
      boot.scale.z = 1.5;
      add(
        new THREE.CylinderGeometry(0.1, 0.085, 0.57, 6),
        "#d8aa87",
        [side * 0.47, 1.1, 0],
        [0, 0, side * 0.12],
      );
    }
    if (actor.number) {
      const number = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: textTexture(actor.number, "#fffdf1", color, 128, 128),
          depthTest: true,
        }),
      );
      number.scale.set(0.6, 0.6, 1);
      number.position.set(0, 2.45, 0);
      group.add(number);
    }
  }
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(actor.role === "ball" ? 0.42 : 0.66, 20),
    new THREE.MeshBasicMaterial({
      color: "#0d3523",
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.045;
  group.add(shadow);
  const pick = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 0.9, 2.8, 8),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }),
  );
  pick.position.y = 1.2;
  pick.userData.actorId = actor.id;
  group.add(pick);
  const label = labelSprite(
    actor.name ||
      actor.label ||
      (actor.role === "ball"
        ? "Ball"
        : `${actor.team === "a" ? "A" : actor.team === "b" ? "B" : ""} ${actor.number || "Player"}`),
  );
  group.add(label);
  return {
    group,
    pick,
    label,
    signature: [
      actor.role,
      actor.team,
      actor.name,
      actor.label,
      actor.number,
    ].join("|"),
  };
}

function addPitch(group: THREE.Group, length: number, width: number) {
  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(length, width),
    new THREE.MeshLambertMaterial({ color: "#548464" }),
  );
  surface.rotation.x = -Math.PI / 2;
  group.add(surface);
  for (let index = 0; index < 10; index++) {
    if (index % 2) continue;
    const stripe = new THREE.Mesh(
      new THREE.PlaneGeometry(length / 10, width),
      new THREE.MeshLambertMaterial({ color: "#5e8f6d" }),
    );
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(-length / 2 + (length / 10) * (index + 0.5), 0.012, 0);
    group.add(stripe);
  }
  const lineMaterial = new THREE.LineBasicMaterial({
    color: "#e6edcf",
    transparent: true,
    opacity: 0.85,
  });
  const line = (points: [number, number][], close = false) => {
    const vertices = points.map(([x, z]) => new THREE.Vector3(x, 0.04, z));
    if (close) vertices.push(vertices[0].clone());
    group.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(vertices),
        lineMaterial.clone(),
      ),
    );
  };
  line(
    [
      [-length / 2, -width / 2],
      [length / 2, -width / 2],
      [length / 2, width / 2],
      [-length / 2, width / 2],
    ],
    true,
  );
  line([
    [0, -width / 2],
    [0, width / 2],
  ]);
  const circle = (x: number, z: number, radius: number) =>
    line(
      Array.from({ length: 65 }, (_, i) => [
        x + Math.cos((i / 64) * Math.PI * 2) * radius,
        z + Math.sin((i / 64) * Math.PI * 2) * radius,
      ]),
    );
  circle(0, 0, Math.min(9.15, width * 0.15));
  for (const side of [-1, 1]) {
    const x = (side * length) / 2;
    const boxDepth = Math.min(16.5, length * 0.17),
      boxWidth = Math.min(40.32, width * 0.6);
    const smallDepth = Math.min(5.5, length * 0.06),
      smallWidth = Math.min(18.32, width * 0.28);
    line([
      [x, -boxWidth / 2],
      [x - side * boxDepth, -boxWidth / 2],
      [x - side * boxDepth, boxWidth / 2],
      [x, boxWidth / 2],
    ]);
    line([
      [x, -smallWidth / 2],
      [x - side * smallDepth, -smallWidth / 2],
      [x - side * smallDepth, smallWidth / 2],
      [x, smallWidth / 2],
    ]);
    const spot = new THREE.Mesh(
      new THREE.CircleGeometry(0.17, 12),
      new THREE.MeshBasicMaterial({ color: "#e6edcf" }),
    );
    spot.rotation.x = -Math.PI / 2;
    spot.position.set(x - side * Math.min(11, length * 0.11), 0.05, 0);
    group.add(spot);
    const goalWidth = Math.min(7.32, width * 0.12),
      goalHeight = 2.44;
    const goalMaterial = new THREE.MeshLambertMaterial({ color: "#ecf1dc" });
    for (const goalSide of [-1, 1]) {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.075, 0.075, goalHeight, 6),
        goalMaterial.clone(),
      );
      post.position.set(x, goalHeight / 2, (goalSide * goalWidth) / 2);
      group.add(post);
    }
    const bar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.075, goalWidth, 6),
      goalMaterial.clone(),
    );
    bar.rotation.x = Math.PI / 2;
    bar.position.set(x, goalHeight, 0);
    group.add(bar);
    const net = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, goalHeight, goalWidth),
      new THREE.MeshBasicMaterial({
        color: "#d5e2cd",
        wireframe: true,
        transparent: true,
        opacity: 0.35,
      }),
    );
    net.position.set(x + side * 0.9, goalHeight / 2, 0);
    group.add(net);
    goalMaterial.dispose();
  }
  lineMaterial.dispose();
  return surface;
}

function annotationMesh(annotation: Annotation, length: number, width: number) {
  const group = new THREE.Group();
  const start = new THREE.Vector3(
    annotation.start.x - length / 2,
    0.08,
    annotation.start.y - width / 2,
  );
  const end = new THREE.Vector3(
    annotation.end.x - length / 2,
    0.08,
    annotation.end.y - width / 2,
  );
  const material = new THREE.MeshBasicMaterial({
    color: annotation.color,
    depthWrite: false,
  });
  const segment = (
    from: THREE.Vector3,
    to: THREE.Vector3,
    thickness = 0.13,
  ) => {
    const delta = to.clone().sub(from);
    if (delta.length() < 0.02) return;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(thickness, thickness, delta.length(), 6),
      material.clone(),
    );
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      delta.normalize(),
    );
    group.add(mesh);
  };
  if (annotation.kind === "zone") {
    const zone = new THREE.Mesh(
      new THREE.PlaneGeometry(
        Math.max(0.1, Math.abs(end.x - start.x)),
        Math.max(0.1, Math.abs(end.z - start.z)),
      ),
      new THREE.MeshBasicMaterial({
        color: annotation.color,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    zone.rotation.x = -Math.PI / 2;
    zone.position.copy(start).add(end).multiplyScalar(0.5);
    group.add(zone);
    const corners = [
      start,
      new THREE.Vector3(end.x, 0.08, start.z),
      end,
      new THREE.Vector3(start.x, 0.08, end.z),
    ];
    corners.forEach((point, i) => segment(point, corners[(i + 1) % 4], 0.09));
  } else if (annotation.kind === "circle") {
    const radius = Math.max(0.1, start.distanceTo(end));
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(0.01, radius - 0.13), radius + 0.13, 48),
      new THREE.MeshBasicMaterial({
        color: annotation.color,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(start);
    group.add(ring);
  } else if (annotation.kind === "label") {
    const label = labelSprite(annotation.text || "Note");
    label.position.copy(start).add(new THREE.Vector3(0, 1.8, 0));
    group.add(label);
  } else {
    segment(start, end);
    if (annotation.kind === "arrow" && end.distanceTo(start) > 0.2) {
      const direction = end.clone().sub(start).normalize();
      const back = end
        .clone()
        .addScaledVector(
          direction,
          -Math.min(1.8, start.distanceTo(end) * 0.3),
        );
      const normal = new THREE.Vector3(
        -direction.z,
        0,
        direction.x,
      ).multiplyScalar(0.7);
      segment(back.clone().add(normal), end, 0.16);
      segment(back.clone().sub(normal), end, 0.16);
    }
  }
  material.dispose();
  return group;
}

export function Scene3D(props: Scene3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const runtimeRef = useRef<Runtime | null>(null);
  const [interaction, setInteraction] = useState<Interaction>("explore");
  const [cameraView, setCameraView] = useState<CameraView>("overview");
  const [xrActive, setXRActive] = useState(false);
  const [support, setSupport] = useState({ checking: true, vr: false });
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const detect = async () => {
      if (!window.isSecureContext || !navigator.xr) {
        if (!cancelled) setSupport({ checking: false, vr: false });
        return;
      }
      try {
        const supported = await navigator.xr.isSessionSupported("immersive-vr");
        if (!cancelled) setSupport({ checking: false, vr: supported });
      } catch {
        if (!cancelled) setSupport({ checking: false, vr: false });
      }
    };
    void detect();
    navigator.xr?.addEventListener("devicechange", detect);
    return () => {
      cancelled = true;
      navigator.xr?.removeEventListener("devicechange", detect);
    };
  }, []);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    const length = props.scene.pitch.length,
      width = props.scene.pitch.width;
    let disposed = false;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: "high-performance",
      });
    } catch {
      const message =
        "3D graphics are unavailable in this browser. You can continue in the tactical board.";
      setFailed(true);
      latest.current.onError(message);
      return;
    }
    setFailed(false);
    setInteraction("explore");
    setCameraView("overview");
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local");
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.setAttribute(
      "aria-label",
      "Interactive 3D football pitch",
    );
    renderer.domElement.setAttribute("role", "img");
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#dce6d8");
    scene.add(new THREE.HemisphereLight("#fff8dc", "#648c73", 2.6));
    const sunlight = new THREE.DirectionalLight("#fff6df", 2.1);
    sunlight.position.set(-25, 55, 25);
    scene.add(sunlight);
    const world = new THREE.Group();
    scene.add(world);
    const pitch = new THREE.Group();
    world.add(pitch);
    const surface = addPitch(pitch, length, width);
    const actorsGroup = new THREE.Group(),
      annotationsGroup = new THREE.Group();
    world.add(actorsGroup, annotationsGroup);
    const selectedRing = new THREE.Mesh(
      new THREE.RingGeometry(0.84, 1.02, 36),
      new THREE.MeshBasicMaterial({ color: "#fff1a0", side: THREE.DoubleSide }),
    );
    selectedRing.rotation.x = -Math.PI / 2;
    selectedRing.position.y = 0.08;
    selectedRing.visible = false;
    world.add(selectedRing);
    const camera = new THREE.PerspectiveCamera(43, 1, 0.05, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.maxPolarAngle = Math.PI / 2.06;
    const raycaster = new THREE.Raycaster();
    const cursor = new THREE.Vector2();
    const actorMeshes = new Map<string, ActorMesh>();
    let mode: Interaction = "explore";
    let view: CameraView = "overview";
    let povId: string | null = null;
    let drag: Drag | null = null;
    let preview: THREE.Group | null = null;
    let flatPointer: { id: number; x: number; y: number } | null = null;
    let activeSession: XRSession | null = null;
    let sessionPending = false;
    let placeXR = false;
    let fade: {
      started: number;
      next: CameraView;
      action: () => void;
      ran: boolean;
    } | null = null;
    let announcement = "";
    let panelSignature = "";
    let needsRender = true;
    let pausePending = false;
    let previewUpdatedAt = 0;
    const playerPosition = (id: string): Vec2 | undefined =>
      latest.current.positions[id] ||
      latest.current.scene.actors.find((actor) => actor.id === id)?.position;
    const toPoint = (position: Vec2) =>
      new THREE.Vector3(position.x - length / 2, 0, position.y - width / 2);
    const clampPosition = (point: THREE.Vector3): Vec2 => ({
      x: Math.max(0, Math.min(length, point.x + length / 2)),
      y: Math.max(0, Math.min(width, point.z + width / 2)),
    });
    const pause = () => {
      if (!latest.current.isPlaying || pausePending) return;
      pausePending = true;
      latest.current.onPlayPause();
    };
    const clearPreview = () => {
      if (!preview) return;
      world.remove(preview);
      disposeTree(preview);
      preview = null;
      needsRender = true;
    };
    const cancel = () => {
      drag = null;
      clearPreview();
      controls.enabled = !activeSession && mode === "explore";
      announcement = "Action cancelled";
      needsRender = true;
    };
    const setMode = (next: Interaction) => {
      if (next !== "explore" && latest.current.readOnly) return;
      cancel();
      mode = next;
      setInteraction(next);
      if (next !== "explore") {
        pause();
        if (view !== "overview") switchView("overview");
      }
      controls.enabled = !activeSession && next === "explore";
    };
    const fitOverviewCamera = () => {
      const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const distance =
        Math.max(
          length / (2 * tangent * Math.max(0.25, camera.aspect)),
          (width * 0.8) / (2 * tangent),
        ) +
        width * 0.3 +
        5;
      camera.position.set(0, distance * 0.8, distance * 0.6);
      controls.target.set(0, 0, 0);
      controls.minDistance = length * 0.13;
      controls.maxDistance = Math.max(length * 2.1, distance * 1.6);
      controls.update();
    };
    const overview = () => {
      view = "overview";
      povId = null;
      setCameraView("overview");
      setNotice("");
      needsRender = true;
      if (activeSession) {
        const eye = renderer.xr
          .getCamera()
          .getWorldPosition(new THREE.Vector3());
        world.scale.setScalar(2.15 / length);
        world.position.set(eye.x, eye.y - 0.67, eye.z - 1.85);
      } else {
        world.scale.setScalar(1);
        world.position.set(0, 0, 0);
        controls.enablePan = true;
        controls.maxPolarAngle = Math.PI / 2.06;
        fitOverviewCamera();
      }
    };
    const playerView = () => {
      const id = latest.current.selectedId;
      const position = id && playerPosition(id);
      if (!id || !position) {
        setNotice("Select a player to see the pitch from their position.");
        announcement = "Select a player first";
        return;
      }
      cancel();
      mode = "explore";
      setInteraction("explore");
      view = "player";
      povId = id;
      setCameraView("player");
      needsRender = true;
      const point = toPoint(position);
      if (activeSession) {
        const eye = renderer.xr
          .getCamera()
          .getWorldPosition(new THREE.Vector3());
        world.scale.setScalar(1);
        world.position.set(eye.x - point.x, eye.y - 1.65, eye.z - point.z);
      } else {
        world.scale.setScalar(1);
        world.position.set(0, 0, 0);
        camera.position.copy(point).add(new THREE.Vector3(0, 1.65, 0));
        const actor = latest.current.scene.actors.find(
          (item) => item.id === id,
        );
        const direction = actor?.team === "b" ? -1 : 1;
        controls.target
          .copy(point)
          .add(new THREE.Vector3(direction * 12, 1.4, 0));
        controls.minDistance = 1;
        controls.maxDistance = 22;
        controls.maxPolarAngle = Math.PI * 0.88;
        controls.enablePan = false;
        controls.enabled = true;
        controls.update();
      }
      setNotice(
        "An approximate viewpoint at this player’s position. Facing direction is not inferred from the screenshot.",
      );
    };
    const fadeMaterial = new THREE.MeshBasicMaterial({
      color: "#081a12",
      transparent: true,
      opacity: 0,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    const fadeMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.75, 12, 8),
      fadeMaterial,
    );
    fadeMesh.renderOrder = 1000;
    fadeMesh.visible = false;
    scene.add(fadeMesh);
    function switchView(next: CameraView) {
      if (fade?.next === next) return;
      if (next === "player" && !latest.current.selectedId) {
        playerView();
        return;
      }
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        next === "overview" ? overview() : playerView();
        return;
      }
      const requestedId = latest.current.selectedId;
      fade = {
        started: performance.now(),
        next,
        ran: false,
        action: () =>
          next === "overview" || requestedId !== latest.current.selectedId
            ? overview()
            : playerView(),
      };
    }
    overview();

    const panel = new THREE.Group();
    panel.visible = false;
    scene.add(panel);
    const panelBackground = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 0.62),
      new THREE.MeshBasicMaterial({ color: "#112e23", side: THREE.DoubleSide }),
    );
    panel.add(panelBackground);
    const titleSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: textTexture("FutVR · Tabletop", "#f3f5dc", "#112e23", 1024, 100),
        depthTest: false,
      }),
    );
    titleSprite.scale.set(1.5, 0.135, 1);
    titleSprite.position.set(0, 0.235, 0.006);
    panel.add(titleSprite);
    const panelActions = [
      "explore",
      "move",
      "arrow",
      "zone",
      "player",
      "overview",
      "play",
      "undo",
      "cancel",
      "exit",
    ];
    const panelButtons: {
      mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
      action: string;
    }[] = [];
    panelActions.forEach((action, index) => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.3, 0.125),
        new THREE.MeshBasicMaterial({
          map: textTexture(action),
          side: THREE.DoubleSide,
          depthTest: false,
        }),
      );
      const column = index % 5,
        row = Math.floor(index / 5);
      mesh.position.set((column - 2) * 0.323, 0.047 - row * 0.153, 0.012);
      mesh.userData.action = action;
      mesh.renderOrder = 30;
      panel.add(mesh);
      panelButtons.push({ mesh, action });
    });
    const statusSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: textTexture(
          "Point and select · Explore",
          "#dae6d5",
          "#112e23",
          1024,
          100,
        ),
        depthTest: false,
      }),
    );
    statusSprite.scale.set(1.5, 0.095, 1);
    statusSprite.position.set(0, -0.25, 0.006);
    panel.add(statusSprite);
    const replaceTexture = (
      material: THREE.SpriteMaterial | THREE.MeshBasicMaterial,
      texture: THREE.Texture,
    ) => {
      material.map?.dispose();
      material.map = texture;
      material.needsUpdate = true;
    };
    const updatePanel = () => {
      const selected = latest.current.scene.actors.find(
        (actor) => actor.id === latest.current.selectedId,
      );
      const signature = [
        mode,
        view,
        latest.current.isPlaying,
        latest.current.readOnly,
        selected?.id,
        selected?.name,
        selected?.number,
        announcement,
      ].join("|");
      if (signature === panelSignature) return;
      panelSignature = signature;
      replaceTexture(
        titleSprite.material,
        textTexture(
          selected
            ? `Selected: ${selected.name || selected.number || "Player"}`
            : "FutVR · Select a player",
          "#f3f5dc",
          "#112e23",
          1024,
          100,
        ),
      );
      const names: Record<string, string> = {
        explore: "Explore",
        move: "Move",
        arrow: "Arrow",
        zone: "Zone",
        player: "Player view",
        overview: "Tabletop",
        play: latest.current.isPlaying ? "Pause" : "Play",
        undo: "Undo",
        cancel: "Cancel",
        exit: "Exit VR",
      };
      panelButtons.forEach(({ mesh, action }) => {
        const disabled =
          latest.current.readOnly &&
          ["move", "arrow", "zone", "undo"].includes(action);
        const active =
          action === mode || (action === "overview" && view === "overview");
        replaceTexture(
          mesh.material,
          textTexture(
            names[action],
            disabled ? "#788b80" : "#f4f7e8",
            active ? "#53795c" : "#234638",
          ),
        );
      });
      replaceTexture(
        statusSprite.material,
        textTexture(
          announcement ||
            (mode === "explore"
              ? "Point and select · Explore"
              : mode === "move"
                ? "Hold trigger to move · Release to save"
                : "Hold trigger on pitch · Release to draw"),
          "#dae6d5",
          "#112e23",
          1024,
          100,
        ),
      );
    };
    const panelAction = (action: string) => {
      announcement = "";
      if (["explore", "move", "arrow", "zone"].includes(action))
        setMode(action as Interaction);
      else if (action === "player") switchView("player");
      else if (action === "overview") switchView("overview");
      else if (action === "play") playPause();
      else if (action === "undo") undo();
      else if (action === "cancel") cancel();
      else if (action === "exit") void activeSession?.end();
    };
    const playPause = () => {
      setMode("explore");
      pausePending = false;
      latest.current.onPlayPause();
    };
    const undo = () => {
      if (!latest.current.readOnly) {
        cancel();
        pause();
        latest.current.onUndo();
      }
    };
    const panelInFront = () => {
      const xrCamera = renderer.xr.getCamera();
      const eye = xrCamera.getWorldPosition(new THREE.Vector3());
      const forward = xrCamera.getWorldDirection(new THREE.Vector3());
      forward.y = 0;
      if (forward.lengthSq() < 0.001) forward.set(0, 0, -1);
      forward.normalize();
      panel.position.copy(eye).addScaledVector(forward, 1.28);
      panel.position.y = eye.y - 0.57;
      panel.lookAt(eye);
    };
    const controllerRay = (controller: THREE.Group) => {
      controller.updateWorldMatrix(true, false);
      const rotation = new THREE.Matrix4().extractRotation(
        controller.matrixWorld,
      );
      raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      raycaster.ray.direction.set(0, 0, -1).applyMatrix4(rotation).normalize();
    };
    const pitchHit = (): Vec2 | null => {
      world.updateWorldMatrix(true, true);
      const hit = raycaster.intersectObject(surface, false)[0];
      return hit ? clampPosition(world.worldToLocal(hit.point.clone())) : null;
    };
    const actorHit = () => {
      actorsGroup.updateWorldMatrix(true, true);
      return raycaster.intersectObjects(
        Array.from(actorMeshes.values())
          .filter((item) => item.group.visible)
          .map((item) => item.pick),
        false,
      )[0]?.object.userData.actorId as string | undefined;
    };
    const begin = (controller?: THREE.Group, pointerId?: number) => {
      if (controller) {
        const hit = raycaster.intersectObjects(
          panelButtons.map((button) => button.mesh),
          false,
        )[0];
        if (hit) {
          panelAction(hit.object.userData.action as string);
          return;
        }
      }
      const id = actorHit();
      if (mode === "explore") {
        latest.current.onSelect(id || null);
        announcement = "";
        return;
      }
      if (latest.current.readOnly) return;
      pause();
      if (mode === "move") {
        if (!id) {
          announcement = "Point at a player or the ball";
          return;
        }
        const position = playerPosition(id);
        if (!position) return;
        latest.current.onSelect(id);
        const ground = pitchHit();
        const offset = ground
          ? { x: position.x - ground.x, y: position.y - ground.y }
          : undefined;
        drag = {
          actorId: id,
          start: { ...position },
          end: { ...position },
          offset,
          controller,
          pointerId,
        };
      } else {
        const point = pitchHit();
        if (point) drag = { start: point, end: point, controller, pointerId };
      }
    };
    const updateDrag = () => {
      if (!drag) return;
      const ground = pitchHit();
      if (!ground) return;
      const point = drag.offset
        ? {
            x: Math.max(0, Math.min(length, ground.x + drag.offset.x)),
            y: Math.max(0, Math.min(width, ground.y + drag.offset.y)),
          }
        : ground;
      if (Math.hypot(point.x - drag.end.x, point.y - drag.end.y) < 0.025)
        return;
      drag.end = point;
      needsRender = true;
      if (drag.actorId) {
        const item = actorMeshes.get(drag.actorId);
        if (item) item.group.position.copy(toPoint(point));
      } else {
        if (performance.now() - previewUpdatedAt < 33) return;
        previewUpdatedAt = performance.now();
        clearPreview();
        preview = annotationMesh(
          {
            id: "preview",
            kind: mode === "zone" ? "zone" : "arrow",
            start: drag.start,
            end: point,
            color: ANNOTATION_COLOR,
          },
          length,
          width,
        );
        world.add(preview);
      }
    };
    const finish = () => {
      if (!drag) return;
      const pending = drag;
      drag = null;
      clearPreview();
      needsRender = true;
      if (latest.current.readOnly) return;
      const distance = Math.hypot(
        pending.end.x - pending.start.x,
        pending.end.y - pending.start.y,
      );
      if (distance < 0.15) return;
      if (pending.actorId) latest.current.onMove(pending.actorId, pending.end);
      else
        latest.current.onAnnotation({
          id: crypto.randomUUID(),
          kind: mode === "zone" ? "zone" : "arrow",
          start: pending.start,
          end: pending.end,
          color: ANNOTATION_COLOR,
        });
      announcement = pending.actorId
        ? "Position saved · Undo available"
        : "Annotation added · Undo available";
    };
    const controllers: THREE.Group[] = [];
    const controllerHandlers: {
      controller: Controller;
      start: () => void;
      end: () => void;
      disconnect: () => void;
    }[] = [];
    for (let index = 0; index < 2; index++) {
      const controller = renderer.xr.getController(index);
      const ray = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(),
          new THREE.Vector3(0, 0, -4),
        ]),
        new THREE.LineBasicMaterial({
          color: "#e8d69d",
          transparent: true,
          opacity: 0.65,
        }),
      );
      controller.add(ray);
      scene.add(controller);
      controllers.push(controller);
      const start = () => {
        controllerRay(controller);
        begin(controller);
      };
      const end = () => {
        if (drag?.controller === controller) {
          controllerRay(controller);
          updateDrag();
          finish();
        }
      };
      const disconnect = () => {
        if (drag?.controller === controller) cancel();
      };
      controller.addEventListener("selectstart", start);
      controller.addEventListener("selectend", end);
      controller.addEventListener("disconnected", disconnect);
      controllerHandlers.push({ controller, start, end, disconnect });
    }
    const pointerRay = (event: PointerEvent) => {
      const bounds = renderer.domElement.getBoundingClientRect();
      cursor.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        (-(event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      raycaster.setFromCamera(cursor, camera);
    };
    const pointerDown = (event: PointerEvent) => {
      if (activeSession || event.button !== 0) return;
      flatPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      if (mode === "explore") return;
      pointerRay(event);
      begin(undefined, event.pointerId);
      if (drag) renderer.domElement.setPointerCapture(event.pointerId);
    };
    const pointerMove = (event: PointerEvent) => {
      if (drag?.pointerId === event.pointerId) {
        pointerRay(event);
        updateDrag();
      }
    };
    const pointerUp = (event: PointerEvent) => {
      if (activeSession) return;
      if (drag?.pointerId === event.pointerId) {
        pointerRay(event);
        updateDrag();
        finish();
      } else if (
        mode === "explore" &&
        flatPointer?.id === event.pointerId &&
        Math.hypot(
          flatPointer.x - event.clientX,
          flatPointer.y - event.clientY,
        ) < 6
      ) {
        pointerRay(event);
        begin();
      }
      if (renderer.domElement.hasPointerCapture(event.pointerId))
        renderer.domElement.releasePointerCapture(event.pointerId);
      flatPointer = null;
    };
    const pointerCancel = () => {
      cancel();
      flatPointer = null;
    };
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointermove", pointerMove);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    renderer.domElement.addEventListener("pointercancel", pointerCancel);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drag) {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", escape);
    const endXR = () => {
      activeSession = null;
      fade = null;
      fadeMesh.visible = false;
      cancel();
      panel.visible = false;
      setXRActive(false);
      scene.background = new THREE.Color("#dce6d8");
      setMode("explore");
      overview();
      resize();
      setNotice("Returned to the 3D view. Your play is unchanged.");
    };
    const enterXR = async () => {
      if (activeSession || sessionPending || !navigator.xr) return;
      sessionPending = true;
      let requestedSession: XRSession | null = null;
      try {
        // requestSession stays in this click's activation; capability checks run separately.
        requestedSession = await navigator.xr.requestSession("immersive-vr", {
          optionalFeatures: ["local-floor"],
        });
        if (disposed) {
          await requestedSession.end();
          return;
        }
        activeSession = requestedSession;
        requestedSession.addEventListener("end", endXR, { once: true });
        await renderer.xr.setSession(requestedSession);
        if (disposed) {
          await requestedSession.end().catch(() => undefined);
          return;
        }
        cancel();
        setMode("explore");
        panel.visible = true;
        placeXR = true;
        setXRActive(true);
        setNotice("");
      } catch (error) {
        if (requestedSession) {
          requestedSession.removeEventListener("end", endXR);
          await requestedSession.end().catch(() => undefined);
        }
        if (disposed) return;
        endXR();
        const denied =
          error instanceof DOMException &&
          (error.name === "NotAllowedError" || error.name === "SecurityError");
        const message = denied
          ? "Immersive access was declined. You can keep exploring in 3D."
          : "This browser could not start an immersive session. You can keep exploring in 3D.";
        setNotice(message);
        latest.current.onError(message);
      } finally {
        sessionPending = false;
      }
    };
    let annotationsSignature = "";
    const sync = () => {
      const current = latest.current;
      needsRender = true;
      if (!current.isPlaying) pausePending = false;
      const ids = new Set(current.scene.actors.map((actor) => actor.id));
      actorMeshes.forEach((item, id) => {
        if (!ids.has(id)) {
          actorsGroup.remove(item.group);
          disposeTree(item.group);
          actorMeshes.delete(id);
        }
      });
      current.scene.actors.forEach((actor) => {
        const signature = [
          actor.role,
          actor.team,
          actor.name,
          actor.label,
          actor.number,
        ].join("|");
        let item = actorMeshes.get(actor.id);
        if (item && item.signature !== signature) {
          actorsGroup.remove(item.group);
          disposeTree(item.group);
          actorMeshes.delete(actor.id);
          item = undefined;
        }
        if (!item) {
          item = makeActor(actor);
          actorMeshes.set(actor.id, item);
          actorsGroup.add(item.group);
        }
      });
      const signature = JSON.stringify(current.annotations);
      if (signature !== annotationsSignature) {
        annotationsSignature = signature;
        for (const child of [...annotationsGroup.children]) {
          annotationsGroup.remove(child);
          disposeTree(child);
        }
        current.annotations.forEach((annotation) =>
          annotationsGroup.add(annotationMesh(annotation, length, width)),
        );
      }
      if (current.readOnly && mode !== "explore") setMode("explore");
      if (povId && (!ids.has(povId) || current.selectedId !== povId))
        switchView("overview");
    };
    sync();
    runtimeRef.current = {
      setInteraction: setMode,
      view: switchView,
      enterXR,
      cancel,
      sync,
      redraw: () => {
        needsRender = true;
      },
      playPause,
      undo,
    };
    const resize = () => {
      if (activeSession) return;
      const bounds = host.getBoundingClientRect();
      const renderWidth = Math.max(1, bounds.width),
        renderHeight = Math.max(1, bounds.height);
      renderer.setSize(renderWidth, renderHeight, false);
      camera.aspect = renderWidth / renderHeight;
      camera.updateProjectionMatrix();
      needsRender = true;
      if (view === "overview") fitOverviewCamera();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const contextLost = (event: Event) => {
      event.preventDefault();
      if (activeSession) void activeSession.end().catch(() => undefined);
      renderer.setAnimationLoop(null);
      const message =
        "The browser lost its 3D graphics connection. Switch to the tactical board, or reopen 3D.";
      setFailed(true);
      latest.current.onError(message);
    };
    renderer.domElement.addEventListener("webglcontextlost", contextLost);
    renderer.setAnimationLoop(() => {
      const current = latest.current;
      const cameraChanged = !activeSession && controls.update();
      if (
        !activeSession &&
        !current.isPlaying &&
        !drag &&
        !fade &&
        !needsRender &&
        !cameraChanged
      )
        return;
      needsRender = false;
      if (drag && current.isPlaying) pause();
      if (placeXR && renderer.xr.isPresenting) {
        placeXR = false;
        overview();
        panelInFront();
      }
      actorMeshes.forEach((item, id) => {
        const position = drag?.actorId === id ? drag.end : playerPosition(id);
        if (position)
          item.group.position.set(
            position.x - length / 2,
            0,
            position.y - width / 2,
          );
        item.group.visible = !(view === "player" && id === povId);
        item.label.visible = id === current.selectedId;
      });
      const selectedPosition =
        current.selectedId &&
        (drag?.actorId === current.selectedId
          ? drag.end
          : playerPosition(current.selectedId));
      selectedRing.visible = !!selectedPosition && view !== "player";
      if (selectedPosition)
        selectedRing.position.set(
          selectedPosition.x - length / 2,
          0.085,
          selectedPosition.y - width / 2,
        );
      if (drag?.controller) {
        controllerRay(drag.controller);
        updateDrag();
      }
      if (activeSession) {
        updatePanel();
        // Keep essential controls comfortably in reach during either tabletop or POV.
        panelInFront();
      }
      if (fade) {
        const elapsed = performance.now() - fade.started;
        fadeMesh.visible = true;
        fadeMaterial.opacity =
          elapsed < 100
            ? elapsed / 100
            : Math.max(0, 1 - (elapsed - 100) / 170);
        const activeCamera = activeSession ? renderer.xr.getCamera() : camera;
        fadeMesh.position.copy(
          activeCamera.getWorldPosition(new THREE.Vector3()),
        );
        if (elapsed >= 100 && !fade.ran) {
          fade.ran = true;
          fade.action();
        }
        if (elapsed > 270) {
          fade = null;
          fadeMesh.visible = false;
        }
      }
      renderer.render(scene, camera);
    });
    return () => {
      disposed = true;
      runtimeRef.current = null;
      observer.disconnect();
      renderer.setAnimationLoop(null);
      if (activeSession) {
        activeSession.removeEventListener("end", endXR);
        void activeSession.end().catch(() => undefined);
      }
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("keydown", escape);
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      controllerHandlers.forEach(({ controller, start, end, disconnect }) => {
        controller.removeEventListener("selectstart", start);
        controller.removeEventListener("selectend", end);
        controller.removeEventListener("disconnected", disconnect);
      });
      controllers.forEach((controller) => {
        scene.remove(controller);
        disposeTree(controller);
      });
      controls.dispose();
      disposeTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
      setXRActive(false);
    };
  }, [props.scene.id, props.scene.pitch.length, props.scene.pitch.width]);

  useEffect(() => {
    runtimeRef.current?.sync();
  }, [
    props.scene.actors,
    props.annotations,
    props.readOnly,
    props.selectedId,
    props.isPlaying,
  ]);
  useEffect(() => {
    runtimeRef.current?.redraw();
  }, [props.positions]);

  const changeMode = (mode: Interaction) =>
    runtimeRef.current?.setInteraction(mode);
  const buttonStyle = (active = false): React.CSSProperties => ({
    border: "1px solid rgba(33,63,45,.15)",
    background: active ? "#193d2a" : "#f7f8ef",
    color: active ? "#fffdf0" : "#264533",
    borderRadius: 9,
    padding: "9px 12px",
    font: "inherit",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    minHeight: 38,
  });
  const selectedActor = props.scene.actors.find(
    (actor) => actor.id === props.selectedId,
  );
  return (
    <div
      className="scene-3d"
      style={{
        position: "relative",
        height: "100%",
        minHeight: 360,
        overflow: "hidden",
        background: "#dce6d8",
        containerType: "inline-size",
      }}
    >
      <style>{`@container (max-width: 520px) { .scene-3d-toolbar { width: calc(100% - 24px) !important; } .scene-3d-tools { display: grid !important; grid-template-columns: repeat(3, minmax(0, 1fr)); } }`}</style>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      {failed && (
        <div
          role="status"
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            padding: 40,
            textAlign: "center",
          }}
        >
          <p>
            3D graphics are unavailable here. Your tactical board and
            annotations remain available.
          </p>
        </div>
      )}
      {!xrActive && !failed && (
        <>
          <div
            style={{
              position: "absolute",
              top: 16,
              left: 16,
              right: 16,
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "space-between",
              gap: 10,
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 6,
                pointerEvents: "auto",
                padding: 5,
                borderRadius: 13,
                background: "rgba(249,250,239,.88)",
                backdropFilter: "blur(8px)",
              }}
            >
              <button
                type="button"
                onClick={() => runtimeRef.current?.view("overview")}
                style={buttonStyle(cameraView === "overview")}
              >
                Overview
              </button>
              <button
                type="button"
                disabled={!props.selectedId}
                onClick={() => runtimeRef.current?.view("player")}
                style={{
                  ...buttonStyle(cameraView === "player"),
                  opacity: props.selectedId ? 1 : 0.5,
                }}
              >
                Player view
              </button>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                pointerEvents: "auto",
              }}
            >
              {support.vr && (
                <button
                  type="button"
                  onClick={() => void runtimeRef.current?.enterXR()}
                  style={buttonStyle(true)}
                >
                  Enter VR ↗
                </button>
              )}
            </div>
          </div>
          <div
            className="scene-3d-toolbar"
            style={{
              position: "absolute",
              left: "50%",
              bottom: 18,
              transform: "translateX(-50%)",
              width: "max-content",
              maxWidth: "calc(100% - 24px)",
              boxSizing: "border-box",
              padding: "7px 10px",
              borderRadius: 14,
              background: "rgba(249,250,239,.94)",
              backdropFilter: "blur(8px)",
              boxShadow: "0 3px 15px rgba(25,55,37,.08)",
            }}
          >
            <div
              className="scene-3d-tools"
              role="toolbar"
              aria-label="3D interaction tools"
              style={{
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "center",
                gap: 5,
              }}
            >
              <button
                type="button"
                aria-pressed={interaction === "explore"}
                onClick={() => changeMode("explore")}
                style={buttonStyle(interaction === "explore")}
              >
                Explore
              </button>
              {!props.readOnly && (
                <>
                  <button
                    type="button"
                    aria-pressed={interaction === "move"}
                    onClick={() => changeMode("move")}
                    style={buttonStyle(interaction === "move")}
                  >
                    Move
                  </button>
                  <button
                    type="button"
                    aria-pressed={interaction === "arrow"}
                    onClick={() => changeMode("arrow")}
                    style={buttonStyle(interaction === "arrow")}
                  >
                    Arrow
                  </button>
                  <button
                    type="button"
                    aria-pressed={interaction === "zone"}
                    onClick={() => changeMode("zone")}
                    style={buttonStyle(interaction === "zone")}
                  >
                    Zone
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => runtimeRef.current?.playPause()}
                style={buttonStyle()}
              >
                {props.isPlaying ? "Pause" : "Play"}
              </button>
              {!props.readOnly && (
                <button
                  type="button"
                  onClick={() => runtimeRef.current?.undo()}
                  style={buttonStyle()}
                >
                  Undo
                </button>
              )}
              {interaction !== "explore" && (
                <button
                  type="button"
                  onClick={() => runtimeRef.current?.cancel()}
                  style={buttonStyle()}
                >
                  Cancel
                </button>
              )}
            </div>
            <p
              style={{
                margin: "6px 3px 1px",
                fontSize: 11,
                textAlign: "center",
                color: "#60725e",
              }}
            >
              {interaction === "explore"
                ? "Drag to orbit · Pinch to zoom · Tap a player"
                : interaction === "move"
                  ? "Drag a player or the ball · Release to save"
                  : `Drag on the pitch to add ${interaction === "arrow" ? "an arrow" : "a zone"}`}
            </p>
          </div>
          {selectedActor && (
            <div
              style={{
                position: "absolute",
                top: 79,
                left: 21,
                padding: "8px 11px",
                borderRadius: 9,
                background: "#f9faef",
                color: "#284933",
                fontSize: 12,
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: TEAM_COLORS[selectedActor.team],
                  marginRight: 7,
                }}
              />
              {selectedActor.name ||
                selectedActor.number ||
                (selectedActor.role === "ball" ? "Ball" : "Selected player")}
            </div>
          )}
        </>
      )}
      {notice && !xrActive && (
        <p
          role="status"
          style={{
            position: "absolute",
            left: 16,
            right: 16,
            top: 113,
            margin: 0,
            fontSize: 12,
            color: "#355741",
            background: "rgba(248,250,237,.93)",
            padding: "9px 12px",
            borderRadius: 8,
          }}
        >
          {notice}
        </p>
      )}
      {!xrActive && !support.checking && !support.vr && !failed && (
        <span
          style={{
            position: "absolute",
            right: 17,
            top: 73,
            fontSize: 10,
            color: "#63765c",
          }}
        >
          Open this play in a compatible headset for VR
        </span>
      )}
    </div>
  );
}

export default Scene3D;
