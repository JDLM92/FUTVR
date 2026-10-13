export type Vec2 = { x: number; y: number };
export type ViewMode = "source" | "board" | "3d";
export type Tool =
  "select" | "arrow" | "line" | "circle" | "zone" | "label" | "add";
export type Team = "a" | "b" | "unknown" | "official";
export type Actor = {
  id: string;
  role: "player" | "ball" | "official";
  team: Team;
  position: Vec2;
  name?: string;
  label?: string;
  number?: string;
  provenance: "automatic" | "manual" | "sample";
  imagePoint?: Vec2;
  needsReview?: boolean;
};
export type Annotation = {
  id: string;
  kind: "arrow" | "line" | "circle" | "zone" | "label";
  start: Vec2;
  end: Vec2;
  color: string;
  text?: string;
};
export type Keyframe = {
  id: string;
  durationMs: number;
  holdMs: number;
  positions: Record<string, Vec2>;
  annotations: Annotation[];
};
export type Calibration = {
  status: "estimated" | "confirmed" | "manual" | "unavailable";
  matrix?: number[];
  landmarks?: { image: Vec2; pitch: Vec2 }[];
};
export type Scene = {
  schemaVersion: 1;
  id: string;
  title: string;
  revision: number;
  pitch: { length: number; width: number };
  source?: {
    type: "image";
    url: string;
    width: number;
    height: number;
    crop: { x: number; y: number; width: number; height: number };
    assetId?: string;
    timestampMs?: number;
  };
  calibration: Calibration;
  actors: Actor[];
  keyframes: Keyframe[];
  createdAt: string;
  updatedAt: string;
};
export type CommentAnchor = { actorId?: string; point?: Vec2; timeMs: number };
export type Comment = {
  id: string;
  publicationId: string;
  parentId?: string;
  author: string;
  authorId: string;
  body: string;
  anchor: CommentAnchor;
  createdAt: string;
};
export type Publication = {
  id: string;
  scene: Scene;
  ownerId: string;
  createdAt: string;
  includeSource: boolean;
};
export type AnalysisDetection = {
  id: string;
  role: "player" | "ball" | "official";
  team: Team;
  imagePoint: Vec2;
  needsReview: boolean;
  box?: number[];
};
export type AnalysisJob = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  stage?: string;
  error?: string;
  result?: {
    detections: AnalysisDetection[];
    calibration: Calibration;
    notice?: string;
  };
};
export type Scene3DProps = {
  scene: Scene;
  positions: Record<string, Vec2>;
  annotations: Annotation[];
  selectedId: string | null;
  readOnly: boolean;
  isPlaying: boolean;
  onSelect: (id: string | null) => void;
  onMove: (id: string, position: Vec2) => void;
  onAnnotation: (annotation: Annotation) => void;
  onUndo: () => void;
  onPlayPause: () => void;
  onError: (message: string) => void;
};
export type BoardProps = {
  scene: Scene;
  positions: Record<string, Vec2>;
  annotations: Annotation[];
  selectedId: string | null;
  tool: Tool;
  color: string;
  readOnly: boolean;
  anchorMode?: boolean;
  commentAnchors?: { id: string; point: Vec2 }[];
  onSelect: (id: string | null) => void;
  onMove: (id: string, position: Vec2) => void;
  onAnnotation: (annotation: Annotation) => void;
  onUpdateAnnotation?: (annotation: Annotation) => void;
  onSelectAnnotation?: (id: string | null) => void;
  selectedAnnotationId?: string | null;
  onAdd: (position: Vec2) => void;
  onAnchor?: (point: Vec2) => void;
  onComment?: (id: string) => void;
};
