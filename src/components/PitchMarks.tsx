import type { Vec2 } from "../domain/types";

/** Pitch geometry in metres. Use sampled lines when projecting through a camera homography. */
export const pitchPaths = [
  "M0 0H105V68H0Z",
  "M52.5 0V68",
  "M0 13.84H16.5V54.16H0",
  "M105 13.84H88.5V54.16H105",
  "M0 24.84H5.5V43.16H0",
  "M105 24.84H99.5V43.16H105",
  "M16.5 26.69A9.15 9.15 0 0 1 16.5 41.31",
  "M88.5 26.69A9.15 9.15 0 0 0 88.5 41.31",
  "M0 1A1 1 0 0 0 1 0",
  "M104 0A1 1 0 0 0 105 1",
  "M105 67A1 1 0 0 0 104 68",
  "M1 68A1 1 0 0 0 0 67",
];

function arc(
  cx: number,
  cy: number,
  radius: number,
  start: number,
  end: number,
  samples = 48,
): Vec2[] {
  return Array.from({ length: samples + 1 }, (_, index) => ({
    x: cx + radius * Math.cos(start + ((end - start) * index) / samples),
    y: cy + radius * Math.sin(start + ((end - start) * index) / samples),
  }));
}

export const pitchLineSegments: Vec2[][] = [
  [
    { x: 0, y: 0 },
    { x: 105, y: 0 },
    { x: 105, y: 68 },
    { x: 0, y: 68 },
    { x: 0, y: 0 },
  ],
  [
    { x: 52.5, y: 0 },
    { x: 52.5, y: 68 },
  ],
  [
    { x: 0, y: 13.84 },
    { x: 16.5, y: 13.84 },
    { x: 16.5, y: 54.16 },
    { x: 0, y: 54.16 },
  ],
  [
    { x: 105, y: 13.84 },
    { x: 88.5, y: 13.84 },
    { x: 88.5, y: 54.16 },
    { x: 105, y: 54.16 },
  ],
  [
    { x: 0, y: 24.84 },
    { x: 5.5, y: 24.84 },
    { x: 5.5, y: 43.16 },
    { x: 0, y: 43.16 },
  ],
  [
    { x: 105, y: 24.84 },
    { x: 99.5, y: 24.84 },
    { x: 99.5, y: 43.16 },
    { x: 105, y: 43.16 },
  ],
  arc(52.5, 34, 9.15, 0, Math.PI * 2),
  arc(11, 34, 9.15, -Math.acos(5.5 / 9.15), Math.acos(5.5 / 9.15)),
  arc(
    94,
    34,
    9.15,
    Math.PI - Math.acos(5.5 / 9.15),
    Math.PI + Math.acos(5.5 / 9.15),
  ),
  arc(0, 0, 1, 0, Math.PI / 2, 8),
  arc(105, 0, 1, Math.PI / 2, Math.PI, 8),
  arc(105, 68, 1, Math.PI, Math.PI * 1.5, 8),
  arc(0, 68, 1, -Math.PI / 2, 0, 8),
];

export function getPitchLineSegments(length = 105, width = 68): Vec2[][] {
  const center = width / 2,
    arcAngle = Math.acos(5.5 / 9.15);
  return [
    [
      { x: 0, y: 0 },
      { x: length, y: 0 },
      { x: length, y: width },
      { x: 0, y: width },
      { x: 0, y: 0 },
    ],
    [
      { x: length / 2, y: 0 },
      { x: length / 2, y: width },
    ],
    [
      { x: 0, y: center - 20.16 },
      { x: 16.5, y: center - 20.16 },
      { x: 16.5, y: center + 20.16 },
      { x: 0, y: center + 20.16 },
    ],
    [
      { x: length, y: center - 20.16 },
      { x: length - 16.5, y: center - 20.16 },
      { x: length - 16.5, y: center + 20.16 },
      { x: length, y: center + 20.16 },
    ],
    [
      { x: 0, y: center - 9.16 },
      { x: 5.5, y: center - 9.16 },
      { x: 5.5, y: center + 9.16 },
      { x: 0, y: center + 9.16 },
    ],
    [
      { x: length, y: center - 9.16 },
      { x: length - 5.5, y: center - 9.16 },
      { x: length - 5.5, y: center + 9.16 },
      { x: length, y: center + 9.16 },
    ],
    arc(length / 2, center, 9.15, 0, Math.PI * 2),
    arc(11, center, 9.15, -arcAngle, arcAngle),
    arc(length - 11, center, 9.15, Math.PI - arcAngle, Math.PI + arcAngle),
    arc(0, 0, 1, 0, Math.PI / 2, 8),
    arc(length, 0, 1, Math.PI / 2, Math.PI, 8),
    arc(length, width, 1, Math.PI, Math.PI * 1.5, 8),
    arc(0, width, 1, -Math.PI / 2, 0, 8),
  ];
}

export function PitchMarks({
  length = 105,
  width = 68,
}: { length?: number; width?: number } = {}) {
  return (
    <g
      fill="none"
      stroke="#cfdfcf"
      strokeWidth="0.32"
      opacity="0.82"
      pointerEvents="none"
    >
      {getPitchLineSegments(length, width).map((points, index) => (
        <polyline
          key={index}
          points={points.map((point) => `${point.x},${point.y}`).join(" ")}
        />
      ))}
      <g fill="#cfdfcf" stroke="none">
        <circle cx={length / 2} cy={width / 2} r=".35" />
        <circle cx="11" cy={width / 2} r=".35" />
        <circle cx={length - 11} cy={width / 2} r=".35" />
      </g>
      <path
        d={`M-1.3 ${width / 2 - 3.66}H0M-1.3 ${width / 2 - 3.66}V${width / 2 + 3.66}H0M${length} ${width / 2 - 3.66}H${length + 1.3}V${width / 2 + 3.66}H${length}`}
        strokeWidth=".6"
      />
    </g>
  );
}
