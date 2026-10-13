import type { Vec2 } from "./types";

export type Landmark = { image: Vec2; pitch: Vec2 };

function checkMatrix(matrix: number[]) {
  if (matrix.length !== 9 || matrix.some((value) => !Number.isFinite(value))) {
    throw new Error("Pitch alignment must contain nine finite values.");
  }
}

export function projectPoint(matrix: number[], point: Vec2): Vec2 {
  checkMatrix(matrix);
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
    throw new Error("Choose a finite point.");
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  const denominatorScale =
    Math.abs(matrix[6] * point.x) +
    Math.abs(matrix[7] * point.y) +
    Math.abs(matrix[8]);
  if (
    denominatorScale === 0 ||
    Math.abs(denominator) <= 1e-10 * denominatorScale
  )
    throw new Error("This point is too close to the camera horizon.");
  const x =
    (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator;
  const y =
    (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator;
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new Error("This point cannot be placed on the pitch.");
  return { x, y };
}

export function invertHomography(matrix: number[]): number[] {
  checkMatrix(matrix);
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const inverse = [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ];
  const determinant = a * inverse[0] + b * inverse[3] + c * inverse[6];
  const scale = Math.max(...matrix.map(Math.abs));
  if (scale === 0 || Math.abs(determinant) <= 1e-12 * scale ** 3) {
    throw new Error(
      "Pitch alignment is degenerate. Spread the landmarks across the visible pitch.",
    );
  }
  return inverse.map((value) => value / determinant);
}

export function pitchToImage(matrix: number[], point: Vec2): Vec2 {
  return projectPoint(invertHomography(matrix), point);
}

function multiply(a: number[], b: number[]) {
  return Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3),
      column = index % 3;
    return (
      a[row * 3] * b[column] +
      a[row * 3 + 1] * b[column + 3] +
      a[row * 3 + 2] * b[column + 6]
    );
  });
}

function normalize(points: Vec2[]) {
  const center = points.reduce(
    (sum, point) => ({
      x: sum.x + point.x / points.length,
      y: sum.y + point.y / points.length,
    }),
    { x: 0, y: 0 },
  );
  const distance = points.reduce(
    (sum, point) =>
      sum + Math.hypot(point.x - center.x, point.y - center.y) / points.length,
    0,
  );
  if (distance < 1e-10) throw new Error("Choose distinct pitch landmarks.");
  const factor = Math.SQRT2 / distance;
  const matrix = [
    factor,
    0,
    -factor * center.x,
    0,
    factor,
    -factor * center.y,
    0,
    0,
    1,
  ];
  return { matrix, points: points.map((point) => projectPoint(matrix, point)) };
}

function checkSpread(points: Vec2[]) {
  const center = points.reduce(
    (sum, point) => ({
      x: sum.x + point.x / points.length,
      y: sum.y + point.y / points.length,
    }),
    { x: 0, y: 0 },
  );
  let xx = 0,
    xy = 0,
    yy = 0;
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
      throw new Error("Landmarks must be finite points.");
    if (
      points
        .slice(0, index)
        .some(
          (other) => Math.hypot(point.x - other.x, point.y - other.y) < 1e-8,
        )
    )
      throw new Error("Choose distinct pitch landmarks.");
    const x = point.x - center.x,
      y = point.y - center.y;
    xx += x * x;
    xy += x * y;
    yy += y * y;
  }
  const trace = xx + yy;
  if (trace < 1e-12 || (xx * yy - xy * xy) / (trace * trace) < 1e-8) {
    throw new Error(
      "Landmarks lie on one line. Spread them across the visible pitch.",
    );
  }
}

function solveSystem(matrix: number[][], vector: number[]) {
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  const size = vector.length;
  const scale = Math.max(...matrix.flat().map(Math.abs));
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++)
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column]))
        pivot = row;
    if (Math.abs(rows[pivot][column]) <= 1e-11 * Math.max(scale, 1))
      throw new Error(
        "These landmarks cannot determine a stable pitch alignment. Choose another set.",
      );
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let k = column; k <= size; k++) rows[column][k] /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let k = column; k <= size; k++)
        rows[row][k] -= factor * rows[column][k];
    }
  }
  return rows.map((row) => row[size]);
}

/** Maps normalized source-image points to pitch metres. Uses normalized least squares for 4+ correspondences. */
export function solveHomography(landmarks: Landmark[]): number[] {
  if (landmarks.length < 4)
    throw new Error("Choose at least four pitch landmarks.");
  const source = landmarks.map((mark) => mark.image),
    destination = landmarks.map((mark) => mark.pitch);
  checkSpread(source);
  checkSpread(destination);
  if (
    source.some(
      (point) => point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1,
    )
  )
    throw new Error("Image landmarks must lie inside the screenshot.");
  const normalizedSource = normalize(source),
    normalizedDestination = normalize(destination);
  const rows: number[][] = [],
    target: number[] = [];
  for (let index = 0; index < landmarks.length; index++) {
    const { x: u, y: v } = normalizedSource.points[index];
    const { x, y } = normalizedDestination.points[index];
    rows.push(
      [u, v, 1, 0, 0, 0, -x * u, -x * v],
      [0, 0, 0, u, v, 1, -y * u, -y * v],
    );
    target.push(x, y);
  }
  const normal = Array.from({ length: 8 }, (_, row) =>
    Array.from({ length: 8 }, (_, column) =>
      rows.reduce((sum, values) => sum + values[row] * values[column], 0),
    ),
  );
  const normalTarget = Array.from({ length: 8 }, (_, column) =>
    rows.reduce(
      (sum, values, index) => sum + values[column] * target[index],
      0,
    ),
  );
  const normalizedMatrix = [...solveSystem(normal, normalTarget), 1];
  const result = multiply(
    multiply(invertHomography(normalizedDestination.matrix), normalizedMatrix),
    normalizedSource.matrix,
  );
  const divisor =
    Math.abs(result[8]) > 1e-10 ? result[8] : Math.max(...result.map(Math.abs));
  const matrix = result.map((value) => value / divisor);
  invertHomography(matrix);
  source.forEach((point) => projectPoint(matrix, point));
  return matrix;
}
