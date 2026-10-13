import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Circle,
  CircleHelp,
  Clipboard,
  Copy,
  Crosshair,
  Cuboid,
  Ellipsis,
  Eye,
  FileImage,
  Flag,
  FolderOpen,
  Headset,
  ImagePlus,
  Layers,
  MessageCircle,
  MousePointer2,
  Plus,
  ScanLine,
  Send,
  Share2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Type,
  Undo2,
  Upload,
  Users,
  X,
} from "lucide-react";
import type {
  Actor,
  Annotation,
  Comment,
  CommentAnchor,
  Publication,
  Scene,
  Team,
  Tool,
  Vec2,
  ViewMode,
} from "./domain/types";
import {
  addActor,
  createSampleScene,
  createScene,
  duplicateFrame,
  interpolateTimeline,
  removeActor,
  snapshotPositions,
  totalDuration,
  updateActorPosition,
  updateFrameAnnotations,
} from "./domain/scene";
import { api, ApiError } from "./lib/api";
import type { Session } from "./lib/api";
import { loadLocalDraft, readSession, saveLocalDraft } from "./lib/drafts";
import { BoardEditor } from "./components/BoardEditor";
const Scene3D = lazy(() => import("./components/Scene3D"));
import SourceReview from "./components/SourceReview";
import type { ReviewStep } from "./components/SourceReview";
import Timeline from "./components/Timeline";
import AuthDialog from "./components/AuthDialog";

