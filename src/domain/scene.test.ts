import { describe, expect, it } from "vitest";
import {
  addActor,
  addAnnotation,
  cloneSceneForPublication,
  createScene,
  createSampleScene,
  duplicateFrame,
  interpolateTimeline,
  removeActor,
  snapshotPositions,
  totalDuration,
  updateActorPosition,
  updateFrameAnnotations,
} from "./scene";

function movingScene() {
  let scene = addActor(createScene(), {
    id: "p1",
    role: "player",
    team: "a",
    position: { x: 10, y: 20 },
    provenance: "manual",
  });
  scene = duplicateFrame(scene, 0);
  scene = updateActorPosition(scene, 1, "p1", { x: 30, y: 40 });
  return {
    ...scene,
    keyframes: scene.keyframes.map((frame, index) => ({
      ...frame,
      holdMs: index === 0 ? 500 : 250,
      durationMs: index === 0 ? 1000 : 500,
    })),
  };
}

describe("scene editing", () => {
  it("creates an empty editable scene with a single two-second keyframe", () => {
    const scene = createScene();
    expect(scene.actors).toEqual([]);
    expect(scene.keyframes).toHaveLength(1);
    expect(totalDuration(scene)).toBe(2000);
    expect(scene.keyframes[0].holdMs).toBe(0);
  });
  it("adds and removes actor positions across every keyframe without changing the original", () => {
    const original = duplicateFrame(createScene(), 0);
    const added = addActor(original, {
      id: "p1",
      role: "player",
      team: "a",
      position: { x: 110, y: -4 },
      provenance: "manual",
    });
    expect(original.actors).toHaveLength(0);
    expect(original.keyframes[0].positions).toEqual({});
    expect(added.keyframes.map((frame) => frame.positions.p1)).toEqual([
      { x: 105, y: 0 },
      { x: 105, y: 0 },
    ]);
    const removed = removeActor(added, "p1");
    expect(removed.keyframes.every((frame) => !("p1" in frame.positions))).toBe(
      true,
    );
    expect(added.actors).toHaveLength(1);
  });
  it("edits only the chosen keyframe and preserves publication snapshots", () => {
    const scene = movingScene(),
      published = cloneSceneForPublication(scene);
    const edited = updateActorPosition(scene, 1, "p1", { x: 70, y: 60 });
    expect(snapshotPositions(edited, 0).p1).toEqual({ x: 10, y: 20 });
    expect(snapshotPositions(edited, 1).p1).toEqual({ x: 70, y: 60 });
    expect(published.keyframes[1].positions.p1).toEqual({ x: 30, y: 40 });
    expect(edited.revision).toBe(scene.revision + 1);
    published.keyframes[0].positions.p1.x = 3;
    expect(scene.keyframes[0].positions.p1.x).toBe(10);
  });
  it("duplicates frames and annotation geometry without aliasing the source", () => {
    const annotation = {
      id: "a1",
      kind: "arrow" as const,
      start: { x: 10, y: 20 },
      end: { x: 30, y: 40 },
      color: "#fff",
    };
    const scene = addAnnotation(createScene(), 0, annotation),
      duplicated = duplicateFrame(scene, 0);
    duplicated.keyframes[1].annotations[0].start.x = 50;
    expect(scene.keyframes[0].annotations[0].start.x).toBe(10);
    expect(duplicated.keyframes[1].id).not.toBe(scene.keyframes[0].id);
    const updated = updateFrameAnnotations(scene, 0, []);
    expect(updated.keyframes[0].annotations).toEqual([]);
    expect(scene.keyframes[0].annotations).toHaveLength(1);
  });
  it("rejects nonfinite coordinates and missing frame/actor identifiers", () => {
    const scene = movingScene();
    expect(() =>
      updateActorPosition(scene, 0, "p1", { x: NaN, y: 0 }),
    ).toThrow();
    expect(() => updateActorPosition(scene, 7, "p1", { x: 0, y: 0 })).toThrow();
    expect(() =>
      updateActorPosition(scene, 0, "missing", { x: 0, y: 0 }),
    ).toThrow();
  });
  it("marks baseline corrections manual while retaining source provenance on later authored frames", () => {
    const base = addActor(createScene(), {
      id: "detected",
      role: "player",
      team: "a",
      position: { x: 10, y: 20 },
      imagePoint: { x: 0.2, y: 0.3 },
      provenance: "automatic",
      needsReview: true,
    });
    const scene = duplicateFrame(base, 0),
      later = updateActorPosition(scene, 1, "detected", { x: 40, y: 30 });
    expect(later.actors[0]).toMatchObject({
      provenance: "automatic",
      position: { x: 10, y: 20 },
      imagePoint: { x: 0.2, y: 0.3 },
      needsReview: true,
    });
    const baseline = updateActorPosition(later, 0, "detected", {
      x: 15,
      y: 25,
    });
    expect(baseline.actors[0]).toMatchObject({
      provenance: "manual",
      position: { x: 15, y: 25 },
      imagePoint: { x: 0.2, y: 0.3 },
      needsReview: false,
    });
    expect(baseline.keyframes[1].positions.detected).toEqual({ x: 40, y: 30 });
  });
});

describe("authored timeline", () => {
  it("holds, interpolates linearly and clamps before/after the timeline", () => {
    const scene = movingScene();
    expect(totalDuration(scene)).toBe(2250);
    expect(interpolateTimeline(scene, -100).positions.p1).toEqual({
      x: 10,
      y: 20,
    });
    expect(interpolateTimeline(scene, 499).positions.p1).toEqual({
      x: 10,
      y: 20,
    });
    expect(interpolateTimeline(scene, 1000).positions.p1).toEqual({
      x: 20,
      y: 30,
    });
    expect(interpolateTimeline(scene, 1500).positions.p1).toEqual({
      x: 30,
      y: 40,
    });
    expect(interpolateTimeline(scene, 5000).positions.p1).toEqual({
      x: 30,
      y: 40,
    });
  });
  it("switches annotations at the keyframe boundary and returns detached geometry", () => {
    const scene = movingScene();
    scene.keyframes[0].annotations = [
      {
        id: "one",
        kind: "line",
        start: { x: 1, y: 1 },
        end: { x: 2, y: 2 },
        color: "#fff",
      },
    ];
    expect(interpolateTimeline(scene, 1499).annotations).toHaveLength(1);
    expect(interpolateTimeline(scene, 1500).annotations).toHaveLength(0);
    const result = interpolateTimeline(scene, 0);
    result.annotations[0].start.x = 99;
    expect(scene.keyframes[0].annotations[0].start.x).toBe(1);
  });
  it("handles zero-duration frames without dividing by zero", () => {
    const scene = movingScene();
    scene.keyframes[0].holdMs = 0;
    scene.keyframes[0].durationMs = 0;
    expect(interpolateTimeline(scene, 0).positions.p1).toEqual({
      x: 30,
      y: 40,
    });
  });
  it("labels its fixture as synthetic and supplies known positions, teams, ball and alignment", () => {
    const scene = createSampleScene();
    expect(scene.actors).toHaveLength(16);
    expect(scene.actors.every((actor) => actor.provenance === "sample")).toBe(
      true,
    );
    expect(scene.actors.some((actor) => actor.role === "ball")).toBe(true);
    expect(decodeURIComponent(scene.source!.url)).toContain("SYNTHETIC SAMPLE");
    expect(scene.calibration.matrix).toHaveLength(9);
  });
});
