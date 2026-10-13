# FutVR

A web tactical workspace for football screenshots: assisted reconstruction, SVG annotation, authored animation, Three.js/WebXR exploration, immutable share links, and anchored discussion.

## Run locally

```sh
npm ci
python3 -m venv .venv
.venv/bin/pip install -e 'backend[test]'
```

Start the API:

```sh
PYTHONPATH=backend .venv/bin/uvicorn futvr.api:app --host 0.0.0.0 --port 8000
```

In a second terminal:

```sh
npm run dev
```

Open http://localhost:5173. “Try a sample play” loads explicitly synthetic positions and a generated source image. Upload/paste accepts PNG, JPEG, and WebP. IndexedDB preserves a local draft through login and refresh. Development sign-in displays a local code and sends no email.

Without the optional RF-DETR dependencies, uploads enter guided/manual reconstruction with no invented detections. To enable actual player/ball proposals, install `backend[inference]` and start the API with `RFDETR_ENABLED=1`. Pitch alignment uses four guided landmarks and a validated homography; automatic field registration is not activated. TVCalib remains gated on pretrained-weight terms and evaluation.

## Implemented

- Source crop, guided field alignment, editable footpoints, player tags and teams.
- SVG select/drag, arrows, lines, circles, rectangular zones, text, endpoint editing and Undo.
- Keyframe duplication, holds, deterministic movement, scrubbing and playback speed.
- Shared canonical geometry for the board and low-poly 3D, with mobile orbit/pan/zoom and approximate player viewpoints.
- WebXR VR entry/recovery and controller selection, player/ball movement, arrows/zones, playback and Undo. AR is deferred.
- API-backed ownership, guest claiming, optimistic save revisions, immutable opt-in-source publications, comment anchors/replies and moderation.
- Local SQLite persistence and production Supabase/Modal adapters. Production refuses a silent SQLite fallback.

## Tests

```sh
npm test
npm run build
PYTHONPATH=backend .venv/bin/pytest backend/tests -q
npm run test:e2e
```

The end-to-end tests start local services when they are not already running; CI starts isolated services. Browser installation may be needed on a fresh machine (`npx playwright install chromium`).

## Deploy

Read [SETUP.md](./SETUP.md) for exact credentials, safe configuration, Supabase migration, Modal deployment, and Vercel hosting. Never commit `.env` or put server secrets in `VITE_` variables.

The backend's `FUTVR_PUBLIC_API_URL` is optional in production; omit it for the first Modal deployment. Use the actual returned Modal URL, with `/api` appended, for Vercel's `VITE_API_URL`, then allow the actual frontend origin through `FUTVR_CORS_ORIGINS`.

## Validation still required for a public beta

Run the permitted 80–100-frame detection/calibration evaluation and physical phone/headset checks before claiming accuracy, latency, or XR performance targets. Cloud services must be configured and verified in your projects. Video tracking, AR, live rooms, full headset text/timeline authoring, and exported video belong to V2.
