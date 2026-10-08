import { useEffect, useRef, useState, type FormEvent } from "react";
import { IconEye } from "../components/icons";
import { BASE, withBase } from "../lib/paths";
import "../styles/login.css";

/** PIN sign-in. Digits only; submits as soon as the last digit is typed (when the length is known). */
export default function LoginPage({ pinLength }: { pinLength: number }) {
  const max = pinLength || 8;
  const [pin, setPin] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  async function submit(value: string) {
    setErr("");
    if (!value) return input.current?.focus();
    setBusy(true);
    // Plain fetch: api() would re-fire the login event on a 401 (wrong PIN).
    const res = await fetch(withBase("/api/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: value, base: BASE }),
    }).catch(() => null);
    if (res?.ok) return location.reload();
    const body = (await res?.json().catch(() => null)) as { error?: string } | null;
    setErr(body?.error || (res ? "Could not sign in" : "Network error"));
    setBusy(false);
    setPin("");
    input.current?.focus();
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy) void submit(pin);
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="logo">COMICFLIX</div>
        {/* lets password managers pair the PIN with an account */}
        <input type="text" name="username" value="me" autoComplete="username" hidden readOnly />
        <div className="login-field">
          <input
            ref={input}
            id="login-pin"
            type={show ? "text" : "password"}
            name="password"
            placeholder="PIN"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="current-password"
            aria-label="PIN"
            size={1}
            maxLength={max}
            value={pin}
            readOnly={busy}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "").slice(0, max);
              setPin(v);
              if (pinLength && v.length === pinLength && !busy) void submit(v);
            }}
          />
          <button
            type="button"
            className={`login-eye${show ? " on" : ""}`}
            aria-label={show ? "Hide PIN" : "Show PIN"}
            title={show ? "Hide PIN" : "Show PIN"}
            onClick={() => {
              setShow((s) => !s);
              input.current?.focus();
            }}
          >
            <IconEye open={show} />
          </button>
        </div>
        <button type="submit" className="addbtn" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="login-err" role="alert">
          {err}
        </p>
      </form>
    </div>
  );
}
