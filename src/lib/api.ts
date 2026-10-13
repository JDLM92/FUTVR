import type {
  AnalysisJob,
  Comment,
  CommentAnchor,
  Publication,
  Scene,
} from "../domain/types";
export type Session = {
  accessToken: string;
  refreshToken?: string;
  user: { id: string; email: string | null; isAnonymous: boolean };
};
const base = (import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "");
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  session: Session | null = null,
  options: RequestInit = {},
): Promise<T> {
  let effective = session;
  try {
    const cached = JSON.parse(localStorage.getItem("futvr-session") || "null");
    if (session && cached?.user?.id === session.user.id) effective = cached;
  } catch {
    /* retain the supplied session */
  }
  const headers = new Headers(options.headers);
  if (effective)
    headers.set("Authorization", `Bearer ${effective.accessToken}`);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...options, headers });
  } catch {
    throw new ApiError(
      0,
      "The service is unreachable. Your local draft is safe.",
    );
  }
  if (response.status === 401 && effective?.refreshToken) {
    try {
      const refreshed = await fetch(`${base}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: effective.refreshToken }),
      });
      if (refreshed.ok) {
        const next = (await refreshed.json()) as Session;
        localStorage.setItem("futvr-session", JSON.stringify(next));
        window.dispatchEvent(
          new CustomEvent("futvr-session-refreshed", { detail: next }),
        );
        headers.set("Authorization", `Bearer ${next.accessToken}`);
        response = await fetch(`${base}${path}`, { ...options, headers });
      }
    } catch {
      /* the original unauthorized response remains useful */
    }
  }
  if (!response.ok) {
    let detail = "Request failed";
    try {
      const body = await response.json();
      detail =
        typeof body.detail === "string"
          ? body.detail
          : Array.isArray(body.detail)
            ? body.detail
                .map((item: { msg?: string }) => item.msg || "Invalid input")
                .join("; ")
            : String(body.error || detail);
    } catch {
      /* no JSON */
    }
    throw new ApiError(response.status, detail);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const api = {
  guest: () => request<Session>("/auth/guest", null, { method: "POST" }),
  requestCode: (email: string) =>
    request<{ sent: boolean; developmentCode?: string }>(
      "/auth/request-code",
      null,
      { method: "POST", body: JSON.stringify({ email }) },
    ),
  verify: (email: string, code: string, guestToken?: string) =>
    request<Session>("/auth/verify", null, {
      method: "POST",
      body: JSON.stringify({ email, code, guestToken }),
    }),
  logout: (session: Session) =>
    request<void>("/auth/logout", session, { method: "POST" }),
  analyze: (file: File, session: Session) => {
    const data = new FormData();
    data.append("file", file);
    return request<
      AnalysisJob & {
        asset?: { id: string; url: string; width: number; height: number };
      }
    >("/analyses", session, { method: "POST", body: data });
  },
  analysis: (id: string, session: Session) =>
    request<
      AnalysisJob & {
        asset?: { id: string; url: string; width: number; height: number };
      }
    >(`/analyses/${encodeURIComponent(id)}`, session),
  save: (scene: Scene, expectedRevision: number, session: Session) =>
    request<Scene>(`/drafts/${encodeURIComponent(scene.id)}`, session, {
      method: "PUT",
      body: JSON.stringify({ scene, expectedRevision }),
    }),
  drafts: (session: Session) => request<Scene[]>("/drafts", session),
  draft: (id: string, session: Session) =>
    request<Scene>(`/drafts/${encodeURIComponent(id)}`, session),
  deleteDraft: (id: string, session: Session) =>
    request<void>(`/drafts/${encodeURIComponent(id)}`, session, {
      method: "DELETE",
    }),
  assetUrl: (id: string, session: Session) =>
    request<{ url: string; expiresAt: string }>(
      `/assets/${encodeURIComponent(id)}/url`,
      session,
    ),
  publish: (id: string, includeSource: boolean, session: Session) =>
    request<Publication>(`/drafts/${encodeURIComponent(id)}/publish`, session, {
      method: "POST",
      body: JSON.stringify({ includeSource }),
    }),
  publication: (id: string) =>
    request<Publication>(`/publications/${encodeURIComponent(id)}`),
  comments: (id: string) =>
    request<Comment[]>(`/publications/${encodeURIComponent(id)}/comments`),
  comment: (
    id: string,
    body: string,
    anchor: CommentAnchor,
    session: Session,
    parentId?: string,
  ) =>
    request<Comment>(
      `/publications/${encodeURIComponent(id)}/comments`,
      session,
      { method: "POST", body: JSON.stringify({ body, anchor, parentId }) },
    ),
  deleteComment: (publicationId: string, id: string, session: Session) =>
    request<void>(
      `/publications/${encodeURIComponent(publicationId)}/comments/${encodeURIComponent(id)}`,
      session,
      { method: "DELETE" },
    ),
};
