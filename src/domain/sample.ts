import type { Actor, Scene, Vec2 } from "./types";
import { invertHomography, projectPoint } from "./calibration";
import { createScene } from "./scene";

// This is generated fixture geometry, not the output of an AI detector.
const PITCH_TO_IMAGE = [
  0.0072, -0.0007, 0.1, -0.0011, 0.0084, 0.22, 0.0009, -0.0025, 1,
];
export const SAMPLE_HOMOGRAPHY = invertHomography(PITCH_TO_IMAGE);

const fixture: {
  id: string;
  team: Actor["team"];
  position: Vec2;
  number?: string;
  name?: string;
  role?: Actor["role"];
}[] = [
  { id: "sample-a1", team: "a", position: { x: 20, y: 18 }, number: "4" },
  { id: "sample-a2", team: "a", position: { x: 31, y: 45 }, number: "8" },
  {
    id: "sample-a3",
    team: "a",
    position: { x: 43, y: 30 },
    number: "6",
    name: "A. Rivera",
  },
  { id: "sample-a4", team: "a", position: { x: 60, y: 12 }, number: "7" },
  {
    id: "sample-a5",
    team: "a",
    position: { x: 66, y: 43 },
    number: "10",
    name: "J. Silva",
  },
  { id: "sample-a6", team: "a", position: { x: 80, y: 27 }, number: "9" },
  { id: "sample-a7", team: "a", position: { x: 82, y: 57 }, number: "11" },
  { id: "sample-b1", team: "b", position: { x: 46, y: 16 }, number: "2" },
  { id: "sample-b2", team: "b", position: { x: 52, y: 41 }, number: "5" },
  { id: "sample-b3", team: "b", position: { x: 63, y: 29 }, number: "8" },
  { id: "sample-b4", team: "b", position: { x: 75, y: 14 }, number: "3" },
  { id: "sample-b5", team: "b", position: { x: 86, y: 37 }, number: "4" },
  { id: "sample-b6", team: "b", position: { x: 93, y: 53 }, number: "6" },
  { id: "sample-b7", team: "b", position: { x: 101, y: 34 }, number: "1" },
  {
    id: "sample-referee",
    team: "official",
    role: "official",
    position: { x: 38, y: 26 },
  },
  {
    id: "sample-ball",
    team: "unknown",
    role: "ball",
    position: { x: 45, y: 31 },
  },
];

function point(position: Vec2) {
  const image = projectPoint(PITCH_TO_IMAGE, position);
  return `${(image.x * 1200).toFixed(2)},${(image.y * 760).toFixed(2)}`;
}
function path(points: Vec2[], close = false) {
  return `<path d="M${points.map(point).join(" L")}${close ? " Z" : ""}" fill="none" stroke="#ecf4dd" stroke-width="2.5" opacity=".8"/>`;
}
function rectangle(x: number, y: number, width: number, height: number) {
  return path(
    [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
    true,
  );
}
function sampleSource(actors: Actor[]) {
  const stripes = Array.from({ length: 10 }, (_, index) => {
    const x = index * 10.5;
    return `<polygon points="${[
      { x, y: 0 },
      { x: x + 10.5, y: 0 },
      { x: x + 10.5, y: 68 },
      { x, y: 68 },
    ]
      .map(point)
      .join(" ")}" fill="${index % 2 ? "#52783d" : "#5b8242"}"/>`;
  }).join("");
  const circle = Array.from({ length: 65 }, (_, index) => ({
    x: 52.5 + 9.15 * Math.cos((index / 64) * Math.PI * 2),
    y: 34 + 9.15 * Math.sin((index / 64) * Math.PI * 2),
  }));
  const figures = actors
    .slice()
    .sort((a, b) => a.imagePoint!.y - b.imagePoint!.y)
    .map((actor) => {
      const x = actor.imagePoint!.x * 1200,
        y = actor.imagePoint!.y * 760;
      const size = 0.65 + actor.imagePoint!.y * 0.65;
      if (actor.role === "ball")
        return `<circle cx="${x}" cy="${y - 4}" r="5" fill="white" stroke="#101a15"/>`;
      const color =
        actor.team === "a"
          ? "#ff653b"
          : actor.team === "official"
            ? "#ffe05d"
            : "#a9c8ec";
      return `<g transform="translate(${x},${y}) scale(${size})"><ellipse cy="1" rx="10" ry="3" fill="#162d1b" opacity=".45"/><path d="M-5 -17 L-4 0 M5 -17 L5 0" stroke="#edf3eb" stroke-width="5"/><path d="M-6 -33 L-8 -17 L8 -17 L6 -33 Z" fill="${color}" stroke="#26352c" stroke-width="1"/><path d="M-7 -31 L-11 -20 M7 -31 L11 -20" stroke="#cba187" stroke-width="3"/><circle cy="-39" r="5" fill="#cba187"/><text y="-22" text-anchor="middle" fill="#173b44" font-family="Arial,sans-serif" font-size="9" font-weight="bold">${actor.number ?? ""}</text></g>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760"><rect width="1200" height="760" fill="#15251e"/><rect y="48" width="1200" height="65" fill="#24382f"/><path d="M0 111 L1200 49" stroke="#82927e" stroke-width="4"/><text x="32" y="35" fill="#dfe6dc" font-family="Arial,sans-serif" font-size="16" letter-spacing="3">FUTVR · SYNTHETIC SAMPLE · KNOWN POSITIONS</text>${stripes}${rectangle(0, 0, 105, 68)}${path(
    [
      { x: 52.5, y: 0 },
      { x: 52.5, y: 68 },
    ],
  )}${path(circle)}${rectangle(0, 13.84, 16.5, 40.32)}${rectangle(88.5, 13.84, 16.5, 40.32)}${rectangle(0, 24.84, 5.5, 18.32)}${rectangle(99.5, 24.84, 5.5, 18.32)}${figures}<rect x="24" y="694" width="262" height="42" rx="8" fill="#112119" opacity=".9"/><text x="42" y="720" font-family="Arial,sans-serif" font-size="14" fill="#e6ebdf">Generated fixture — not a match photo</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function createSampleScene(): Scene {
  const scene = createScene({ title: "The passing lane" });
  const actors: Actor[] = fixture.map((actor) => ({
    ...actor,
    role: actor.role ?? "player",
    provenance: "sample",
    imagePoint: projectPoint(PITCH_TO_IMAGE, actor.position),
  }));
  return {
    ...scene,
    source: {
      type: "image",
      url: sampleSource(actors),
      width: 1200,
      height: 760,
      crop: { x: 0, y: 0, width: 1, height: 1 },
    },
    actors,
    calibration: {
      status: "confirmed",
      matrix: [...SAMPLE_HOMOGRAPHY],
      landmarks: [
        { x: 0, y: 0 },
        { x: 105, y: 0 },
        { x: 105, y: 68 },
        { x: 0, y: 68 },
      ].map((pitch) => ({ pitch, image: projectPoint(PITCH_TO_IMAGE, pitch) })),
    },
    keyframes: [
      {
        ...scene.keyframes[0],
        positions: Object.fromEntries(
          actors.map((actor) => [actor.id, { ...actor.position }]),
        ),
        annotations: [],
      },
    ],
  };
}
