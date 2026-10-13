import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type { Annotation, BoardProps, Vec2 } from "../domain/types";
import { clampPosition, newId } from "../domain/scene";
import { PitchMarks } from "./PitchMarks";

type Drag = {
  pointerId: number;
  start: Vec2;
  offset: Vec2;
  actorId?: string;
  annotation?: Annotation;
  endpoint?: "start" | "end";
  moved: boolean;
};

const teamFill = {
  a: "#f47345",
  b: "#86acd3",
  unknown: "#b8bcc4",
  official: "#f4d164",
};
const toolHelp = {
  select: "Tap a player to select. Drag to move; arrow keys nudge.",
  arrow: "Tap the start, then the end of the pass.",
  line: "Tap two points to draw a line.",
  circle: "Tap the center, then the edge of the circle.",
  zone: "Tap opposite corners to mark a zone.",
  label: "Tap the pitch to place a note.",
  add: "Tap the pitch to add a player.",
};

function AnnotationShape({
  annotation,
  arrowId,
  selected = false,
}: {
  annotation: Annotation;
  arrowId: string;
  selected?: boolean;
}) {
  const { start, end, color } = annotation;
  const common = {
    stroke: color,
    strokeWidth: selected ? 0.85 : 0.65,
    fill: "none",
  };
  if (annotation.kind === "zone")
    return (
      <rect
        {...common}
        x={Math.min(start.x, end.x)}
        y={Math.min(start.y, end.y)}
        width={Math.abs(end.x - start.x)}
        height={Math.abs(end.y - start.y)}
        fill={color}
        fillOpacity=".17"
        rx=".35"
      />
    );
  if (annotation.kind === "circle")
    return (
      <circle
        {...common}
        cx={start.x}
        cy={start.y}
        r={Math.hypot(end.x - start.x, end.y - start.y)}
        fill={color}
        fillOpacity=".08"
      />
    );
  if (annotation.kind === "label")
    return (
      <g>
        <rect
          x={start.x - 0.7}
          y={start.y - 2.3}
          width={Math.max(5, (annotation.text ?? "Note").length * 1.1 + 1.4)}
          height="3.6"
          rx=".5"
          fill="#15241e"
          opacity=".92"
        />
        <text
          x={start.x}
          y={start.y}
          fill={color}
          fontSize="2.1"
          fontWeight="600"
        >
          {annotation.text ?? "Note"}
        </text>
      </g>
    );
  return (
    <path
      {...common}
      d={`M${start.x} ${start.y}L${end.x} ${end.y}`}
      markerEnd={annotation.kind === "arrow" ? `url(#${arrowId})` : undefined}
    />
  );
}

