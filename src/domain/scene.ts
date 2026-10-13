import type { Actor, Annotation, Keyframe, Scene, Vec2 } from "./types";

export function newId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `id-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function createScene(
  options: { title?: string; source?: Scene["source"] } = {},
): Scene {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: newId(),
    title: options.title ?? "Untitled play",
    revision: 0,
    pitch: { length: 105, width: 68 },
    ...(options.source ? { source: structuredClone(options.source) } : {}),
    calibration: { status: "unavailable" },
    actors: [],
    keyframes: [
      {
        id: newId(),
        durationMs: 2000,
        holdMs: 0,
        positions: {},
        annotations: [],
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

function edited(scene: Scene, changes: Partial<Scene>): Scene {
  return {
    ...scene,
    ...changes,
    revision: scene.revision + 1,
    updatedAt: new Date().toISOString(),
  };
}

function checkedFrame(scene: Scene, index: number): Keyframe {
  const frame = scene.keyframes[index];
  if (!frame) throw new Error("Choose an existing keyframe.");
  return frame;
}

export function clampPosition(
  position: Vec2,
  pitch = { length: 105, width: 68 },
): Vec2 {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y))
    throw new Error("Player positions must be finite.");
  return {
    x: Math.max(0, Math.min(pitch.length, position.x)),
    y: Math.max(0, Math.min(pitch.width, position.y)),
  };
}

export function snapshotPositions(
  scene: Scene,
  frameIndex = 0,
): Record<string, Vec2> {
  const frame = checkedFrame(scene, frameIndex);
  return Object.fromEntries(
    scene.actors.map((actor) => [
      actor.id,
      { ...(frame.positions[actor.id] ?? actor.position) },
    ]),
  );
}

function duration(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
export function totalDuration(scene: Scene): number {
  return scene.keyframes.reduce(
    (total, frame) =>
      total + duration(frame.holdMs) + duration(frame.durationMs),
    0,
  );
}

export function interpolateTimeline(
  scene: Scene,
  timeMs: number,
): { positions: Record<string, Vec2>; annotations: Annotation[] } {
  if (scene.keyframes.length === 0)
    return {
      positions: Object.fromEntries(
        scene.actors.map((actor) => [actor.id, { ...actor.position }]),
      ),
      annotations: [],
    };
  const time = Number.isFinite(timeMs)
    ? Math.max(0, Math.min(totalDuration(scene), timeMs))
    : 0;
  let elapsed = 0;
  for (let index = 0; index < scene.keyframes.length; index++) {
    const frame = scene.keyframes[index],
      hold = duration(frame.holdMs),
      transition = duration(frame.durationMs);
    const end = elapsed + hold + transition;
    if (time < end || index === scene.keyframes.length - 1) {
      const from = snapshotPositions(scene, index),
        to = snapshotPositions(
          scene,
          Math.min(index + 1, scene.keyframes.length - 1),
        );
      const amount =
        transition > 0
          ? Math.max(0, Math.min(1, (time - elapsed - hold) / transition))
          : 0;
      const positions = Object.fromEntries(
        scene.actors.map((actor) => [
          actor.id,
          {
            x: from[actor.id].x + (to[actor.id].x - from[actor.id].x) * amount,
            y: from[actor.id].y + (to[actor.id].y - from[actor.id].y) * amount,
          },
        ]),
      );
      return { positions, annotations: structuredClone(frame.annotations) };
    }
    elapsed = end;
  }
  return {
    positions: snapshotPositions(scene, scene.keyframes.length - 1),
    annotations: structuredClone(scene.keyframes.at(-1)!.annotations),
  };
}

export function duplicateFrame(scene: Scene, index: number): Scene {
  const frame = checkedFrame(scene, index);
  const duplicate = { ...structuredClone(frame), id: newId() };
  return edited(scene, {
    keyframes: [
      ...scene.keyframes.slice(0, index + 1),
      duplicate,
      ...scene.keyframes.slice(index + 1),
    ],
  });
}

export function updateActorPosition(
  scene: Scene,
  frameIndex: number,
  id: string,
  position: Vec2,
): Scene {
  checkedFrame(scene, frameIndex);
  if (!scene.actors.some((actor) => actor.id === id))
    throw new Error("Choose an existing player or ball.");
  const next = clampPosition(position, scene.pitch);
  return edited(scene, {
    actors:
      frameIndex === 0
        ? scene.actors.map((actor) =>
            actor.id === id
              ? {
                  ...actor,
                  position: { ...next },
                  provenance: "manual" as const,
                  needsReview: false,
                }
              : actor,
          )
        : scene.actors,
    keyframes: scene.keyframes.map((frame, index) =>
      index === frameIndex
        ? { ...frame, positions: { ...frame.positions, [id]: next } }
        : frame,
    ),
  });
}

export function addActor(scene: Scene, actor: Actor): Scene {
  if (scene.actors.some((existing) => existing.id === actor.id))
    throw new Error("This player already exists.");
  const next = {
    ...structuredClone(actor),
    position: clampPosition(actor.position, scene.pitch),
  };
  return edited(scene, {
    actors: [...scene.actors, next],
    keyframes: scene.keyframes.map((frame) => ({
      ...frame,
      positions: { ...frame.positions, [actor.id]: { ...next.position } },
    })),
  });
}

export function removeActor(scene: Scene, id: string): Scene {
  if (!scene.actors.some((actor) => actor.id === id)) return scene;
  return edited(scene, {
    actors: scene.actors.filter((actor) => actor.id !== id),
    keyframes: scene.keyframes.map((frame) => {
      const positions = { ...frame.positions };
      delete positions[id];
      return { ...frame, positions };
    }),
  });
}

export function updateFrameAnnotations(
  scene: Scene,
  frameIndex: number,
  annotations: Annotation[],
): Scene {
  checkedFrame(scene, frameIndex);
  return edited(scene, {
    keyframes: scene.keyframes.map((frame, index) =>
      index === frameIndex
        ? { ...frame, annotations: structuredClone(annotations) }
        : frame,
    ),
  });
}
export function addAnnotation(
  scene: Scene,
  frameIndex: number,
  annotation: Annotation,
): Scene {
  const frame = checkedFrame(scene, frameIndex);
  return updateFrameAnnotations(scene, frameIndex, [
    ...frame.annotations,
    annotation,
  ]);
}
export function updateAnnotation(
  scene: Scene,
  frameIndex: number,
  annotation: Annotation,
): Scene {
  const frame = checkedFrame(scene, frameIndex);
  return updateFrameAnnotations(
    scene,
    frameIndex,
    frame.annotations.map((existing) =>
      existing.id === annotation.id ? annotation : existing,
    ),
  );
}
export function removeAnnotation(
  scene: Scene,
  frameIndex: number,
  id: string,
): Scene {
  return updateFrameAnnotations(
    scene,
    frameIndex,
    checkedFrame(scene, frameIndex).annotations.filter(
      (annotation) => annotation.id !== id,
    ),
  );
}
/** Publication callers receive a detached snapshot; subsequent draft edits cannot change it. */
export function cloneSceneForPublication(scene: Scene): Scene {
  return structuredClone(scene);
}

export { createSampleScene } from "./sample";