function resizePitch(scene: Scene, length: number, width: number): Scene {
  const sx = length / scene.pitch.length,
    sy = width / scene.pitch.width;
  const scale = (p: Vec2) => ({ x: p.x * sx, y: p.y * sy });
  const matrix = scene.calibration.matrix?.map((v, i) =>
    i < 3 ? v * sx : i < 6 ? v * sy : v,
  );
  return {
    ...scene,
    pitch: { length, width },
    calibration: {
      ...scene.calibration,
      matrix,
      landmarks: scene.calibration.landmarks?.map((l) => ({
        ...l,
        pitch: scale(l.pitch),
      })),
    },
    actors: scene.actors.map((a) => ({ ...a, position: scale(a.position) })),
    keyframes: scene.keyframes.map((f) => ({
      ...f,
      positions: Object.fromEntries(
        Object.entries(f.positions).map(([id, p]) => [id, scale(p)]),
      ),
      annotations: f.annotations.map((a) => ({
        ...a,
        start: scale(a.start),
        end: scale(a.end),
      })),
    })),
  };
}
function frameStart(scene: Scene, index: number) {
  return scene.keyframes
    .slice(0, index)
    .reduce((s, f) => s + f.durationMs + f.holdMs, 0);
}
function frameAt(scene: Scene, time: number) {
  let end = 0;
  for (let i = 0; i < scene.keyframes.length; i++) {
    end += scene.keyframes[i].durationMs + scene.keyframes[i].holdMs;
    if (time < end) return i;
  }
  return scene.keyframes.length - 1;
}
const uid = () =>
  globalThis.crypto?.randomUUID?.() ||
  `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function readImage(file: File) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("Choose a PNG, JPEG, or WebP screenshot.");
  if (file.size > 20 * 1024 * 1024)
    throw new Error("Please choose an image smaller than 20 MB.");
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("This image could not be opened."));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("This image could not be opened."));
    image.src = url;
  });
  return { url, width: image.naturalWidth, height: image.naturalHeight };
}
async function cropImage(
  scene: Scene,
  crop: { x: number; y: number; width: number; height: number },
) {
  const source = scene.source!;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Could not crop this image."));
    image.src = source.url;
  });
  const width = Math.round(source.width * crop.width),
    height = Math.round(source.height * crop.height),
    scale = Math.min(1, 2560 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image processing is unavailable in this browser.");
  ctx.drawImage(
    image,
    source.width * crop.x,
    source.height * crop.y,
    width,
    height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Image processing failed."))),
      "image/png",
    ),
  );
  return {
    file: new File([blob], "match-frame.png", { type: "image/png" }),
    url: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
    crop,
  };
}
function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <Flag size={20} strokeWidth={2.3} />
      </span>
      fut<span>vr</span>
      <span className="beta-badge">BETA</span>
    </span>
  );
}

export default function App() {
  const [scene, setScene] = useState<Scene | null>(null),
    [view, setView] = useState<ViewMode>("board"),
    [tool, setTool] = useState<Tool>("select"),
    [color, setColor] = useState("#e9ef9a"),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(
      null,
    );
  const [frameIndex, setFrameIndex] = useState(0),
    [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1),
    [review, setReview] = useState<ReviewStep | null>(null),
    [analysisStage, setAnalysisStage] = useState("Finding players"),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [toast, setToast] = useState("");
  const [session, setSession] = useState<Session | null>(() => readSession()),
    [authOpen, setAuthOpen] = useState(false),
    [panel, setPanel] = useState<"details" | "comments">("details"),
    [moreOpen, setMoreOpen] = useState(false),
    [helpOpen, setHelpOpen] = useState(false),
    [publishOpen, setPublishOpen] = useState(false),
    [includeSource, setIncludeSource] = useState(false),
    [publication, setPublication] = useState<Publication | null>(null),
    [shared, setShared] = useState(false),
    [comments, setComments] = useState<Comment[]>([]),
    [commentText, setCommentText] = useState(""),
    [replyId, setReplyId] = useState<string | null>(null),
    [anchorMode, setAnchorMode] = useState(false),
    [commentAnchor, setCommentAnchor] = useState<CommentAnchor | null>(null),
    [libraryOpen, setLibraryOpen] = useState(false),
    [library, setLibrary] = useState<Scene[]>([]),
    [localRecovered, setLocalRecovered] = useState<Scene | null>(null),
    [savedRevision, setSavedRevision] = useState(0),
    [dirty, setDirty] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null),
    history = useRef<Scene[]>([]),
    historyGroup = useRef({ key: "", time: 0 }),
    pendingAuth = useRef<((next: Session) => void) | null>(null),
    sceneRef = useRef(scene),
    analysisRun = useRef(0);
  sceneRef.current = scene;
  useEffect(() => {
    const refreshed = (event: Event) =>
      setSession((event as CustomEvent<Session>).detail);
    window.addEventListener("futvr-session-refreshed", refreshed);
    return () =>
      window.removeEventListener("futvr-session-refreshed", refreshed);
  }, []);
  const sample = useMemo(() => createSampleScene(), []);
  const readOnly = shared;
  const actor = scene?.actors.find((a) => a.id === selectedId),
    selectedAnnotation = scene?.keyframes[frameIndex]?.annotations.find(
      (a) => a.id === selectedAnnotationId,
    );
  const current = useMemo(
    () =>
      scene
        ? interpolateTimeline(scene, time)
        : { positions: {}, annotations: [] },
    [scene, time],
  );
  const mutate = useCallback(
    (next: Scene, group = "") => {
      if (shared) return;
      const previous = sceneRef.current;
      if (previous) {
        const now = Date.now();
        if (
          !group ||
          historyGroup.current.key !== group ||
          now - historyGroup.current.time > 500
        ) {
          history.current = [...history.current.slice(-39), previous];
        }
        historyGroup.current = { key: group, time: now };
      }
      setScene({ ...next, updatedAt: new Date().toISOString() });
      setDirty(true);
    },
    [shared],
  );
  const resetEditor = (next: Scene) => {
    analysisRun.current++;
    setScene(next);
    setFrameIndex(0);
    setTime(0);
    setPlaying(false);
    setSelectedId(null);
    setSelectedAnnotationId(null);
    setView("board");
    setTool("select");
    setReview(null);
    setShared(false);
    setPublication(null);
    setComments([]);
    setSavedRevision(
      Number(localStorage.getItem(`futvr-server-revision:${next.id}`) || "0"),
    );
    setDirty(true);
    history.current = [];
    setNotice("");
    setLocalRecovered(null);
  };
  const showToast = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4200);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!scene || shared) return;
    const timer = setTimeout(() => {
      saveLocalDraft(scene).catch(() =>
        setNotice(
          "Local storage is full. Save this play to keep your changes.",
        ),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [scene, shared]);
  useEffect(() => {
    if (!scene?.source?.assetId || scene.source.url.startsWith("data:")) return;
    const sceneId = scene.id,
      assetId = scene.source.assetId;
    const refresh = async () => {
      try {
        let url: string | undefined;
        if (shared && publication) {
          url = (await api.publication(publication.id)).scene.source?.url;
        } else if (session) {
          url = (await api.assetUrl(assetId, session)).url;
        }
        if (url)
          setScene((previous) =>
            previous?.id === sceneId && previous.source
              ? { ...previous, source: { ...previous.source, url } }
              : previous,
          );
      } catch {
        /* offline board remains available */
      }
    };
    const timer = window.setInterval(() => void refresh(), 10 * 60 * 1000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [
    scene?.id,
    scene?.source?.assetId,
    shared,
    publication?.id,
    session?.user.id,
  ]);
  useEffect(() => {
    const route = async () => {
      const match = window.location.hash.match(/^#\/p\/([\w-]+)$/);
      if (match) {
        setBusy(true);
        setPlaying(false);
        try {
          const p = await api.publication(match[1]);
          setScene(p.scene);
          setPublication(p);
          setShared(true);
          setReview(null);
          setFrameIndex(0);
          setTime(0);
          setPanel("comments");
          setComments(await api.comments(p.id));
          setNotice("");
        } catch (e) {
          setNotice(
            e instanceof Error
              ? e.message
              : "This shared play could not be opened.",
          );
        } finally {
          setBusy(false);
        }
      }
    };
    void route();
    window.addEventListener("hashchange", route);
    if (!window.location.hash)
      loadLocalDraft()
        .then(setLocalRecovered)
        .catch(() => {});
    return () => window.removeEventListener("hashchange", route);
  }, []);
  useEffect(() => {
    if (scene && playing) setFrameIndex(frameAt(scene, time));
  }, [scene, time, playing]);
  useEffect(() => {
    if (!playing || !scene) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = Math.min(100, now - last);
      last = now;
      setTime((t) => {
        const next = t + delta * speed;
        if (next >= totalDuration(scene)) {
          setPlaying(false);
          return totalDuration(scene);
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, scene]);
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items || []).find((i) =>
        i.type.startsWith("image/"),
      );
      if (item) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          void upload(file);
        }
      }
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,select,dialog"))
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
      if (e.key === "Escape") {
        setTool("select");
        setSelectedId(null);
        setSelectedAnnotationId(null);
        setAnchorMode(false);
        setMoreOpen(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const ensureSession = async () => {
    if (session) return session;
    const next = await api.guest();
    setSession(next);
    localStorage.setItem("futvr-session", JSON.stringify(next));
    return next;
  };
  const requireLogin = (callback: (next: Session) => void) => {
    if (session && !session.user.isAnonymous) {
      callback(session);
      return;
    }
    pendingAuth.current = callback;
    setAuthOpen(true);
  };
  const finishLogin = (next: Session) => {
    setSession(next);
    localStorage.setItem("futvr-session", JSON.stringify(next));
    setAuthOpen(false);
    showToast("Signed in. Your draft is still here.");
    const callback = pendingAuth.current;
    pendingAuth.current = null;
    callback?.(next);
  };
  async function upload(file: File) {
    if (shared) window.history.replaceState(null, "", window.location.pathname);
    try {
      const source = await readImage(file);
      resetEditor(
        createScene({
          title: file.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " "),
          source: {
            type: "image",
            ...source,
            crop: { x: 0, y: 0, width: 1, height: 1 },
          },
        }),
      );
      setView("source");
      setReview("crop");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Image upload failed.");
    }
  }
  async function analyze(crop: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) {
    if (!scene) return;
    const run = ++analysisRun.current;
    setReview("analysis");
    setAnalysisStage("Finding players");
    setNotice("");
    setBusy(true);
    let cropped: Awaited<ReturnType<typeof cropImage>> | undefined;
    try {
      cropped = await cropImage(scene, crop);
      const next: Scene = {
        ...scene,
        source: { type: "image" as const, ...cropped },
      };
      delete (next.source as { file?: File }).file;
      setScene(next);
      const auth = await ensureSession();
      let job = await api.analyze(cropped.file, auth);
      if (job.asset) {
        next.source = { ...next.source!, assetId: job.asset.id };
        setScene({ ...next });
      }
      for (
        let i = 0;
        i < 180 && job.status !== "completed" && job.status !== "failed";
        i++
      ) {
        if (run !== analysisRun.current) return;
        setAnalysisStage(job.stage || "Finding players");
        await delay(750);
        job = await api.analysis(job.id, auth);
      }
      if (run !== analysisRun.current) return;
      if (job.status === "failed")
        throw new Error(
          job.error || "Analysis failed. Continue with manual reconstruction.",
        );
      if (job.status !== "completed")
        throw new Error(
          "Analysis is taking longer than expected. Your screenshot is safe; try again or continue manually.",
        );
      const detections = job.result?.detections || [];
      const actors: Actor[] = detections.map((d, i) => ({
        id: d.id,
        role: d.role,
        team: d.team,
        position: {
          x: d.imagePoint.x * next.pitch.length,
          y: d.imagePoint.y * next.pitch.width,
        },
        imagePoint: d.imagePoint,
        provenance: "automatic",
        needsReview: d.needsReview,
        label:
          d.role === "ball"
            ? undefined
            : `${d.team === "a" ? "A" : d.team === "b" ? "B" : "P"}${detections.slice(0, i + 1).filter((other) => other.team === d.team && other.role !== "ball").length}`,
      }));
      const positions = Object.fromEntries(
        actors.map((a) => [a.id, a.position]),
      );
      setScene({
        ...next,
        actors,
        calibration: job.result?.calibration || { status: "unavailable" },
        keyframes: [{ ...next.keyframes[0], positions }],
        source: {
          ...next.source!,
          assetId: job.asset?.id || next.source?.assetId,
        },
      });
      setNotice(
        job.result?.notice ||
          "Positions are estimated from your screenshot. Check the pitch alignment first.",
      );
      setReview("alignment");
      setDirty(true);
    } catch (e) {
      if (run !== analysisRun.current) return;
      setNotice(
        e instanceof Error
          ? e.message
          : "Analysis failed. You can continue manually.",
      );
      setReview("alignment");
    } finally {
      if (run === analysisRun.current) setBusy(false);
    }
  }
  function chooseSample() {
    window.history.replaceState(null, "", window.location.pathname);
    resetEditor(createSampleScene());
    showToast("Sample play loaded. Positions are a curated example.");
  }
  function changeView(next: ViewMode) {
    if (next === "source") {
      setPlaying(false);
      setFrameIndex(0);
      setTime(0);
    }
    setView(next);
    setTool("select");
    setMoreOpen(false);
    setAnchorMode(false);
    setSelectedAnnotationId(null);
  }
  function moveActor(id: string, position: Vec2) {
    if (!scene) return;
    setPlaying(false);
    setTime(frameStart(scene, frameIndex));
    mutate(updateActorPosition(scene, frameIndex, id, position), `move:${id}`);
  }
  function createAnnotation(annotation: Annotation) {
    if (!scene) return;
    if (scene.keyframes[frameIndex].annotations.length >= 200) {
      showToast("This step supports up to 200 annotations.");
      return;
    }
    setPlaying(false);
    setTime(frameStart(scene, frameIndex));
    mutate(
      updateFrameAnnotations(scene, frameIndex, [
        ...scene.keyframes[frameIndex].annotations,
        annotation,
      ]),
    );
    setSelectedAnnotationId(annotation.id);
  }
  function updateAnnotation(annotation: Annotation) {
    if (!scene) return;
    mutate(
      updateFrameAnnotations(
        scene,
        frameIndex,
        scene.keyframes[frameIndex].annotations.map((a) =>
          a.id === annotation.id ? annotation : a,
        ),
      ),
      `annotation:${annotation.id}`,
    );
  }
  function addPlayer(position: Vec2, imagePoint?: Vec2) {
    if (!scene) return;
    if (scene.actors.length >= 60) {
      showToast("This play supports up to 60 actors.");
      return;
    }
    const count = scene.actors.filter((a) => a.team === "a").length + 1;
    const player: Actor = {
      id: uid(),
      role: "player",
      team: "a",
      position,
      imagePoint,
      name: "",
      label: `A${count}`,
      provenance: "manual",
    };
    mutate(addActor(scene, player));
    setSelectedId(player.id);
    setTool("select");
    showToast("Player added. Set a team and optional tag.");
  }
  function addBall() {
    if (!scene) return;
    if (scene.actors.some((a) => a.role === "ball")) {
      setSelectedId(scene.actors.find((a) => a.role === "ball")!.id);
      return;
    }
    const ball: Actor = {
      id: uid(),
      role: "ball",
      team: "unknown",
      position: { x: scene.pitch.length / 2, y: scene.pitch.width / 2 },
      provenance: "manual",
    };
    mutate(addActor(scene, ball));
    setSelectedId(ball.id);
  }
  function updateActor(changes: Partial<Actor>) {
    if (!scene || !actor) return;
    mutate(
      {
        ...scene,
        actors: scene.actors.map((a) =>
          a.id === actor.id ? { ...a, ...changes, needsReview: false } : a,
        ),
      },
      `tag:${actor.id}`,
    );
  }
  function undo() {
    const prev = history.current.pop();
    if (prev) {
      setScene(prev);
      const index = Math.min(frameIndex, prev.keyframes.length - 1);
      setFrameIndex(index);
      setPlaying(false);
      setTime(frameStart(prev, index));
      setDirty(true);
      historyGroup.current = { key: "", time: 0 };
      showToast("Last edit undone.");
    }
  }
  async function performSave(auth: Session) {
    const currentScene = sceneRef.current;
    if (!currentScene) return null;
    setBusy(true);
    try {
      let draft = currentScene;
      if (
        draft.source &&
        !draft.source.assetId &&
        draft.source.url.startsWith("data:")
      ) {
        const raster = await cropImage(draft, {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        });
        const job = await api.analyze(raster.file, auth);
        if (job.asset)
          draft = {
            ...draft,
            source: {
              ...draft.source,
              assetId: job.asset.id,
              url: job.asset.url,
              width: raster.width,
              height: raster.height,
            },
          };
      }
      if (draft.source?.assetId && draft.source.url.startsWith("data:")) {
        const fresh = await api.assetUrl(draft.source.assetId, auth);
        draft = { ...draft, source: { ...draft.source, url: fresh.url } };
      }
      const saved = await api.save(draft, savedRevision, auth);
      setScene(saved);
      setSavedRevision(saved.revision);
      localStorage.setItem(
        `futvr-server-revision:${saved.id}`,
        String(saved.revision),
      );
      setDirty(false);
      showToast("Play saved to your workspace.");
      return saved;
    } catch (e) {
      showToast(
        e instanceof ApiError && e.status === 409
          ? "This play changed on another device. Reopen it from Your plays before saving again."
          : e instanceof Error
            ? e.message
            : "Could not save this play.",
      );
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function performPublish(auth: Session) {
    const saved = await performSave(auth);
    if (!saved) return;
    setBusy(true);
    try {
      const published = await api.publish(saved.id, includeSource, auth);
      setPublication(published);
      setComments(await api.comments(published.id));
      setPublishOpen(true);
      showToast("A fixed revision is ready to share.");
    } catch (e) {
      showToast(
        e instanceof Error ? e.message : "Could not publish this play.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function openLibrary() {
    requireLogin(async (auth) => {
      setLibraryOpen(true);
      setBusy(true);
      try {
        setLibrary(await api.drafts(auth));
      } catch (e) {
        showToast(
          e instanceof Error ? e.message : "Could not load your plays.",
        );
      } finally {
        setBusy(false);
      }
    });
  }
  async function openDraft(draft: Scene) {
    setLibraryOpen(false);
    window.history.replaceState(null, "", window.location.pathname);
    let next = draft;
    if (draft.source?.assetId && session) {
      try {
        const result = await api.assetUrl(draft.source.assetId, session);
        next = { ...draft, source: { ...draft.source, url: result.url } };
      } catch {
        /* source may have been removed; board remains editable */
      }
    }
    resetEditor(next);
    setSavedRevision(next.revision);
    localStorage.setItem(
      `futvr-server-revision:${next.id}`,
      String(next.revision),
    );
    setDirty(false);
  }
  async function postComment(auth: Session) {
    if (!publication || !commentText.trim()) return;
    setBusy(true);
    try {
      const reply = replyId ? comments.find((c) => c.id === replyId) : null;
      const anchor = reply?.anchor ||
        commentAnchor || {
          timeMs: time,
          ...(selectedId ? { actorId: selectedId } : {}),
        };
      const result = await api.comment(
        publication.id,
        commentText.trim(),
        anchor,
        auth,
        replyId || undefined,
      );
      setComments([...comments, result]);
      setCommentText("");
      setReplyId(null);
      setCommentAnchor(null);
      setAnchorMode(false);
      showToast("Comment added to this published revision.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not add the comment.");
    } finally {
      setBusy(false);
    }
  }
  const shareUrl = publication
    ? `${window.location.origin}${window.location.pathname}#/p/${publication.id}`
    : "";
  const chooseTool = (next: Tool) => {
    setPlaying(false);
    if (scene) setTime(frameStart(scene, frameIndex));
    setTool(next);
  };
  const selectFrame = (index: number) => {
    if (!scene) return;
    setFrameIndex(index);
    setTime(frameStart(scene, index));
    setPlaying(false);
    setSelectedAnnotationId(null);
    setTool("select");
  };
  const selectComment = (id: string) => {
    const c = comments.find((c) => c.id === id);
    if (!c || !scene) return;
    setPlaying(false);
    setTime(c.anchor.timeMs);
    setFrameIndex(frameAt(scene, c.anchor.timeMs));
    setSelectedId(c.anchor.actorId || null);
    setPanel("comments");
    document
      .getElementById(`comment-${id}`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const boardAnchors = comments
    .filter((c) => !c.parentId)
    .flatMap((c) => {
      const point =
        c.anchor.point ||
        (c.anchor.actorId ? current.positions[c.anchor.actorId] : undefined);
      return point ? [{ id: c.id, point }] : [];
    });

  return (
    <div className="app">
      <header className="app-header">
        <button
          className="brand-button"
          onClick={() => {
            if (scene) {
              setHelpOpen(true);
            } else window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          aria-label="FutVR"
        >
          <Brand />
        </button>
        <nav className="header-nav" aria-label="Main navigation">
          <span className="nav-active">Tactical workspace</span>
          <button onClick={openLibrary}>
            <FolderOpen size={16} /> Your plays
          </button>
        </nav>
        <div className="header-actions">
          <button
            className="icon-btn help-button"
            onClick={() => setHelpOpen(true)}
            aria-label="How FutVR works"
          >
            <CircleHelp size={19} />
          </button>
          <button className="account-button" onClick={() => setAuthOpen(true)}>
            {session && !session.user.isAnonymous ? (
              <>
                <span className="avatar">
                  {session.user.email?.[0]?.toUpperCase() || "F"}
                </span>
                <span className="account-label">
                  {session.user.email?.split("@")[0]}
                </span>
              </>
            ) : (
              <>
                Sign in <ArrowUpRight size={15} />
              </>
            )}
          </button>
        </div>
      </header>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        aria-label="Upload match screenshot"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = "";
        }}
      />
      {!scene ? (
        <main className="home">
          <div className="home-topline">
            <span>
              <span className="live-dot" /> A NEW PERSPECTIVE ON THE GAME
            </span>
            <span>Built for the beautiful game.</span>
          </div>
          <div className="home-heading">
            <h1>
              See the play
              <br />
              <em>differently.</em>
            </h1>
            <p>
              One screenshot. Every angle.
              <br />
              Bring a football moment onto the pitch,
              <br />
              and show others what you see.
            </p>
          </div>
          <div className="home-grid">
            <section
              className="upload-card"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if (file) void upload(file);
              }}
            >
              <div className="upload-icon">
                <ImagePlus size={30} strokeWidth={1.5} />
              </div>
              <span className="eyebrow">START WITH A MOMENT</span>
              <h2>Drop your screenshot here.</h2>
              <p>
                Upload a match frame, or paste one from your clipboard. We’ll
                help you turn it into a tactical scene.
              </p>
              <button
                className="btn primary"
                onClick={() => fileInput.current?.click()}
              >
                <Upload size={17} /> Upload screenshot
              </button>
              <span className="upload-formats">
                PNG, JPG, WEBP · UP TO 20 MB
              </span>
              <div className="upload-divider">
                <span>or explore first</span>
              </div>
              <button className="sample-button" onClick={chooseSample}>
                <span className="sample-icon">
                  <Layers size={20} />
                </span>
                <span>
                  <strong>Try a sample play</strong>
                  <small>No upload. No sign-up.</small>
                </span>
                <ArrowRight size={19} />
              </button>
              {localRecovered && (
                <button
                  className="recover-button"
                  onClick={async () => {
                    let next = localRecovered;
                    if (next.source?.assetId && session) {
                      try {
                        const fresh = await api.assetUrl(
                          next.source.assetId,
                          session,
                        );
                        next = {
                          ...next,
                          source: { ...next.source, url: fresh.url },
                        };
                      } catch {
                        showToast(
                          "Source unavailable offline. Your board is preserved.",
                        );
                      }
                    }
                    resetEditor(next);
                  }}
                >
                  <RotateIcon /> Resume your local draft: {localRecovered.title}
                </button>
              )}
            </section>
            <section
              className="home-preview"
              aria-label="Example reconstructed tactical scene"
            >
              <div className="preview-caption">
                <span className="pill">THE SPACE BEHIND THE PRESS</span>
                <span className="preview-perspective">
                  <Cuboid size={15} /> A different point of view
                </span>
              </div>
              <img
                src={sample.source?.url}
                alt="Sample football play reconstructed as a tactical pitch"
              />
              <div className="preview-floating">
                <span className="floating-icon">
                  <Crosshair size={21} />
                </span>
                <span>
                  <strong>Find the space.</strong>
                  <small>See the passing lane from any angle.</small>
                </span>
              </div>
              <div className="preview-bottom">
                <span>
                  <span className="live-dot" /> SAMPLE RECONSTRUCTION
                </span>
                <button onClick={chooseSample}>
                  Step onto the pitch <ArrowUpRight size={16} />
                </button>
              </div>
            </section>
          </div>
          <div className="home-features">
            <div>
              <ScanLine size={22} />
              <span>
                <strong>Reconstruct the moment</strong>
                <small>Check and correct visible positions.</small>
              </span>
            </div>
            <div>
              <ArrowUpRight size={22} />
              <span>
                <strong>Make your point</strong>
                <small>Tags, arrows, zones, and movement.</small>
              </span>
            </div>
            <div>
              <Headset size={22} />
              <span>
                <strong>Step into the play</strong>
                <small>Explore in 3D or on a VR headset.</small>
              </span>
            </div>
            <div>
              <MessageCircle size={22} />
              <span>
                <strong>Start a conversation</strong>
                <small>Share a scene. Discuss the details.</small>
              </span>
            </div>
          </div>
          <footer className="home-footer">
            <span>
              A tactical reconstruction, with room for your interpretation.
            </span>
            <span>PHONE · DESKTOP · META QUEST</span>
          </footer>
          {notice && (
            <div className="notice" role="alert">
              {notice}
            </div>
          )}
        </main>
      ) : (
        <main className="workspace">
          <div className="workspace-topbar">
            <div className="scene-title">
              <span className="scene-title-icon">
                <Flag size={20} />
              </span>
              <div>
                {readOnly ? (
                  <h1>{scene.title}</h1>
                ) : (
                  <input
                    aria-label="Play title"
                    value={scene.title}
                    onChange={(e) =>
                      mutate({ ...scene, title: e.target.value }, "title")
                    }
                  />
                )}
                <span>
                  {readOnly
                    ? "Published revision"
                    : scene.actors.some((a) => a.provenance === "sample")
                      ? "Sample play"
                      : scene.calibration.status === "manual"
                        ? "Approximate manual board"
                        : "Reconstructed tactical view"}
                  <i />{" "}
                  {readOnly
                    ? "View & discuss"
                    : dirty
                      ? "Draft saved on this device"
                      : "Saved to your workspace"}
                </span>
              </div>
            </div>
            <div className="scene-actions">
              {!readOnly && (
                <button
                  className="btn ghost new-play"
                  onClick={() => fileInput.current?.click()}
                >
                  <Plus size={16} /> New play
                </button>
              )}
              {!readOnly && (
                <button
                  className="btn secondary"
                  aria-label="Save"
                  onClick={() => requireLogin((auth) => void performSave(auth))}
                  disabled={busy}
                >
                  <ArrowDownToLine size={16} />
                  <span>Save</span>
                </button>
              )}
              <button
                className="btn primary"
                aria-label="Share play"
                onClick={() => {
                  if (readOnly) {
                    setPublishOpen(true);
                  } else {
                    setPublishOpen(true);
                  }
                }}
                disabled={busy || !!review}
              >
                <Share2 size={16} />
                <span>Share play</span>
              </button>
            </div>
          </div>
          <div className="workspace-content">
            <div className="workspace-main">
              <div className="canvas-topbar">
                <div
                  className="view-tabs"
                  role="tablist"
                  aria-label="Play view"
                >
                  <button
                    role="tab"
                    aria-selected={view === "source"}
                    disabled={!scene.source}
                    onClick={() => changeView("source")}
                  >
                    <FileImage size={16} />
                    <span>Source</span>
                  </button>
                  <button
                    role="tab"
                    aria-selected={view === "board"}
                    disabled={
                      review === "crop" ||
                      review === "analysis" ||
                      review === "alignment"
                    }
                    onClick={() => changeView("board")}
                  >
                    <Layers size={16} />
                    <span>Board</span>
                  </button>
                  <button
                    role="tab"
                    aria-selected={view === "3d"}
                    disabled={!!review}
                    onClick={() => changeView("3d")}
                  >
                    <Cuboid size={16} />
                    <span>3D / VR</span>
                  </button>
                </div>
                <span className="pitch-size">
                  <span className="live-dot" />
                  {scene.pitch.length} × {scene.pitch.width} m{" "}
                  <span>· assumed pitch</span>
                </span>
              </div>
              {notice && (
                <div className="notice" role="status">
                  <ShieldCheck size={17} />
                  <span>{notice}</span>
                  <button
                    className="icon-btn"
                    aria-label="Dismiss notice"
                    onClick={() => setNotice("")}
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
              <div className={`canvas-area ${review ? "review-area" : ""}`}>
                {view === "source" && scene.source ? (
                  <SourceReview
                    scene={scene}
                    step={review || "players"}
                    stage={analysisStage}
                    selectedId={selectedId}
                    readOnly={readOnly}
                    onStartAdd={() => chooseTool("add")}
                    adding={tool === "add"}
                    onAdd={(imagePoint, position) =>
                      addPlayer(position, imagePoint)
                    }
                    onSelect={(id) => {
                      setSelectedId(id);
                      setSelectedAnnotationId(null);
                      setPanel("details");
                    }}
                    onChange={(next) => mutate(next, "source")}
                    onCrop={(crop) => void analyze(crop)}
                    onContinue={() => {
                      if (review === "alignment") {
                        mutate({
                          ...scene,
                          calibration: {
                            ...scene.calibration,
                            status: "confirmed",
                          },
                        });
                        setReview("players");
                      } else {
                        setReview(null);
                        changeView("board");
                      }
                    }}
                    onManual={() => {
                      mutate({ ...scene, calibration: { status: "manual" } });
                      setReview(null);
                      changeView("board");
                      setTool("add");
                      setNotice(
                        "Approximate board: positions and distances are illustrative. Place players using the source as a reference.",
                      );
                    }}
                  />
                ) : view === "3d" ? (
                  <Suspense
                    fallback={
                      <div className="three-loading">
                        <Cuboid size={28} />
                        <p>Preparing the 3D pitch…</p>
                      </div>
                    }
                  >
                    <Scene3D
                      scene={scene}
                      positions={current.positions}
                      annotations={current.annotations}
                      selectedId={selectedId}
                      readOnly={readOnly}
                      isPlaying={playing}
                      onSelect={(id) => {
                        setSelectedId(id);
                        setSelectedAnnotationId(null);
                        if (id) setPanel("details");
                      }}
                      onMove={moveActor}
                      onAnnotation={createAnnotation}
                      onUndo={undo}
                      onPlayPause={() => setPlaying((p) => !p)}
                      onError={showToast}
                    />
                  </Suspense>
                ) : (
                  <>
                    <div className="board-status">
                      <span className="pill dark">
                        {anchorMode
                          ? "PLACE A COMMENT PIN"
                          : tool === "select"
                            ? "TACTICAL VIEW"
                            : `${tool.toUpperCase()} TOOL`}
                      </span>
                      <span className="board-instruction">
                        {readOnly
                          ? "Explore the play. Select a player to see their tag."
                          : tool === "select"
                            ? "Select a player · drag to move"
                            : tool === "add"
                              ? "Tap the pitch to add a player"
                              : tool === "label"
                                ? "Tap the pitch to place a label"
                                : "Tap a start point, then an end point"}
                      </span>
                    </div>
                    <BoardEditor
                      key={`${view}-${tool}-${frameIndex}-${anchorMode}`}
                      scene={scene}
                      positions={current.positions}
                      annotations={current.annotations}
                      selectedId={selectedId}
                      selectedAnnotationId={selectedAnnotationId}
                      tool={tool}
                      color={color}
                      readOnly={readOnly}
                      anchorMode={anchorMode}
                      commentAnchors={boardAnchors}
                      onSelect={(id) => {
                        setSelectedId(id);
                        if (id) {
                          setSelectedAnnotationId(null);
                          setPanel("details");
                          if (!readOnly) {
                            setPlaying(false);
                            setTime(frameStart(scene, frameIndex));
                          }
                        }
                      }}
                      onSelectAnnotation={(id) => {
                        setSelectedAnnotationId(id);
                        if (id) {
                          setSelectedId(null);
                          setPanel("details");
                          if (!readOnly) {
                            setPlaying(false);
                            setTime(frameStart(scene, frameIndex));
                          }
                        }
                      }}
                      onMove={moveActor}
                      onAnnotation={createAnnotation}
                      onUpdateAnnotation={updateAnnotation}
                      onAdd={addPlayer}
                      onAnchor={(point) => {
                        setPlaying(false);
                        setCommentAnchor({ point, timeMs: time });
                        setAnchorMode(false);
                        setPanel("comments");
                      }}
                      onComment={selectComment}
                    />
                  </>
                )}
              </div>
              {!review && view === "board" && !readOnly && (
                <div className="tool-dock" aria-label="Drawing tools">
                  <button
                    className={tool === "select" ? "active" : ""}
                    onClick={() => chooseTool("select")}
                    aria-label="Select tool"
                  >
                    <MousePointer2 size={18} />
                    <span>Select</span>
                  </button>
                  <button
                    className={tool === "arrow" ? "active" : ""}
                    onClick={() => chooseTool("arrow")}
                    aria-label="Arrow tool"
                  >
                    <ArrowUpRight size={19} />
                    <span>Arrow</span>
                  </button>
                  <button
                    className={tool === "label" ? "active" : ""}
                    onClick={() => chooseTool("label")}
                    aria-label="Label tool"
                  >
                    <Type size={18} />
                    <span>Label</span>
                  </button>
                  <div className="more-tools">
                    <button
                      className={moreOpen ? "active" : ""}
                      onClick={() => setMoreOpen(!moreOpen)}
                      aria-expanded={moreOpen}
                      aria-label="More drawing tools"
                    >
                      <Ellipsis size={20} />
                      <span>More</span>
                    </button>
                    {moreOpen && (
                      <div className="tools-popover">
                        {(
                          [
                            {
                              id: "line",
                              name: "Line",
                              icon: <ScanLine size={17} />,
                            },
                            {
                              id: "circle",
                              name: "Circle",
                              icon: <Circle size={17} />,
                            },
                            {
                              id: "zone",
                              name: "Zone",
                              icon: <Square size={17} />,
                            },
                            {
                              id: "add",
                              name: "Add player",
                              icon: <Users size={17} />,
                            },
                          ] as {
                            id: Tool;
                            name: string;
                            icon: React.ReactNode;
                          }[]
                        ).map((t) => (
                          <button
                            key={t.id}
                            onClick={() => {
                              chooseTool(t.id);
                              setMoreOpen(false);
                            }}
                          >
                            {t.icon}
                            {t.name}
                          </button>
                        ))}
                        <button
                          onClick={() => {
                            addBall();
                            setMoreOpen(false);
                          }}
                        >
                          <Circle size={17} />
                          Add ball
                        </button>
                      </div>
                    )}
                  </div>
                  <span className="dock-divider" />
                  <label className="tool-color" title="Annotation color">
                    <span className="sr-only">Annotation color</span>
                    <input
                      type="color"
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                    />
                  </label>
                  <button
                    onClick={undo}
                    aria-label="Undo last edit"
                    disabled={!history.current.length}
                  >
                    <Undo2 size={18} />
                    <span>Undo</span>
                  </button>
                </div>
              )}
              {!review && (
                <Timeline
                  scene={scene}
                  index={frameIndex}
                  time={time}
                  playing={playing}
                  speed={speed}
                  readOnly={readOnly}
                  onSelect={selectFrame}
                  onScrub={(t) => {
                    setTime(t);
                    setPlaying(false);
                    setFrameIndex(frameAt(scene, t));
                    setTool("select");
                    setAnchorMode(false);
                  }}
                  onPlay={() => {
                    if (time >= totalDuration(scene)) setTime(0);
                    setPlaying(!playing);
                    setTool("select");
                  }}
                  onReset={() => selectFrame(0)}
                  onSpeed={setSpeed}
                  onDuplicate={() => {
                    if (scene.keyframes.length >= 30) {
                      showToast("This play supports up to 30 steps.");
                      return;
                    }
                    const next = duplicateFrame(scene, frameIndex);
                    mutate(next);
                    selectFrame(frameIndex + 1);
                    setTime(frameStart(next, frameIndex + 1));
                    showToast(
                      "Step duplicated. Move players to illustrate what happens next.",
                    );
                  }}
                  onDuration={(durationMs, holdMs) =>
                    mutate(
                      {
                        ...scene,
                        keyframes: scene.keyframes.map((f, i) =>
                          i === frameIndex ? { ...f, durationMs, holdMs } : f,
                        ),
                      },
                      `timing:${frameIndex}`,
                    )
                  }
                  onDeleteFrame={() => {
                    const next = {
                      ...scene,
                      keyframes: scene.keyframes.filter(
                        (_, i) => i !== frameIndex,
                      ),
                    };
                    mutate(next);
                    const index = Math.max(0, frameIndex - 1);
                    setFrameIndex(index);
                    setTime(frameStart(next, index));
                    setPlaying(false);
                  }}
                />
              )}
            </div>
            <aside className="inspector">
              <div className="inspector-tabs">
                <button
                  className={panel === "details" ? "active" : ""}
                  onClick={() => setPanel("details")}
                >
                  Play details
                </button>
                <button
                  className={panel === "comments" ? "active" : ""}
                  onClick={() => setPanel("comments")}
                >
                  Discussion <span>{comments.length}</span>
                </button>
              </div>
              {panel === "details" ? (
                <div className="inspector-content">
                  {actor ? (
                    <>
                      <div className="section-heading">
                        <span className="eyebrow">
                          SELECTED {actor.role.toUpperCase()}
                        </span>
                        <button
                          className="icon-btn"
                          onClick={() => setSelectedId(null)}
                          aria-label="Deselect player"
                        >
                          <X size={16} />
                        </button>
                      </div>
                      <div className="player-summary">
                        <span className={`player-badge team-${actor.team}`}>
                          {actor.role === "ball"
                            ? "●"
                            : actor.number || actor.label || "?"}
                        </span>
                        <div>
                          <h2>
                            {actor.name ||
                              actor.label ||
                              (actor.role === "ball"
                                ? "The ball"
                                : `Player ${actor.number || ""}`)}
                          </h2>
                          <span>
                            {actor.team === "a"
                              ? "Team A"
                              : actor.team === "b"
                                ? "Team B"
                                : actor.team === "official"
                                  ? "Official"
                                  : "Unassigned"}{" "}
                            ·{" "}
                            {actor.provenance === "automatic"
                              ? "Estimated"
                              : actor.provenance === "sample"
                                ? "Sample position"
                                : "Manually placed"}
                          </span>
                        </div>
                      </div>
                      {!readOnly && (
                        <div className="player-form">
                          {actor.role !== "ball" && (
                            <>
                              <label
                                className="field-label"
                                htmlFor="player-name"
                              >
                                Player name
                              </label>
                              <input
                                id="player-name"
                                value={actor.name || ""}
                                placeholder="Add a name"
                                onChange={(e) =>
                                  updateActor({ name: e.target.value })
                                }
                              />
                              <div className="form-row">
                                <div>
                                  <label
                                    className="field-label"
                                    htmlFor="player-number"
                                  >
                                    Number
                                  </label>
                                  <input
                                    id="player-number"
                                    value={actor.number || ""}
                                    maxLength={4}
                                    placeholder="—"
                                    onChange={(e) =>
                                      updateActor({ number: e.target.value })
                                    }
                                  />
                                </div>
                                <div>
                                  <label
                                    className="field-label"
                                    htmlFor="player-team"
                                  >
                                    Team
                                  </label>
                                  <select
                                    id="player-team"
                                    value={actor.team}
                                    onChange={(e) =>
                                      updateActor({
                                        team: e.target.value as Team,
                                        role:
                                          e.target.value === "official"
                                            ? "official"
                                            : "player",
                                      })
                                    }
                                  >
                                    <option value="a">Team A</option>
                                    <option value="b">Team B</option>
                                    <option value="unknown">Unknown</option>
                                    <option value="official">Official</option>
                                  </select>
                                </div>
                              </div>
                            </>
                          )}
                          <div className="form-row">
                            <div>
                              <label className="field-label" htmlFor="player-x">
                                Pitch X (m)
                              </label>
                              <input
                                id="player-x"
                                type="number"
                                step=".1"
                                min="0"
                                max={scene.pitch.length}
                                value={Number(
                                  (current.positions[actor.id]?.x || 0).toFixed(
                                    1,
                                  ),
                                )}
                                onChange={(e) =>
                                  moveActor(actor.id, {
                                    x: Math.max(
                                      0,
                                      Math.min(
                                        scene.pitch.length,
                                        Number(e.target.value),
                                      ),
                                    ),
                                    y: current.positions[actor.id]?.y || 0,
                                  })
                                }
                              />
                            </div>
                            <div>
                              <label className="field-label" htmlFor="player-y">
                                Pitch Y (m)
                              </label>
                              <input
                                id="player-y"
                                type="number"
                                step=".1"
                                min="0"
                                max={scene.pitch.width}
                                value={Number(
                                  (current.positions[actor.id]?.y || 0).toFixed(
                                    1,
                                  ),
                                )}
                                onChange={(e) =>
                                  moveActor(actor.id, {
                                    x: current.positions[actor.id]?.x || 0,
                                    y: Math.max(
                                      0,
                                      Math.min(
                                        scene.pitch.width,
                                        Number(e.target.value),
                                      ),
                                    ),
                                  })
                                }
                              />
                            </div>
                          </div>
                          <button
                            className="btn secondary full"
                            onClick={() => {
                              updateActor({ needsReview: false });
                              showToast("Position checked.");
                            }}
                          >
                            <Check size={15} /> Mark as checked
                          </button>
                          <button
                            className="text-link danger"
                            onClick={() => {
                              mutate(removeActor(scene, actor.id));
                              setSelectedId(null);
                            }}
                          >
                            Remove {actor.role === "ball" ? "ball" : "player"}
                          </button>
                        </div>
                      )}
                      <button
                        className="btn secondary full"
                        onClick={() => changeView("3d")}
                      >
                        <Eye size={17} /> Explore this player in 3D
                      </button>
                    </>
                  ) : selectedAnnotation ? (
                    <>
                      <span className="eyebrow">SELECTED ANNOTATION</span>
                      <h2>
                        {selectedAnnotation.kind === "label"
                          ? "Text label"
                          : `${selectedAnnotation.kind[0].toUpperCase()}${selectedAnnotation.kind.slice(1)}`}
                      </h2>
                      {!readOnly && (
                        <>
                          {selectedAnnotation.kind === "label" && (
                            <>
                              <label
                                className="field-label"
                                htmlFor="annotation-text"
                              >
                                Label
                              </label>
                              <input
                                id="annotation-text"
                                value={selectedAnnotation.text || ""}
                                placeholder="Add a note"
                                onChange={(e) =>
                                  updateAnnotation({
                                    ...selectedAnnotation,
                                    text: e.target.value,
                                  })
                                }
                              />
                            </>
                          )}
                          <label
                            className="field-label"
                            htmlFor="annotation-color"
                          >
                            Color
                          </label>
                          <input
                            id="annotation-color"
                            type="color"
                            value={selectedAnnotation.color}
                            onChange={(e) =>
                              updateAnnotation({
                                ...selectedAnnotation,
                                color: e.target.value,
                              })
                            }
                          />
                          <p className="small">
                            Drag the end handles on the board to reshape this
                            annotation.
                          </p>
                          <button
                            className="text-link danger"
                            onClick={() => {
                              mutate(
                                updateFrameAnnotations(
                                  scene,
                                  frameIndex,
                                  scene.keyframes[
                                    frameIndex
                                  ].annotations.filter(
                                    (a) => a.id !== selectedAnnotation.id,
                                  ),
                                ),
                              );
                              setSelectedAnnotationId(null);
                            }}
                          >
                            Remove annotation
                          </button>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="eyebrow">THE MOMENT</span>
                      <h2>Every position tells a story.</h2>
                      <p className="inspector-intro">
                        Select a player to add a tag or explore their
                        perspective. Use the board to show the space between
                        them.
                      </p>
                      <div className="team-summary">
                        <div>
                          <span className="team-dot a" />
                          <span>Team A</span>
                          <strong>
                            {scene.actors.filter((a) => a.team === "a").length}
                          </strong>
                        </div>
                        <div>
                          <span className="team-dot b" />
                          <span>Team B</span>
                          <strong>
                            {scene.actors.filter((a) => a.team === "b").length}
                          </strong>
                        </div>
                        <div>
                          <span className="team-dot unknown" />
                          <span>Others</span>
                          <strong>
                            {
                              scene.actors.filter(
                                (a) =>
                                  a.role !== "ball" &&
                                  a.team !== "a" &&
                                  a.team !== "b",
                              ).length
                            }
                          </strong>
                        </div>
                      </div>
                      <div className="player-list-heading">
                        <span>ON THE PITCH</span>
                        {!readOnly && (
                          <button
                            className="text-link"
                            onClick={() => {
                              if (view === "source") {
                                chooseTool("add");
                              } else {
                                changeView("board");
                                chooseTool("add");
                              }
                            }}
                          >
                            + Add player
                          </button>
                        )}
                      </div>
                      <div className="player-list">
                        {scene.actors.map((a) => (
                          <button
                            key={a.id}
                            onClick={() => {
                              setSelectedId(a.id);
                              setSelectedAnnotationId(null);
                            }}
                          >
                            <span className={`mini-player team-${a.team}`}>
                              {a.role === "ball"
                                ? "●"
                                : a.number || a.label || "?"}
                            </span>
                            <span>
                              {a.name ||
                                a.label ||
                                (a.role === "ball"
                                  ? "Ball"
                                  : `Player ${a.number || ""}`)}
                            </span>
                            {a.needsReview ? (
                              <span
                                className="review-dot"
                                title="Needs review"
                              />
                            ) : (
                              <ChevronDown
                                size={13}
                                className="player-chevron"
                              />
                            )}
                          </button>
                        ))}
                        {!scene.actors.length && (
                          <div className="empty-players">
                            <Users size={24} />
                            <p>
                              No players yet. Add the visible players to create
                              your board.
                            </p>
                            <button
                              className="btn secondary"
                              onClick={() => {
                                if (
                                  view === "source" &&
                                  scene.calibration.matrix
                                ) {
                                  chooseTool("add");
                                } else {
                                  setReview(null);
                                  changeView("board");
                                  chooseTool("add");
                                }
                              }}
                            >
                              Add a player
                            </button>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                  <div className="inspector-tip">
                    <Sparkles size={17} />
                    <p>
                      One frame is a moment.
                      <br />
                      Your animation is an interpretation.
                    </p>
                  </div>
                  {!readOnly && (
                    <details className="pitch-settings">
                      <summary>Pitch settings</summary>
                      <div className="form-row">
                        <label>
                          Length (m)
                          <input
                            type="number"
                            min="90"
                            max="120"
                            value={scene.pitch.length}
                            onChange={(e) => {
                              const length = Number(e.target.value);
                              if (length >= 90 && length <= 120)
                                mutate(
                                  resizePitch(scene, length, scene.pitch.width),
                                  "pitch",
                                );
                            }}
                          />
                        </label>
                        <label>
                          Width (m)
                          <input
                            type="number"
                            min="45"
                            max="90"
                            value={scene.pitch.width}
                            onChange={(e) => {
                              const width = Number(e.target.value);
                              if (width >= 45 && width <= 90)
                                mutate(
                                  resizePitch(scene, scene.pitch.length, width),
                                  "pitch",
                                );
                            }}
                          />
                        </label>
                      </div>
                      <p className="small">
                        Dimensions are assumed unless you know the actual pitch
                        size.
                      </p>
                    </details>
                  )}
                </div>
              ) : (
                <div className="inspector-content discussion">
                  <span className="eyebrow">DISCUSS THE DETAILS</span>
                  <h2>What do you see?</h2>
                  <p className="inspector-intro">
                    Comments stay attached to a fixed published revision.
                  </p>
                  {!publication ? (
                    <div className="discussion-empty">
                      <MessageCircle size={31} />
                      <strong>Give the play a place to talk.</strong>
                      <p>
                        Publish a revision to add comments and invite others
                        into the discussion.
                      </p>
                      <button
                        className="btn primary full"
                        onClick={() => setPublishOpen(true)}
                      >
                        <Share2 size={16} /> Publish this play
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="publication-note">
                        <ShieldCheck size={15} />
                        <span>
                          Revision {publication.scene.revision} · fixed snapshot
                        </span>
                        {!shared && (
                          <a href={shareUrl}>
                            Open published play <ArrowUpRight size={13} />
                          </a>
                        )}
                      </div>
                      {!shared ? (
                        <p className="small">
                          Open the published play to place a comment on its
                          exact positions and animation.
                        </p>
                      ) : (
                        <>
                          <div className="comment-list">
                            {comments
                              .filter((c) => !c.parentId)
                              .map((c) => (
                                <article
                                  id={`comment-${c.id}`}
                                  key={c.id}
                                  className="comment"
                                >
                                  <div className="comment-author">
                                    <span className="avatar small-avatar">
                                      {c.author[0].toUpperCase()}
                                    </span>
                                    <strong>{c.author}</strong>
                                    {session &&
                                      (c.authorId === session.user.id ||
                                        publication.ownerId ===
                                          session.user.id) && (
                                        <button
                                          className="icon-btn"
                                          aria-label="Delete comment"
                                          onClick={async () => {
                                            try {
                                              await api.deleteComment(
                                                publication.id,
                                                c.id,
                                                session,
                                              );
                                              setComments(
                                                await api.comments(
                                                  publication.id,
                                                ),
                                              );
                                            } catch (e) {
                                              showToast(
                                                e instanceof Error
                                                  ? e.message
                                                  : "Could not delete comment.",
                                              );
                                            }
                                          }}
                                        >
                                          <Trash2 size={13} />
                                        </button>
                                      )}
                                  </div>
                                  <button
                                    className="comment-location"
                                    onClick={() => selectComment(c.id)}
                                  >
                                    <Crosshair size={12} />
                                    {c.anchor.actorId
                                      ? scene.actors.find(
                                          (a) => a.id === c.anchor.actorId,
                                        )?.name || "Player"
                                      : c.anchor.point
                                        ? "Pitch point"
                                        : "Play"}{" "}
                                    · {(c.anchor.timeMs / 1000).toFixed(1)}s
                                  </button>
                                  <p>{c.body}</p>
                                  <button
                                    className="text-link"
                                    onClick={() => {
                                      setReplyId(c.id);
                                      setPlaying(false);
                                    }}
                                  >
                                    Reply
                                  </button>
                                  {comments
                                    .filter((r) => r.parentId === c.id)
                                    .map((r) => (
                                      <div className="comment-reply" key={r.id}>
                                        <strong>{r.author}</strong>
                                        <p>{r.body}</p>
                                      </div>
                                    ))}
                                </article>
                              ))}
                            {!comments.length && (
                              <div className="comments-empty">
                                <MessageCircle size={25} />
                                <p>Be the first to point something out.</p>
                              </div>
                            )}
                          </div>
                          <div className="comment-composer">
                            {replyId ? (
                              <div className="anchor-label">
                                Replying to{" "}
                                {comments.find((c) => c.id === replyId)?.author}
                                <button
                                  aria-label="Cancel reply"
                                  onClick={() => setReplyId(null)}
                                >
                                  <X size={13} />
                                </button>
                              </div>
                            ) : (
                              <button
                                className={`anchor-button ${commentAnchor ? "anchored" : ""}`}
                                onClick={() => {
                                  setPlaying(false);
                                  changeView("board");
                                  setAnchorMode(true);
                                  showToast(
                                    "Tap a point on the pitch to anchor your comment.",
                                  );
                                }}
                              >
                                <Crosshair size={14} />
                                {commentAnchor
                                  ? "Pitch point attached"
                                  : selectedId
                                    ? "Selected player attached"
                                    : "Attach a pitch point"}
                              </button>
                            )}
                            <label className="sr-only" htmlFor="comment-text">
                              Your comment
                            </label>
                            <textarea
                              id="comment-text"
                              value={commentText}
                              maxLength={2000}
                              placeholder="Point out a run, a gap, an alternative…"
                              onFocus={() => setPlaying(false)}
                              onChange={(e) => setCommentText(e.target.value)}
                            />
                            <button
                              className="btn primary full"
                              disabled={!commentText.trim() || busy}
                              onClick={() =>
                                requireLogin((auth) => void postComment(auth))
                              }
                            >
                              <Send size={15} /> Post comment
                            </button>
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </aside>
          </div>
          <footer className="workspace-footer">
            <span>
              <ShieldCheck size={13} />{" "}
              {readOnly
                ? "Published snapshot"
                : scene.calibration.status === "manual"
                  ? "Approximate positions"
                  : "Estimated positions · review against source"}
            </span>
            <span>Built to explain. Open to interpretation.</span>
          </footer>
        </main>
      )}
      {authOpen && (
        <AuthDialog
          session={session}
          onClose={() => {
            setAuthOpen(false);
            pendingAuth.current = null;
          }}
          onSuccess={finishLogin}
        />
      )}
      {publishOpen && (
        <SimpleDialog
          title={readOnly ? "Share this perspective" : "A play worth sharing."}
          onClose={() => setPublishOpen(false)}
        >
          <span className="eyebrow">
            ONE FIXED REVISION. MANY PERSPECTIVES.
          </span>
          <p>
            Anyone with the link can explore this revision. Signed-in viewers
            can add comments. Later edits won’t change this snapshot.
          </p>
          {!readOnly && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={includeSource}
                onChange={(e) => setIncludeSource(e.target.checked)}
              />
              Include the cropped source image
            </label>
          )}
          {publication ? (
            <>
              <label className="field-label" htmlFor="share-url">
                Published play link
              </label>
              <div className="copy-field">
                <input id="share-url" value={shareUrl} readOnly />
                <button
                  className="icon-btn"
                  aria-label="Copy share link"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(shareUrl)
                      .then(() => showToast("Link copied."))
                      .catch(() =>
                        showToast("Select and copy the link above."),
                      );
                  }}
                >
                  <Copy size={17} />
                </button>
              </div>
              <a
                className="btn secondary full"
                href={shareUrl}
                onClick={() => setPublishOpen(false)}
              >
                <Eye size={16} /> Open published revision
              </a>
              <div className="vr-handoff">
                <Headset size={23} />
                <span>
                  <strong>Continue on Meta Quest</strong>
                  <small>
                    Open this link in Quest Browser. Sign in there to open your
                    editable play from Your plays.
                  </small>
                </span>
              </div>
              {!readOnly && (
                <button
                  className="btn primary full"
                  disabled={busy}
                  onClick={() =>
                    requireLogin((auth) => void performPublish(auth))
                  }
                >
                  Publish latest changes <ArrowUpRight size={16} />
                </button>
              )}
            </>
          ) : (
            <button
              className="btn primary full"
              disabled={busy}
              onClick={() => requireLogin((auth) => void performPublish(auth))}
            >
              {busy ? "Publishing…" : "Publish a revision"}
              <Share2 size={16} />
            </button>
          )}
        </SimpleDialog>
      )}
      {libraryOpen && (
        <SimpleDialog
          title="Your tactical workspace"
          onClose={() => setLibraryOpen(false)}
        >
          <p>Pick up a saved play on any device.</p>
          {busy ? (
            <p>Loading your plays…</p>
          ) : library.length ? (
            <div className="library-list">
              {library.map((d) => (
                <div key={d.id}>
                  <button onClick={() => void openDraft(d)}>
                    <span className="library-icon">
                      <Flag size={20} />
                    </span>
                    <span>
                      <strong>{d.title}</strong>
                      <small>
                        {d.actors.length} actors · {d.keyframes.length} steps ·
                        revision {d.revision}
                      </small>
                    </span>
                    <ArrowRight size={17} />
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`Delete ${d.title}`}
                    onClick={async () => {
                      if (!session) return;
                      try {
                        await api.deleteDraft(d.id, session);
                        setLibrary(library.filter((item) => item.id !== d.id));
                        showToast("Saved play deleted.");
                      } catch (e) {
                        showToast(
                          e instanceof Error
                            ? e.message
                            : "Could not delete play.",
                        );
                      }
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="library-empty">
              <Layers size={31} />
              <h3>A clean slate.</h3>
              <p>Save your first play and it will appear here.</p>
              <button
                className="btn primary"
                onClick={() => {
                  setLibraryOpen(false);
                  fileInput.current?.click();
                }}
              >
                Start a play <Plus size={16} />
              </button>
            </div>
          )}
        </SimpleDialog>
      )}
      {helpOpen && (
        <SimpleDialog
          title="From one frame to every angle."
          onClose={() => setHelpOpen(false)}
        >
          <div className="help-steps">
            {[
              {
                title: "Start with a screenshot",
                text: "Upload or paste a wide match frame. Crop out controls and keep visible field markings.",
              },
              {
                title: "Check the reconstruction",
                text: "Align pitch landmarks, then correct teams, footpoints, and missed players.",
              },
              {
                title: "Explain what you see",
                text: "Add tags and arrows. Duplicate a step and move players to illustrate a sequence.",
              },
              {
                title: "Explore and discuss",
                text: "Switch to 3D or Quest VR. Publish a fixed revision and invite comments.",
              },
            ].map((s, i) => (
              <div key={s.title}>
                <span>{i + 1}</span>
                <div>
                  <strong>{s.title}</strong>
                  <p>{s.text}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="dev-notice">
            Movement is authored, not recovered from the screenshot. Only
            visible players are represented. Pitch size and player viewpoints
            are approximate.
          </p>
          <button
            className="btn primary full"
            onClick={() => setHelpOpen(false)}
          >
            Got it <Check size={16} />
          </button>
          {session && !session.user.isAnonymous && (
            <button
              className="text-link danger"
              onClick={() => {
                void api.logout(session).catch(() => {});
                setSession(null);
                localStorage.removeItem("futvr-session");
                setHelpOpen(false);
                showToast("Signed out. Your local draft is preserved.");
              }}
            >
              Sign out
            </button>
          )}
        </SimpleDialog>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
function RotateIcon() {
  return <Undo2 size={15} />;
}
function SimpleDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={onClose}
      aria-labelledby="modal-title"
    >
      <button
        className="icon-btn modal-close"
        onClick={onClose}
        aria-label="Close dialog"
      >
        <X size={20} />
      </button>
      <h2 id="modal-title">{title}</h2>
      {children}
    </dialog>
  );
}
