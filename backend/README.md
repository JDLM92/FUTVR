# FutVR API

FastAPI owns authentication, private images, asynchronous analysis, versioned drafts,
immutable publications and comment moderation. It uses local SQLite only when
`FUTVR_ENV=development` or `test`. Production requires Supabase and fails startup
when its configuration is missing.

## Run locally

From the repository root:

```sh
python3 -m venv .venv
.venv/bin/pip install -e 'backend[test]'
PYTHONPATH=backend .venv/bin/uvicorn futvr.api:app --host 0.0.0.0 --port 8000
```

Run the frontend separately. The development server defaults to
`http://localhost:8000`; its local private-image URLs use that origin. The server
does not load `.env` automatically: export its variables, use your host's secret
configuration, or run uvicorn with `--env-file` after installing python-dotenv.

```sh
PYTHONPATH=backend .venv/bin/pytest backend/tests -q
```

Development email sign-in is a **local demonstration**: `request-code` returns
`developmentCode`; it sends no email. Only explicit `development` mode returns
this field. Codes expire after ten minutes, allow five attempts and are single
use. Production calls Supabase Auth's email OTP endpoints instead.

## Optional actual detection

```sh
.venv/bin/pip install -e 'backend[inference]'
RFDETR_ENABLED=1 PYTHONPATH=backend .venv/bin/uvicorn futvr.api:app --port 8000
```

RF-DETR Large downloads its COCO weights on first use. The server uses actual
person/sports-ball proposals, bottom-centre person footpoints, and tentative torso
colour clustering. Review is always required. No positions, identities or motion
are fabricated when detection is disabled or unavailable. This integration is
not a validated football detector; accuracy and latency need evaluation on
appropriately permitted representative screenshots.

A real smoke check on 2026-10-13 used the pinned RF-DETR 1.11.2 Large model on
the supplied football screenshot after cropping the match region to 1695×873.
CPU inference with four Torch threads returned 21 person candidates and one
sports-ball candidate. Initial model loading including the official 130 MB
weight download took 21.382 seconds; the first prediction took 1.211 seconds.
These timings are one local run, not a performance benchmark. Visual inspection
found the referee among person candidates and an occluded player's visible-body
box ending above the true feet, confirming the need for role and footpoint review.

Run the same smoke workflow on an appropriately permitted image:

```sh
.venv/bin/python backend/scripts/smoke_detector.py /absolute/path/to/image.png --crop 0 0 1600 900
```

The script leaves the original untouched, forces CPU unless overridden, and saves
its crop, annotated detector overlay, timings and JSON results under
`/tmp/futvr-detector-smoke`. Its model cache is kept in that output directory.
Use `RFDETR_DEVICE=cpu` to force local CPU inference, or omit it for automatic
device selection. Set `RFDETR_WEIGHTS_PATH` to an existing trusted official Large
checkpoint to reuse a download; a missing configured path fails clearly instead
of silently loading a different model. Without that override, RF-DETR uses its
standard cache (`RF_HOME` can choose its directory).

Automatic field calibration remains explicitly unavailable. The guided endpoint
solves a real homography with Hartley-normalized DLT and rejects duplicate,
collinear and unstable landmarks. Four visible landmarks must identify known
pitch locations. Image coordinates are normalized to `0..1`; the returned 3×3
matrix maps those image coordinates to pitch metres.

## API contract

All paths begin `/api`. Private routes require `Authorization: Bearer <token>`.
Errors use FastAPI's `{"detail": ...}` shape; revision conflicts return HTTP 409.
OpenAPI is available at `/docs`.

