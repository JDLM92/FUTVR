import { describe, expect, it } from "vitest";
import {
  invertHomography,
  pitchToImage,
  projectPoint,
  solveHomography,
} from "./calibration";
import { createSampleScene } from "./sample";

describe("pitch calibration", () => {
  const imageToPitch = [105, 0, 0, 0, 68, 0, 0, 0, 1];
  const corners = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  it("solves exact four-point geometry and round-trips through the inverse", () => {
    const matrix = solveHomography(
      corners.map((image) => ({
        image,
        pitch: projectPoint(imageToPitch, image),
      })),
    );
    expect(projectPoint(matrix, { x: 0.4, y: 0.7 }).x).toBeCloseTo(42, 8);
    expect(projectPoint(matrix, { x: 0.4, y: 0.7 }).y).toBeCloseTo(47.6, 8);
    const image = pitchToImage(matrix, { x: 42, y: 47.6 });
    expect(image.x).toBeCloseTo(0.4, 8);
    expect(image.y).toBeCloseTo(0.7, 8);
  });
  it("preserves projection when the matrix is rescaled", () => {
    const point = { x: 0.4, y: 0.7 },
      result = projectPoint(
        imageToPitch.map((value) => value * 1e-12),
        point,
      ),
      expected = projectPoint(imageToPitch, point);
    expect(result.x).toBeCloseTo(expected.x, 10);
    expect(result.y).toBeCloseTo(expected.y, 10);
  });
  it("recovers broadcast perspective fixture and accepts additional correspondences", () => {
    const scene = createSampleScene(),
      known = scene.calibration.matrix!;
    const landmarks = [
      ...scene.calibration.landmarks!,
      ...scene.actors
        .slice(0, 6)
        .map((actor) => ({ image: actor.imagePoint!, pitch: actor.position })),
    ];
    const solved = solveHomography(landmarks);
    for (const actor of scene.actors) {
      const position = projectPoint(solved, actor.imagePoint!);
      expect(position.x).toBeCloseTo(actor.position.x, 6);
      expect(position.y).toBeCloseTo(actor.position.y, 6);
    }
    const sample = { x: 0.5, y: 0.5 };
    expect(projectPoint(solved, sample).x).toBeCloseTo(
      projectPoint(known, sample).x,
      6,
    );
  });
  it("rejects duplicate, collinear, near-collinear and insufficient landmarks", () => {
    const landmarks = corners.map((image) => ({
      image,
      pitch: projectPoint(imageToPitch, image),
    }));
    expect(() => solveHomography(landmarks.slice(0, 3))).toThrow(/four/);
    expect(() =>
      solveHomography([landmarks[0], landmarks[0], landmarks[2], landmarks[3]]),
    ).toThrow(/distinct/);
    const line = [0, 0.25, 0.5, 0.75].map((x) => ({
      image: { x, y: 0.5 },
      pitch: { x: x * 105, y: 34 },
    }));
    expect(() => solveHomography(line)).toThrow(/line/);
    const nearLine = line.map((mark, index) => ({
      ...mark,
      image: { ...mark.image, y: 0.5 + (index % 2) * 1e-6 },
    }));
    expect(() => solveHomography(nearLine)).toThrow();
  });
  it("rejects singular matrices, horizon points, out-of-image and nonfinite coordinates", () => {
    expect(() => invertHomography([1, 0, 0, 0, 0, 0, 0, 0, 1])).toThrow(
      /degenerate/,
    );
    expect(() =>
      projectPoint([1, 0, 0, 0, 1, 0, 1, 0, -0.5], { x: 0.5, y: 0.2 }),
    ).toThrow(/horizon/);
    expect(() =>
      solveHomography(
        corners.map((image, index) => ({
          image: index === 0 ? { x: -0.1, y: 0 } : image,
          pitch: projectPoint(imageToPitch, image),
        })),
      ),
    ).toThrow(/inside/);
    expect(() => projectPoint(imageToPitch, { x: Infinity, y: 0 })).toThrow();
  });
});