export function BoardEditor(props: BoardProps) {
  const {
    scene,
    positions,
    annotations,
    selectedId,
    tool,
    color,
    readOnly,
    anchorMode,
    onSelect,
    onMove,
    onAnnotation,
    onAdd,
    onAnchor,
    onComment,
    onUpdateAnnotation,
    onSelectAnnotation,
    selectedAnnotationId,
    commentAnchors = [],
  } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [start, setStart] = useState<Vec2 | null>(null);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [movePreview, setMovePreview] = useState<{
    id: string;
    position: Vec2;
  } | null>(null);
  const [annotationPreview, setAnnotationPreview] = useState<Annotation | null>(
    null,
  );
  const arrowId = `board-arrow-${useId().replace(/:/g, "")}`;
  const helpId = `board-help-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    setStart(null);
    setCursor(null);
  }, [tool, anchorMode]);
  useEffect(() => {
    if (readOnly) {
      dragRef.current = null;
      setMovePreview(null);
      setAnnotationPreview(null);
      setStart(null);
    }
  }, [readOnly]);

  function groundPoint(event: PointerEvent<SVGSVGElement>): Vec2 {
    const svg = svgRef.current!;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const transform = svg.getScreenCTM();
    if (!transform) return { x: 0, y: 0 };
    const local = point.matrixTransform(transform.inverse());
    return clampPosition({ x: local.x, y: local.y }, scene.pitch);
  }

  function down(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    const element = event.target as Element;
    const commentId = element
      .closest("[data-comment]")
      ?.getAttribute("data-comment");
    if (commentId) {
      onComment?.(commentId);
      return;
    }
    const actorId = element.closest("[data-actor]")?.getAttribute("data-actor");
    const annotationId = element
      .closest("[data-annotation]")
      ?.getAttribute("data-annotation");
    const endpoint = element
      .closest("[data-endpoint]")
      ?.getAttribute("data-endpoint") as "start" | "end" | null;
    const position = groundPoint(event);
    if (anchorMode) {
      onAnchor?.(position);
      return;
    }
    if (readOnly) {
      onSelect(actorId ?? null);
      onSelectAnnotation?.(annotationId ?? null);
      return;
    }
    if (tool === "select") {
      if (annotationId) {
        onSelectAnnotation?.(annotationId);
        onSelect(null);
        const annotation = annotations.find((item) => item.id === annotationId);
        if (endpoint && annotation && onUpdateAnnotation) {
          dragRef.current = {
            pointerId: event.pointerId,
            start: position,
            offset: {
              x: position.x - annotation[endpoint].x,
              y: position.y - annotation[endpoint].y,
            },
            annotation,
            endpoint,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      } else {
        onSelect(actorId ?? null);
        onSelectAnnotation?.(null);
        if (actorId && positions[actorId]) {
          dragRef.current = {
            pointerId: event.pointerId,
            start: position,
            offset: {
              x: position.x - positions[actorId].x,
              y: position.y - positions[actorId].y,
            },
            actorId,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }
      return;
    }
    const snapped =
      actorId && positions[actorId] ? positions[actorId] : position;
    if (tool === "add") {
      onAdd(snapped);
      return;
    }
    if (tool === "label") {
      const annotation: Annotation = {
        id: newId(),
        kind: "label",
        start: snapped,
        end: snapped,
        color,
        text: "Note",
      };
      onAnnotation(annotation);
      onSelectAnnotation?.(annotation.id);
      return;
    }
    if (!start) {
      setStart(snapped);
      setCursor(snapped);
      return;
    }
    if (Math.hypot(snapped.x - start.x, snapped.y - start.y) < 0.25) return;
    const annotation: Annotation = {
      id: newId(),
      kind: tool,
      start: { ...start },
      end: { ...snapped },
      color,
    };
    onAnnotation(annotation);
    onSelectAnnotation?.(annotation.id);
    setStart(null);
    setCursor(null);
  }

  function move(event: PointerEvent<SVGSVGElement>) {
    const position = groundPoint(event),
      drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      if (start) setCursor(position);
      return;
    }
    if (Math.hypot(position.x - drag.start.x, position.y - drag.start.y) > 0.12)
      drag.moved = true;
    const next = clampPosition(
      { x: position.x - drag.offset.x, y: position.y - drag.offset.y },
      scene.pitch,
    );
    if (drag.actorId) setMovePreview({ id: drag.actorId, position: next });
    if (drag.annotation && drag.endpoint)
      setAnnotationPreview({ ...drag.annotation, [drag.endpoint]: next });
  }

  function up(event: PointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const position = groundPoint(event);
    const next = clampPosition(
      { x: position.x - drag.offset.x, y: position.y - drag.offset.y },
      scene.pitch,
    );
    if (drag.moved && drag.actorId) onMove(drag.actorId, next);
    if (drag.moved && drag.annotation && drag.endpoint)
      onUpdateAnnotation?.({ ...drag.annotation, [drag.endpoint]: next });
    dragRef.current = null;
    setMovePreview(null);
    setAnnotationPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function cancel() {
    dragRef.current = null;
    setMovePreview(null);
    setAnnotationPreview(null);
    setStart(null);
    setCursor(null);
  }
  function actorKey(event: KeyboardEvent<SVGGElement>, id: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(id);
      return;
    }
    if (
      readOnly ||
      anchorMode ||
      tool !== "select" ||
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    )
      return;
    event.preventDefault();
    onSelect(id);
    const delta = event.shiftKey ? 5 : 1,
      position = positions[id];
    if (position)
      onMove(
        id,
        clampPosition(
          {
            x:
              position.x +
              (event.key === "ArrowRight"
                ? delta
                : event.key === "ArrowLeft"
                  ? -delta
                  : 0),
            y:
              position.y +
              (event.key === "ArrowDown"
                ? delta
                : event.key === "ArrowUp"
                  ? -delta
                  : 0),
          },
          scene.pitch,
        ),
      );
  }

  const preview =
    start && cursor && tool !== "select" && tool !== "add" && tool !== "label"
      ? ({ id: "preview", kind: tool, start, end: cursor, color } as Annotation)
      : null;
  return (
    <div className="board-shell">
      <svg
        ref={svgRef}
        className="board-canvas"
        viewBox={`-5 -5 ${scene.pitch.length + 10} ${scene.pitch.width + 10}`}
        role="group"
        aria-label="Interactive tactical pitch"
        aria-describedby={helpId}
        style={{
          width: "100%",
          height: "100%",
          minHeight: 240,
          touchAction: "none",
          display: "block",
        }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        onLostPointerCapture={() => {
          if (dragRef.current) cancel();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") cancel();
        }}
      >
        <defs>
          <marker
            id={arrowId}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
            markerUnits="strokeWidth"
          >
            <path
              d="M1 1L9 5L1 9"
              fill="none"
              stroke="context-stroke"
              strokeWidth="2"
            />
          </marker>
        </defs>
        <rect
          x="-5"
          y="-5"
          width={scene.pitch.length + 10}
          height={scene.pitch.width + 10}
          rx="2"
          fill="#14291f"
        />
        <rect
          className="pitch-surface"
          width={scene.pitch.length}
          height={scene.pitch.width}
          rx=".4"
          fill="#284736"
        />
        {Array.from({ length: 10 }, (_, index) => (
          <rect
            key={index}
            x={(index * scene.pitch.length) / 10}
            y="0"
            width={scene.pitch.length / 10}
            height={scene.pitch.width}
            fill="#355440"
            opacity={index % 2 ? 0.38 : 0}
            pointerEvents="none"
          />
        ))}
        <PitchMarks length={scene.pitch.length} width={scene.pitch.width} />
        <text
          x="1"
          y="-1.6"
          fill="#b2c0b7"
          fontSize="1.65"
          letterSpacing=".4"
          pointerEvents="none"
        >
          {scene.pitch.length} × {scene.pitch.width} m ·{" "}
          {scene.calibration.status === "confirmed"
            ? "Alignment reviewed"
            : "Estimated positions"}
        </text>
        {annotations.map((original) => {
          const annotation =
            annotationPreview?.id === original.id
              ? annotationPreview
              : original;
          const selected = selectedAnnotationId === annotation.id;
          return (
            <g
              key={annotation.id}
              data-annotation={annotation.id}
              className={selected ? "annotation-selected" : undefined}
              role="button"
              tabIndex={0}
              aria-label={`${annotation.kind}${annotation.text ? `: ${annotation.text}` : ""}`}
              style={{ cursor: readOnly ? "pointer" : "crosshair" }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectAnnotation?.(annotation.id);
                  onSelect(null);
                }
              }}
            >
              {annotation.kind === "arrow" || annotation.kind === "line" ? (
                <path
                  d={`M${annotation.start.x} ${annotation.start.y}L${annotation.end.x} ${annotation.end.y}`}
                  fill="none"
                  stroke="transparent"
                  strokeWidth="3"
                />
              ) : null}
              <AnnotationShape
                annotation={annotation}
                arrowId={arrowId}
                selected={selected}
              />
              {selected &&
                !readOnly &&
                tool === "select" &&
                (["start", "end"] as const)
                  .filter(
                    (endpoint) =>
                      annotation.kind !== "label" || endpoint === "start",
                  )
                  .map((endpoint) => (
                    <circle
                      key={endpoint}
                      data-endpoint={endpoint}
                      cx={annotation[endpoint].x}
                      cy={annotation[endpoint].y}
                      r="1"
                      fill="#f5f0dc"
                      stroke={annotation.color}
                      strokeWidth=".4"
                      role="button"
                      tabIndex={0}
                      aria-label={`Move ${annotation.kind} ${endpoint} point`}
                      onKeyDown={(event) => {
                        if (
                          ![
                            "ArrowLeft",
                            "ArrowRight",
                            "ArrowUp",
                            "ArrowDown",
                          ].includes(event.key)
                        )
                          return;
                        event.preventDefault();
                        event.stopPropagation();
                        const point = annotation[endpoint];
                        onUpdateAnnotation?.({
                          ...annotation,
                          [endpoint]: clampPosition(
                            {
                              x:
                                point.x +
                                (event.key === "ArrowRight"
                                  ? 1
                                  : event.key === "ArrowLeft"
                                    ? -1
                                    : 0),
                              y:
                                point.y +
                                (event.key === "ArrowDown"
                                  ? 1
                                  : event.key === "ArrowUp"
                                    ? -1
                                    : 0),
                            },
                            scene.pitch,
                          ),
                        });
                      }}
                    />
                  ))}
            </g>
          );
        })}
        {preview && (
          <g opacity=".6" pointerEvents="none">
            <AnnotationShape annotation={preview} arrowId={arrowId} />
            <circle
              cx={preview.start.x}
              cy={preview.start.y}
              r=".65"
              fill={color}
            />
          </g>
        )}
        {scene.actors.map((actor) => {
          const position =
            movePreview?.id === actor.id
              ? movePreview.position
              : (positions[actor.id] ?? actor.position);
          const selected = selectedId === actor.id;
          const ball = actor.role === "ball";
          const label =
            actor.name ||
            actor.label ||
            `${actor.team === "a" ? "Coral" : actor.team === "b" ? "Blue" : actor.team === "official" ? "Official" : "Unassigned"} ${actor.number ?? "player"}`;
          return (
            <g
              key={actor.id}
              data-actor={actor.id}
              className={`actor-marker ${selected ? "actor-selected" : ""}`}
              transform={`translate(${position.x} ${position.y})`}
              role="button"
              tabIndex={0}
              aria-label={
                ball
                  ? "Ball"
                  : `${label}${actor.needsReview ? ", needs review" : ""}`
              }
              aria-pressed={selected}
              onKeyDown={(event) => actorKey(event, actor.id)}
              style={{ cursor: readOnly ? "pointer" : "grab" }}
            >
              <circle r={ball ? 2.1 : 3.2} fill="transparent" />
              {selected && (
                <circle
                  r={ball ? 1.7 : 2.65}
                  fill="none"
                  stroke="#f7eed6"
                  strokeWidth=".4"
                />
              )}
              <circle
                r={ball ? 0.8 : 1.85}
                fill={ball ? "#f6f3df" : teamFill[actor.team]}
                stroke="#173125"
                strokeWidth=".45"
              />
              {ball ? (
                <path d="M-.3-.3H.3V.3H-.3Z" fill="#284736" />
              ) : (
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize="1.65"
                  fill="#182723"
                  fontWeight="700"
                  pointerEvents="none"
                >
                  {actor.number ||
                    actor.label ||
                    (actor.role === "official" ? "R" : "?")}
                </text>
              )}
              {actor.needsReview && (
                <circle
                  cx="1.65"
                  cy="-1.65"
                  r=".62"
                  fill="#f2d67d"
                  stroke="#173125"
                  strokeWidth=".2"
                />
              )}
              {selected && actor.name && (
                <g pointerEvents="none">
                  <rect
                    x={-Math.max(4, actor.name.length * 0.65)}
                    y="-6"
                    width={Math.max(8, actor.name.length * 1.3)}
                    height="2.5"
                    rx=".45"
                    fill="#10251a"
                  />
                  <text
                    y="-4.25"
                    textAnchor="middle"
                    fill="#f7eed6"
                    fontSize="1.6"
                  >
                    {actor.name}
                  </text>
                </g>
              )}
            </g>
          );
        })}
        {commentAnchors.map((anchor) => (
          <g
            key={anchor.id}
            className="comment-pin"
            data-comment={anchor.id}
            transform={`translate(${anchor.point.x} ${anchor.point.y})`}
            tabIndex={0}
            role="button"
            aria-label="Open comment at this position"
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onComment?.(anchor.id);
              }
            }}
            style={{ cursor: "pointer" }}
          >
            <circle r="1.45" fill="#efdfac" stroke="#14291f" strokeWidth=".4" />
            <path d="M-.6-.3H.6M-.6.2H.3" stroke="#14291f" strokeWidth=".22" />
          </g>
        ))}
      </svg>
      <p className="board-help" id={helpId}>
        {anchorMode
          ? "Tap the pitch to anchor your comment."
          : readOnly
            ? "Select a player to explore this published play."
            : start
              ? "Choose the second point."
              : toolHelp[tool]}
      </p>
      {start && (
        <button
          type="button"
          className="btn secondary board-cancel"
          style={{
            position: "absolute",
            right: 10,
            bottom: 10,
            minHeight: 36,
            padding: "7px 12px",
            fontSize: 12,
          }}
          onClick={cancel}
        >
          Cancel
        </button>
      )}
    </div>
  );
}

export default BoardEditor;
