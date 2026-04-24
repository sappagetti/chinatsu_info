import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useTurnstileWidget } from "../hooks/useTurnstileWidget";

export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [failed, setFailed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const { token: turnstileToken } = useTurnstileWidget({ containerId: "ts-login", enabled: failed >= 2 });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("verify") === "invalid") {
      setErr("認証リンクが無効か、期限切れです。再度認証メールを送信してください。");
      params.delete("verify");
      const qs = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    }
  }, []);

  const onSubmit = async () => {
    setBusy(true);
    setErr("");
    try {
      const ts = failed >= 2 ? turnstileToken : "";
      if (failed >= 2 && !ts) {
        throw new Error("CAPTCHA を完了してください。");
      }
      await login(email, password, remember, ts);
      nav("/setup");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      if (msg === "CAPTCHA_REQUIRED") {
        // 서버가 과거 실패 이력 등을 근거로 첫 시도부터 CAPTCHA 를 요구할 수 있으므로,
        // failed 카운터를 강제로 2 이상으로 끌어올려 위젯을 렌더링한다.
        setFailed((v) => Math.max(v, 2));
        setErr("このアカウントは追加認証が必要です。CAPTCHA を完了して再度ログインしてください。");
      } else if (msg === "EMAIL_NOT_VERIFIED") {
        setErr("メール認証が完了していません。受信したメールのリンクを開くか、認証メールを再送信してください。");
      } else {
        setFailed((v) => v + 1);
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="prose">
      <h1>ログイン</h1>
      <div className="login-form">
        <input className="input" placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" type="password" placeholder="パスワード" value={password} onChange={(e) => setPassword(e.target.value)} />
        <label className="muted">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> ログイン状態を保持する（30日）
        </label>
        {failed >= 2 ? (
          <div id="ts-login" className="login-captcha" />
        ) : null}
        <button className="btn" type="button" disabled={busy} onClick={() => void onSubmit()}>
          {busy ? "処理中…" : "ログイン"}
        </button>
        {err ? <p className="error">{err}</p> : null}
      </div>
      <p><Link to="/forgot-password">パスワードを忘れた方</Link></p>
      <p><Link to="/resend-verification">認証メールを再送信</Link></p>
      <p><Link to="/signup">新規登録</Link></p>
    </article>
  );
}
