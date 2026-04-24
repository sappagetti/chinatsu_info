import { useState } from "react";
import { Link } from "react-router-dom";
import { resendVerification } from "../api";
import { useTurnstileWidget } from "../hooks/useTurnstileWidget";

export function ResendVerificationPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");
  const { token: turnstileToken, reset: resetTurnstile } = useTurnstileWidget({ containerId: "ts-resend-verify" });

  const onSubmit = async () => {
    setBusy(true);
    setErr("");
    try {
      if (!turnstileToken) {
        throw new Error("CAPTCHA を完了してください。");
      }
      await resendVerification(email, turnstileToken);
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
      <h1>認証メールの再送信</h1>
      {done ? (
        <p>
          ご登録のメールアドレス宛に、確認メールを送信しました。受信トレイをご確認ください。
          <br />
          <span className="muted">※ 登録の有無にかかわらず同じメッセージを表示します。</span>
        </p>
      ) : (
        <div className="forgot-form">
          <p className="muted">登録時のメールアドレスを入力してください。</p>
          <input className="input" placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} />
          <div id="ts-resend-verify" className="forgot-captcha" />
          <button className="btn" type="button" disabled={busy} onClick={() => void onSubmit()}>
            {busy ? "送信中…" : "再送信する"}
          </button>
          {err ? <p className="error">{err}</p> : null}
        </div>
      )}
      <p>
        <Link to="/login">ログインへ</Link>
      </p>
    </article>
  );
}
