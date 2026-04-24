import { useState } from "react";
import { forgotPassword } from "../api";
import { useTurnstileWidget } from "../hooks/useTurnstileWidget";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");
  const { token: turnstileToken, reset: resetTurnstile } = useTurnstileWidget({ containerId: "ts-forgot" });

  const onSubmit = async () => {
    setBusy(true);
    setErr("");
    try {
      if (!turnstileToken) {
        throw new Error("CAPTCHA を完了してください。");
      }
      await forgotPassword(email, turnstileToken);
      setDone(true);
    } catch (e) {
      resetTurnstile();
      setErr(e instanceof Error ? e.message : "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="prose">
      <h1>パスワード再設定</h1>
      <p>登録済みメールアドレスを入力してください。</p>
      <div className="forgot-form">
        <input className="input" placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div id="ts-forgot" className="forgot-captcha" />
        <button className="btn" type="button" disabled={busy} onClick={() => void onSubmit()}>
          {busy ? "送信中…" : "再設定メールを送信"}
        </button>
        {done ? <p>メールを送信しました。</p> : null}
        {err ? <p className="error">{err}</p> : null}
      </div>
    </article>
  );
}
