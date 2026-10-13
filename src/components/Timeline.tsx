import { CopyPlus, Pause, Play, SkipBack } from "lucide-react";
import type { Scene } from "../domain/types";
import { totalDuration } from "../domain/scene";
type Props = {
  scene: Scene;
  index: number;
  time: number;
  playing: boolean;
  speed: number;
  readOnly: boolean;
  onSelect: (index: number) => void;
  onScrub: (time: number) => void;
  onPlay: () => void;
  onReset: () => void;
  onSpeed: (speed: number) => void;
  onDuplicate: () => void;
  onDuration: (duration: number, hold: number) => void;
  onDeleteFrame: () => void;
};
export default function Timeline(p: Props) {
  const duration = totalDuration(p.scene),
    frame = p.scene.keyframes[p.index];
  return (
    <section className="timeline" aria-label="Illustrative animation timeline">
      <div className="timeline-heading">
        <div className="timeline-title">
          <span className="eyebrow">SEQUENCE</span>
          <strong>Illustrative animation</strong>
        </div>
        <span className="pill subtle">
          {p.scene.keyframes.length}{" "}
          {p.scene.keyframes.length === 1 ? "step" : "steps"}
        </span>
        <div className="timeline-playback">
          <button
            className="icon-btn"
            aria-label="Reset playback"
            onClick={p.onReset}
          >
            <SkipBack size={17} />
          </button>
          <button
            className="play-btn"
            onClick={p.onPlay}
            aria-label={p.playing ? "Pause animation" : "Play animation"}
          >
            {p.playing ? <Pause size={17} /> : <Play size={17} />}
          </button>
          <span className="timecode">
            {(p.time / 1000).toFixed(1)} / {(duration / 1000).toFixed(1)}s
          </span>
          <label className="sr-only" htmlFor="playback-speed">
            Playback speed
          </label>
          <select
            id="playback-speed"
            value={p.speed}
            onChange={(e) => p.onSpeed(Number(e.target.value))}
          >
            <option value=".5">0.5×</option>
            <option value="1">1×</option>
            <option value="2">2×</option>
          </select>
        </div>
      </div>
      <input
        className="scrubber"
        type="range"
        min="0"
        max={duration}
        step="20"
        value={Math.min(p.time, duration)}
        aria-label="Animation time"
        onChange={(e) => p.onScrub(Number(e.target.value))}
      />
      <div className="frame-row">
        {p.scene.keyframes.map((f, i) => (
          <button
            key={f.id}
            className={`frame-card ${i === p.index ? "active" : ""}`}
            onClick={() => p.onSelect(i)}
          >
            <span className="frame-number">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="frame-mini">
              <i />
              <i />
              <i />
            </span>
            <span>{((f.durationMs + f.holdMs) / 1000).toFixed(1)}s</span>
          </button>
        ))}
        {!p.readOnly && (
          <button className="frame-add" onClick={p.onDuplicate}>
            <CopyPlus size={20} />
            <span>Add step</span>
          </button>
        )}
      </div>
      {!p.readOnly && (
        <div className="frame-settings">
          <span>Editing step {p.index + 1}</span>
          <label>
            Move{" "}
            <input
              type="number"
              min=".1"
              max="60"
              step=".1"
              value={frame.durationMs / 1000}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 0.1 && n <= 60)
                  p.onDuration(Math.round(n * 1000), frame.holdMs);
              }}
            />
            s
          </label>
          <label>
            Hold{" "}
            <input
              type="number"
              min="0"
              max="60"
              step=".1"
              value={frame.holdMs / 1000}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 0 && n <= 60)
                  p.onDuration(frame.durationMs, Math.round(n * 1000));
              }}
            />
            s
          </label>
          {p.scene.keyframes.length > 1 && (
            <button className="text-link danger" onClick={p.onDeleteFrame}>
              Delete step
            </button>
          )}
        </div>
      )}
    </section>
  );
}
