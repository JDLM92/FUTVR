import { useEffect, useRef, useState } from "react";
import { ArrowRight, Mail, X } from "lucide-react";
import { api } from "../lib/api";
import type { Session } from "../lib/api";
type Props = {
  session: Session | null;
  onClose: () => void;
  onSuccess: (session: Session) => void;
};
export default function AuthDialog({ session, onClose, onSuccess }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!sent) {
        const result = await api.requestCode(email);
        setDevCode(result.developmentCode || "");
        setSent(true);
      } else {
        const next = await api.verify(
          email,
          code,
          session?.user.isAnonymous ? session.accessToken : undefined,
        );
        onSuccess(next);
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not sign in. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={ref}
      className="modal auth-modal"
      onCancel={onClose}
      aria-labelledby="auth-title"
    >
      <button
        className="icon-btn modal-close"
        aria-label="Close sign in"
        onClick={onClose}
      >
        <X size={20} />
      </button>
      <div className="modal-icon">
        <Mail size={25} />
      </div>
      <span className="eyebrow">KEEP THE CONVERSATION GOING</span>
      <h2 id="auth-title">Your plays, wherever you are.</h2>
      <p>
        Save your board, open it on a headset, and discuss it with others. Your
        current draft stays with you.
      </p>
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="auth-email">
          Email address
        </label>
        <input
          id="auth-email"
          type="email"
          required
          value={email}
          autoComplete="email"
          disabled={sent}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
        {sent && (
          <>
            <label className="field-label" htmlFor="auth-code">
              Verification code
            </label>
            <input
              id="auth-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6-digit code"
            />
            {devCode ? (
              <div className="dev-notice">
                Local development · no email was sent.
                <br />
                Your test code is <strong>{devCode}</strong>.
              </div>
            ) : (
              <p className="small">Check your email for a six-digit code.</p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <button className="btn primary full" disabled={busy}>
          {busy ? "One moment…" : sent ? "Sign in" : "Send a code"}
          <ArrowRight size={17} />
        </button>
        {sent && (
          <button
            type="button"
            className="text-link"
            onClick={() => {
              setSent(false);
              setCode("");
            }}
          >
            Use a different email
          </button>
        )}
      </form>
      <p className="small auth-footnote">
        No password to remember. No draft left behind.
      </p>
    </dialog>
  );
}
