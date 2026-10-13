import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Crosshair,
  RotateCcw,
  ScanLine,
  Users,
} from "lucide-react";
import type { Scene, Vec2 } from "../domain/types";
import {
  pitchToImage,
  projectPoint,
  solveHomography,
} from "../domain/calibration";
import { getPitchLineSegments } from "./PitchMarks";

export type ReviewStep = "crop" | "analysis" | "alignment" | "players";
type Props = {
  onStartAdd?: () => void;
  adding?: boolean;
  onAdd?: (image: Vec2, position: Vec2) => void;
  readOnly?: boolean;
  scene: Scene;
  step: ReviewStep;
  stage: string;
  onChange: (scene: Scene) => void;
  onCrop: (crop: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => void;
  onContinue: () => void;
  onManual: () => void;
  onSelect: (id: string) => void;
  selectedId: string | null;
};
export default function SourceReview({
  onStartAdd,
  adding = false,
  onAdd,
  readOnly = false,
  scene,
  step,
  stage,
  onChange,
  onCrop,
  onContinue,
  onManual,
  onSelect,
  selectedId,
}: Props) {
  const source = scene.source!;
  const [customIds, setCustomIds] = useState([3, 4, 5, 6]);
  const middleX = scene.pitch.length / 2,
    middleY = scene.pitch.width / 2;
  const customLandmarks = [
    { name: "Halfway / far touchline", point: { x: middleX, y: 0 } },
    {
      name: "Halfway / near touchline",
      point: { x: middleX, y: scene.pitch.width },
    },
    { name: "Centre spot", point: { x: middleX, y: middleY } },
    {
      name: "Centre circle / left edge",
      point: { x: middleX - 9.15, y: middleY },
    },
    {
      name: "Centre circle / right edge",
      point: { x: middleX + 9.15, y: middleY },
    },
    {
      name: "Centre circle / upper crossing",
      point: { x: middleX, y: middleY - 9.15 },
    },
    {
      name: "Centre circle / lower crossing",
      point: { x: middleX, y: middleY + 9.15 },
    },
    { name: "Left penalty spot", point: { x: 11, y: middleY } },
    {
      name: "Right penalty spot",
      point: { x: scene.pitch.length - 11, y: middleY },
    },
    {
      name: "Left penalty box / upper inner corner",
      point: { x: 16.5, y: middleY - 20.16 },
    },
    {
      name: "Left penalty box / lower inner corner",
      point: { x: 16.5, y: middleY + 20.16 },
    },
    {
      name: "Right penalty box / upper inner corner",
      point: { x: scene.pitch.length - 16.5, y: middleY - 20.16 },
    },
    {
      name: "Right penalty box / lower inner corner",
      point: { x: scene.pitch.length - 16.5, y: middleY + 20.16 },
    },
    {
      name: "Left six-yard box / upper inner corner",
      point: { x: 5.5, y: middleY - 9.16 },
    },
    {
      name: "Left six-yard box / lower inner corner",
      point: { x: 5.5, y: middleY + 9.16 },
    },
    {
      name: "Right six-yard box / upper inner corner",
      point: { x: scene.pitch.length - 5.5, y: middleY - 9.16 },
    },
    {
      name: "Right six-yard box / lower inner corner",
      point: { x: scene.pitch.length - 5.5, y: middleY + 9.16 },
    },
  ];
  const actualTargets = [
    {
      name: "Left penalty area",
      points: [
        { x: 0, y: scene.pitch.width / 2 - 20.16 },
        { x: 16.5, y: scene.pitch.width / 2 - 20.16 },
        { x: 16.5, y: scene.pitch.width / 2 + 20.16 },
        { x: 0, y: scene.pitch.width / 2 + 20.16 },
      ],
    },
    {
      name: "Right penalty area",
      points: [
        { x: scene.pitch.length, y: scene.pitch.width / 2 - 20.16 },
        { x: scene.pitch.length - 16.5, y: scene.pitch.width / 2 - 20.16 },
        { x: scene.pitch.length - 16.5, y: scene.pitch.width / 2 + 20.16 },
        { x: scene.pitch.length, y: scene.pitch.width / 2 + 20.16 },
      ],
    },
    {
      name: "Centre and touchlines",
      points: [
        { x: scene.pitch.length / 2, y: 0 },
        { x: scene.pitch.length / 2, y: scene.pitch.width },
        { x: 0, y: 0 },
        { x: 0, y: scene.pitch.width },
      ],
    },
  ];
  actualTargets.push({
    name: "Other visible landmarks",
    points: customIds.map((id) => customLandmarks[id].point),
  });
  const svg = useRef<SVGSVGElement>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0, width: 1, height: 1 });
  const [preset, setPreset] = useState(0);
  const [points, setPoints] = useState<Vec2[]>([]);
  const [error, setError] = useState("");
  const drag = useRef<{ id: string } | null>(null);
  useEffect(() => {
    setCrop({ x: 0, y: 0, width: 1, height: 1 });
    setPoints([]);
    setError("");
  }, [source.url]);
  useEffect(() => {
    if (step !== "crop") return;
    let canceled = false;
    const image = new Image();
    image.onload = () => {
      if (canceled) return;
      const c = document.createElement("canvas");
      c.width = 240;
      c.height = Math.max(1, Math.round((240 * image.height) / image.width));
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(image, 0, 0, c.width, c.height);
      try {
        const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
        const xs: number[] = [],
          ys: number[] = [];
        for (let y = 0; y < c.height; y++)
          for (let x = 0; x < c.width; x++) {
            const i = (y * c.width + x) * 4;
            const r = pixels[i],
              g = pixels[i + 1],
              b = pixels[i + 2];
            if (g > 55 && g > r * 1.12 && g > b * 1.2) {
              xs.push(x);
              ys.push(y);
            }
          }
        if (xs.length < c.width * c.height * 0.13) return;
        xs.sort((a, b) => a - b);
        ys.sort((a, b) => a - b);
        const q = (v: number[], p: number) => v[Math.floor((v.length - 1) * p)];
        const x = Math.max(0, q(xs, 0.005) / c.width - 0.02),
          y = Math.max(0, q(ys, 0.005) / c.height - 0.02);
        const right = Math.min(1, q(xs, 0.995) / c.width + 0.02),
          bottom = Math.min(1, q(ys, 0.995) / c.height + 0.02);
        if (!canceled) setCrop({ x, y, width: right - x, height: bottom - y });
      } catch {
        /* cross-origin sample keeps full crop */
      }
    };
    image.src = source.url;
    return () => {
      canceled = true;
    };
  }, [source.url, step]);
  const point = (event: React.PointerEvent) => {
    const matrix = svg.current!.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(
      matrix.inverse(),
    );
    return {
      x: Math.max(0, Math.min(1, local.x / source.width)),
      y: Math.max(0, Math.min(1, local.y / source.height)),
    };
  };
  const align = () => {
    try {
      const landmarks = points.map((image, i) => ({
        image,
        pitch: actualTargets[preset].points[i],
      }));
      const matrix = solveHomography(landmarks);
      const actors = scene.actors.map((actor) => {
        if (!actor.imagePoint || actor.provenance === "manual") return actor;
        const projected = projectPoint(matrix, actor.imagePoint);
        const outside =
          projected.x < 0 ||
          projected.x > scene.pitch.length ||
          projected.y < 0 ||
          projected.y > scene.pitch.width;
        return {
          ...actor,
          position: {
            x: Math.max(0, Math.min(scene.pitch.length, projected.x)),
            y: Math.max(0, Math.min(scene.pitch.width, projected.y)),
          },
          needsReview: actor.needsReview || outside,
        };
      });
      const positions = { ...scene.keyframes[0].positions };
      actors.forEach((actor) => {
        if (actor.imagePoint && actor.provenance !== "manual")
          positions[actor.id] = actor.position;
      });
      onChange({
        ...scene,
        calibration: { status: "confirmed", matrix, landmarks },
        actors,
        keyframes: scene.keyframes.map((f, i) =>
          i === 0 ? { ...f, positions } : f,
        ),
      });
      setError("");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Those landmarks cannot align the pitch. Try again.",
      );
    }
  };
  const projectedLines = () => {
    if (!scene.calibration.matrix) return [];
    try {
      return getPitchLineSegments(scene.pitch.length, scene.pitch.width).map(
        (line) =>
          line
            .map((p) => {
              const v = pitchToImage(scene.calibration.matrix!, p);
              return `${v.x * source.width},${v.y * source.height}`;
            })
            .join(" "),
      );
    } catch {
      return [];
    }
  };
  return (
    <section className="source-review">
      <div className="review-instruction">
        <span className="eyebrow">
          {step === "crop"
            ? "01 / PREPARE"
            : step === "analysis"
              ? "02 / RECONSTRUCT"
              : step === "alignment"
                ? "02 / ALIGN THE PITCH"
                : "03 / CHECK THE PLAYERS"}
        </span>
        <h2>
          {step === "crop"
            ? "Keep the play. Crop the rest."
            : step === "analysis"
              ? stage
              : step === "alignment"
                ? "Does the pitch line up?"
                : "A quick check before you explore."}
        </h2>
        <p>
          {step === "crop"
            ? "We suggested a crop around the grass. Adjust it to keep every visible player."
            : step === "analysis"
              ? "Your screenshot stays here while we prepare the tactical view."
              : step === "alignment"
                ? "Align visible field markings so the players land in the right place."
                : adding
                  ? "Tap the missing player's feet on the screenshot to add their position."
                  : "Select a marker to tag it. Drag its footpoint, change its team, or add a missed player."}
        </p>
      </div>
      <div className="source-image-wrap">
        <svg
          ref={svg}
          viewBox={`0 0 ${source.width} ${source.height}`}
          className="source-canvas"
          role="img"
          aria-label="Uploaded match screenshot with reconstruction overlay"
          onPointerDown={(e) => {
            if (step === "alignment" && points.length < 4) {
              setPoints([...points, point(e)]);
              return;
            }
            if (step === "players" && !readOnly) {
              const p = point(e);
              if (adding) {
                const ground = scene.calibration.matrix
                  ? projectPoint(scene.calibration.matrix, p)
                  : { x: p.x * scene.pitch.length, y: p.y * scene.pitch.width };
                onAdd?.(p, {
                  x: Math.max(0, Math.min(scene.pitch.length, ground.x)),
                  y: Math.max(0, Math.min(scene.pitch.width, ground.y)),
                });
                return;
              }
              const actor = scene.actors.find(
                (a) =>
                  a.imagePoint &&
                  Math.hypot(a.imagePoint.x - p.x, a.imagePoint.y - p.y) <
                    0.035,
              );
              if (actor) {
                onSelect(actor.id);
                drag.current = { id: actor.id };
                e.currentTarget.setPointerCapture(e.pointerId);
              }
            }
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const p = point(e),
              id = drag.current.id;
            let position: Vec2;
            try {
              position = scene.calibration.matrix
                ? projectPoint(scene.calibration.matrix, p)
                : { x: p.x * scene.pitch.length, y: p.y * scene.pitch.width };
            } catch {
              return;
            }
            const actors = scene.actors.map((a) =>
              a.id === id
                ? {
                    ...a,
                    imagePoint: p,
                    position,
                    provenance: "manual" as const,
                    needsReview: false,
                  }
                : a,
            );
            onChange({
              ...scene,
              actors,
              keyframes: scene.keyframes.map((f, i) =>
                i === 0
                  ? { ...f, positions: { ...f.positions, [id]: position } }
                  : f,
              ),
            });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          <image
            href={source.url}
            width={source.width}
            height={source.height}
          />
          {step === "crop" && (
            <>
              <path
                d={`M0 0H${source.width}V${source.height}H0Z M${crop.x * source.width} ${crop.y * source.height}v${crop.height * source.height}h${crop.width * source.width}v-${crop.height * source.height}Z`}
                fill="rgba(0,0,0,.56)"
                fillRule="evenodd"
              />
              <rect
                x={crop.x * source.width}
                y={crop.y * source.height}
                width={crop.width * source.width}
                height={crop.height * source.height}
                fill="none"
                stroke="#d8fb7a"
                strokeWidth={source.width / 350}
              />
            </>
          )}
          {step !== "crop" &&
            projectedLines().map((line, i) => (
              <polyline
                key={i}
                points={line}
                fill="none"
                stroke="#d8fb7a"
                strokeWidth={source.width / 450}
                strokeDasharray={`${source.width / 100} ${source.width / 200}`}
              />
            ))}
          {step === "alignment" &&
            points.map((p, i) => (
              <g
                key={i}
                transform={`translate(${p.x * source.width} ${p.y * source.height})`}
              >
                <circle r={source.width / 55} fill="#d8fb7a" />
                <text
                  fontSize={source.width / 55}
                  textAnchor="middle"
                  dy=".35em"
                  fill="#15221b"
                  fontWeight="700"
                >
                  {i + 1}
                </text>
              </g>
            ))}
          {step === "players" &&
            scene.actors
              .filter((a) => a.imagePoint)
              .map((a) => (
                <g
                  key={a.id}
                  className="source-marker"
                  transform={`translate(${a.imagePoint!.x * source.width} ${a.imagePoint!.y * source.height})`}
                  tabIndex={0}
                  role="button"
                  aria-label={`Select ${a.name || a.label || a.number || a.id}`}
                  onClick={() => onSelect(a.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(a.id);
                    }
                  }}
                >
                  <circle
                    r={source.width / 55}
                    fill={
                      a.role === "ball"
                        ? "#fff"
                        : a.team === "a"
                          ? "#fa9b72"
                          : a.team === "b"
                            ? "#89bfe9"
                            : "#d8fb7a"
                    }
                    stroke={selectedId === a.id ? "#d8fb7a" : "#fff"}
                    strokeWidth={source.width / 400}
                  />
                  <text
                    textAnchor="middle"
                    dy=".35em"
                    fontSize={source.width / 70}
                    fontWeight="700"
                    fill="#19271f"
                  >
                    {a.role === "ball"
                      ? "●"
                      : a.number || a.label || a.id.slice(-2)}
                  </text>
                </g>
              ))}
        </svg>
        {step === "analysis" && (
          <div className="analysis-overlay">
            <ScanLine size={38} />
            <strong>{stage}</strong>
            <span className="progress-track">
              <span />
            </span>
          </div>
        )}
      </div>
      {step === "crop" && (
        <>
          <div className="crop-controls">
            {(["x", "y", "width", "height"] as const).map((key) => (
              <label key={key}>
                {key === "x"
                  ? "Left"
                  : key === "y"
                    ? "Top"
                    : key === "width"
                      ? "Width"
                      : "Height"}
                <input
                  aria-label={`Crop ${key}`}
                  type="range"
                  min={key === "width" || key === "height" ? 0.08 : 0}
                  max={
                    key === "x"
                      ? 1 - crop.width
                      : key === "y"
                        ? 1 - crop.height
                        : key === "width"
                          ? 1 - crop.x
                          : 1 - crop.y
                  }
                  step=".005"
                  value={crop[key]}
                  onChange={(e) =>
                    setCrop({ ...crop, [key]: Number(e.target.value) })
                  }
                />
              </label>
            ))}
          </div>
          <div className="review-actions">
            <button
              className="btn ghost"
              onClick={() => setCrop({ x: 0, y: 0, width: 1, height: 1 })}
            >
              <RotateCcw size={16} /> Full image
            </button>
            <button className="btn primary" onClick={() => onCrop(crop)}>
              Create tactical board <ChevronRight size={17} />
            </button>
          </div>
        </>
      )}
      {step === "alignment" && (
        <>
          <div className="alignment-guide">
            <div>
              <label className="field-label" htmlFor="landmarks">
                Visible landmarks
              </label>
              <select
                id="landmarks"
                value={preset}
                onChange={(e) => {
                  setPreset(Number(e.target.value));
                  setPoints([]);
                }}
              >
                {actualTargets.map((target, i) => (
                  <option value={i} key={i}>
                    {target.name}
                  </option>
                ))}
              </select>
              <p>
                {points.length < 4
                  ? `Tap point ${points.length + 1} on your screenshot, matching the diagram.`
                  : "All four points placed. Apply the alignment and check the overlay."}
              </p>
            </div>
            <svg
              viewBox="-5 -5 115 78"
              aria-label="Landmark reference diagram"
              className="landmark-diagram"
            >
              <rect width="105" height="68" fill="#344c3d" />
              <path
                d="M0 0H105V68H0ZM52.5 0V68M0 13.84H16.5V54.16H0M105 13.84H88.5V54.16H105"
                fill="none"
                stroke="#d8e5d9"
                strokeWidth=".6"
              />
              {actualTargets[preset].points
                .map((point, i) => ({
                  x: (point.x / scene.pitch.length) * 105,
                  y: (point.y / scene.pitch.width) * 68,
                }))
                .map((p, i) => (
                  <g key={i}>
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r="4"
                      fill={i === points.length ? "#d8fb7a" : "#fff"}
                    />
                    <text
                      x={p.x}
                      y={p.y + 1.4}
                      textAnchor="middle"
                      fontSize="4"
                      fill="#18271f"
                      fontWeight="700"
                    >
                      {i + 1}
                    </text>
                  </g>
                ))}
            </svg>
          </div>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {preset === 3 && (
            <div className="custom-landmarks">
              {customIds.map((id, index) => (
                <label key={index}>
                  Point {index + 1}
                  <select
                    aria-label={`Landmark ${index + 1}`}
                    value={id}
                    onChange={(event) => {
                      setCustomIds(
                        customIds.map((value, i) =>
                          i === index ? Number(event.target.value) : value,
                        ),
                      );
                      setPoints([]);
                      setError("");
                    }}
                  >
                    {customLandmarks.map((landmark, i) => (
                      <option key={landmark.name} value={i}>
                        {landmark.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <p>
                Choose four distinct visible markings spread across the image.
                They must not all lie on the same line.
              </p>
            </div>
          )}
          <div className="review-actions">
            <button
              className="btn ghost"
              onClick={() => {
                setPoints([]);
                setError("");
              }}
            >
              <RotateCcw size={16} /> Reset points
            </button>
            {points.length === 4 && (
              <button className="btn secondary" onClick={align}>
                <Crosshair size={16} /> Apply alignment
              </button>
            )}
            <button
              className="btn primary"
              disabled={!scene.calibration.matrix}
              onClick={onContinue}
            >
              <Check size={16} /> Looks right
            </button>
          </div>
          <button className="text-link manual-link" onClick={onManual}>
            Not enough markings? Use an approximate manual board
          </button>
        </>
      )}
      {step === "players" && !readOnly && (
        <div className="review-actions">
          <span className="review-count">
            <Users size={17} />
            {scene.actors.filter((a) => a.role !== "ball").length} visible
            players · {scene.actors.filter((a) => a.needsReview).length} to
            review
          </span>
          <button className="btn secondary" onClick={onStartAdd}>
            <Users size={16} />
            Add player
          </button>
          <button className="btn primary" onClick={onContinue}>
            Open the editor <ChevronRight size={17} />
          </button>
        </div>
      )}
    </section>
  );
}
