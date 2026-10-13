# Connect FutVR safely

The application is ready for local testing. Cloud deployment needs your own Supabase, Modal, and Vercel projects. You do not need to send passwords, API secrets, verification codes, or access tokens in this chat.

## Exactly what is needed

- **Supabase project URL**: `https://YOUR_PROJECT.supabase.co`.
- **Supabase publishable key** (`sb_publishable_…`): the backend uses it for Auth requests.
- **Supabase secret key** (`sb_secret_…`): the backend alone uses it for private storage and database operations. This key bypasses row-level security; keep it private.
- **Modal CLI login** in your intended Modal workspace, plus a secret named `futvr-production`.
- **Vercel CLI login** in your intended Vercel account/team.
- The names of the projects/workspaces you want to use. Those names and public project URLs are safe to send in chat.

Supabase also supports legacy `anon`/`service_role` values through the environment aliases in `.env.example`. Prefer its newer publishable/secret keys. [Supabase API-key guidance](https://supabase.com/docs/guides/api/api-keys)

## Keep credentials outside chat and Git

1. Copy `.env.example` to `.env` in the FutVR folder. `.env` is ignored by Git.
2. Make it readable only by your macOS user:

   ```sh
   chmod 600 .env
   ```

3. Open `.env` in your local editor. Paste the Supabase values there, not in chat or a terminal command. Do not prefix a server secret with `VITE_`; Vite exposes those variables in browser bundles.
4. For production, enter the Supabase values and the production settings below in Modal's **Secrets** UI as `futvr-production`. Omit `FUTVR_PUBLIC_API_URL`; do not copy its local HTTP value. Leave private values out of the Vercel frontend environment. Vercel needs only `VITE_API_URL`.
5. Sign in through each vendor's normal CLI flow. Complete browser authentication yourself:

   ```sh
   vercel login
   .venv/bin/modal setup
   ```

   The Modal SDK is already installed in this workspace; only account login remains. On another machine, install it first with `.venv/bin/pip install -e 'backend[modal]'` if needed. [Vercel login documentation](https://vercel.com/docs/cli/login)

Once you have entered the two Supabase keys in the local `.env` and completed Modal login, the named Modal secret can be created securely from those local values without printing or sending them in chat. Its production flags should be set as shown below rather than copied from development defaults.

After setup, tell me “the credentials are configured” and which account/project names to use. I can check connection status without printing secret values.

You can also run `.venv/bin/python scripts/check-config.py` locally. It reports only which required variables are present or missing; the optional backend `FUTVR_PUBLIC_API_URL` is excluded.

## Supabase project preparation

Use a dedicated beta project. In its SQL editor, apply `supabase/migrations/202610130001_futvr_private.sql`. It creates FutVR's tables, service-only RPCs, row-level security, and a private image bucket. Enable Anonymous Sign-ins, configure email Auth/SMTP, and change the email template to display `{{ .Token }}` for six-digit-code entry.

Applying this SQL requires a signed-in project SQL editor. The application's secret API key alone does not run raw migrations through its REST adapter. No additional credential is needed in this chat when you apply it manually. Automated SQL would require separate Management API authorization. [Supabase SQL API](https://supabase.com/docs/reference/api/v1-run-a-query)

Custom SMTP is required for sign-in emails to people outside your Supabase project team. Configure its credentials inside Supabase's Auth settings. [Supabase SMTP guidance](https://supabase.com/docs/guides/auth/auth-smtp)

The frontend has no direct access to the database or private bucket. The API verifies ownership before using the server key. Set Auth rate limits and abuse protection for a public beta.

## Backend environment in Modal

Set these values in the `futvr-production` secret:

```dotenv
FUTVR_ENV=production
FUTVR_JOB_BACKEND=modal
RFDETR_ENABLED=1
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY=YOUR_PRIVATE_SECRET_KEY
SUPABASE_STORAGE_BUCKET=futvr-private
FUTVR_CORS_ORIGINS=
```

From `backend/`, deploy with `../.venv/bin/modal deploy modal_app.py`. `FUTVR_PUBLIC_API_URL` is optional and defaults to empty in production, so the first deployment does not need its own future URL. Production source links are signed directly by Supabase. If you explicitly set this optional value, use HTTPS.

Keep `FUTVR_CORS_ORIGINS` empty until the actual frontend origin is known; an empty value allows no cross-origin browser access. After Vercel creates the frontend, set this value to its exact HTTPS origin in the Modal secret and redeploy. Include each preview origin explicitly when needed.

## Vercel frontend

Set **only** this public routing value in Vercel:

```dotenv
VITE_API_URL=https://YOUR_MODAL_API_ORIGIN/api
```

The `/api` suffix is required. Import the repository with the Vite preset, or run `vercel` from this folder after login. `vercel.json` defines the build and output. After checking a preview deployment, use `vercel --prod` for the public release.

## Verify before opening the beta

Check API health, anonymous upload, real detector output, email-code sign-in, draft recovery, cross-device save conflicts, source privacy, a published revision, a comment/reply, and owner deletion. Test iPhone Safari, Android Chrome, and physical Quest 3/3S hardware. The source-code tests do not certify headset performance or football detection accuracy.

Private image links expire after 15 minutes. Revoking a publication removes its API link immediately; an already issued image link can remain valid until it expires if the image is retained in a draft. See `backend/README.md` for deployment and storage details.