- `POST /auth/guest` → `{accessToken,user:{id,email,isAnonymous}}`; production also returns `refreshToken`.
- `POST /auth/request-code {email}` → `{sent:true,developmentCode?}`.
- `POST /auth/verify {email,code,guestToken?}` → session. A guest bearer header is also accepted. Successful verification transfers controlled guest uploads, jobs and drafts to the verified owner.
- `GET /auth/me`, `POST /auth/refresh {refreshToken}`, `POST /auth/logout`.
- `POST /analyses` accepts multipart `file` → HTTP 202 `AnalysisJob`, including `asset:{id,url,width,height,expiresAt}`.
- `GET /analyses/{id}` → queued/processing/completed/failed job; `DELETE /analyses/{id}` removes a job.
- `POST /calibrations {landmarks:[{image,pitch}],imageWidth?,imageHeight?}` → `Calibration`.
- `GET /assets/{id}/url` → `{url,expiresAt}`; `DELETE /assets/{id}` refuses images still referenced by an owner's draft or publication.
- `GET /drafts` → `Scene[]`; `GET /drafts/{id}` → `Scene`; `PUT /drafts/{id} {scene,expectedRevision}` → saved `Scene`; `DELETE /drafts/{id}`.
- First save requires `expectedRevision:0`; each save increments the server revision. Further saves must use the last returned revision. Sources must reference an asset controlled by the owner.
- Production cloud draft saves require email sign-in. Local development permits staged guest drafts so guest-claim continuity can be exercised; the frontend still offers save after sign-in.
- `POST /drafts/{id}/publish {includeSource:false}` → immutable `Publication`. Email sign-in is required. Source images are excluded unless explicitly opted in.
- New publication IDs use 12 URL-safe random characters (72 bits) for headset hand-off. Previously stored longer IDs and UUID links remain readable; client-owned draft IDs are unchanged.
- `GET /publications` lists the owner's snapshots; `GET /publications/{id}` allows anonymous viewing; `DELETE /publications/{id}` revokes the publication and its comments.
- `GET /publications/{id}/comments` allows anonymous reading; `POST` requires email sign-in and `{body,anchor:{timeMs,actorId?,point?},parentId?}`. Replies have one level. Anchors refer to the immutable published revision.
- `DELETE /publications/{id}/comments/{commentId}` permits author or publication-owner moderation and preserves replies with a removed-comment tombstone.

Detection `imagePoint` and `box` coordinates are normalized `0..1`; boxes are
`[x1,y1,x2,y2]`. Actor positions, annotations and comment points use pitch metres.

## Supabase + Modal deployment (prepared, not deployed)

1. Choose an existing/new Supabase project, then explicitly apply
   `supabase/migrations/202610130001_futvr_private.sql`. It creates six RLS-enabled
   tables, service-only RPCs for atomic queue admission and guest claims, and a
   private `futvr-private` image bucket. Browser clients have no direct table or
   bucket permissions; the backend checks each owner before using its service key.
2. Enable Anonymous Sign-Ins. Configure email Auth and SMTP. Set the email OTP
   template to show `{{ .Token }}` so the frontend's numeric-code entry can verify
   it. Configure Supabase's Auth limits and abuse protection before public launch.
3. Authenticate the Modal CLI to the intended workspace. In Modal's secret UI,
   create `futvr-production` with `FUTVR_ENV=production`,
   `FUTVR_JOB_BACKEND=modal`, `RFDETR_ENABLED=1`, `SUPABASE_URL`,
   `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`,
   `SUPABASE_STORAGE_BUCKET=futvr-private`, `FUTVR_PUBLIC_API_URL` (HTTPS),
   and `FUTVR_CORS_ORIGINS` (the exact Vercel frontend origin). Keep server keys
   out of browser environment variables and client bundles.
   The preferred `sb_publishable_`/`sb_secret_` keys are sent only in Supabase's
   `apikey` header; they are not treated as JWTs. The old `SUPABASE_ANON_KEY` and
   `SUPABASE_SERVICE_ROLE_KEY` names remain supported for existing projects.
4. Install the optional deployment SDK and run from `backend/`:

   ```sh
   ../.venv/bin/pip install -e '.[modal]'
   ../.venv/bin/modal deploy modal_app.py
   ```

5. Set the frontend's `VITE_API_URL` to the actual Modal ASGI URL returned
   by deployment with `/api` appended, verify `/api/health`, and test anonymous upload → email claim
   → save → private-source publication → comment → delete on the chosen project.

The Modal adapter exposes a CPU ASGI API and uses durable `spawn` calls to a
separate GPU worker. Results live in Supabase, so browser navigation does not
cancel analysis. The prepared image builds download and verify the pinned official
Large checkpoint once into `/opt/futvr-models`; the worker reuses it on cold starts.
No Modal image build was performed locally. Postgres atomically admits at most four active jobs globally
and two per owner. The API is capped at one container to bound its in-memory
request limiter; use a shared limiter before scaling that API horizontally.

Private image URLs expire after fifteen minutes. The owner can refresh them,
and publication viewers receive new URLs only for opted-in images. Deleting a
publication revokes the API link immediately; a previously issued Supabase
signed image URL can remain valid until its expiry if the image is retained in
a draft. Delete the image after removing all references to revoke its content.

This repository does not include credentials, apply migrations automatically,
create cloud projects or claim a working deployment. Supabase/Modal integration
and real model accuracy remain unverified until configured and tested against
the selected services.
