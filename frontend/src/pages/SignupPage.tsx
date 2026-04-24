import { useState } from "react";
import { Link } from "react-router-dom";
import { signup } from "../api";
import { useTurnstileWidget } from "../hooks/useTurnstileWidget";

export function SignupPage() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const { token: turnstileToken, reset: resetTurnstile } = useTurnstileWidget({ containerId: "ts-signup" });
  const passwordRule = /^[\x21-\x7E]{4,15}$/;

  const onSubmit = async () => {
    setBusy(true);
    setErr("");
    try {
      if (!passwordRule.test(password)) {
        throw new Error("パスワードは 4〜15文字の半角英数字・記号で入力してください（スペース不可）。");
      }
      if (!turnstileToken) {
        throw new Error("CAPTCHA を完了してください。");
      }
      await signup(username, email, password, passwordConfirm, turnstileToken);
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
      <h1>会員登録</h1>
      {done ? (
        <div>
          <p>
            登録内容を受け付けました。<strong>確認メール</strong>を送信しました。メール内のリンクを<strong>15分以内</strong>に開き、メール認証を完了してください。認証完了後は自動的にログイン状態になります。
          </p>
          <p className="muted">
            メールが届かない場合は迷惑メールフォルダもご確認ください。認証メールの再送信は
            <Link to="/resend-verification">こちら</Link>
            から行えます。
          </p>
        </div>
      ) : (
        <div className="signup-form">
          <input className="input" placeholder="ID (英数字 4〜15)" value={username} onChange={(e) => setUsername(e.target.value)} />
          <input className="input" placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="input" type="password" placeholder="パスワード" value={password} onChange={(e) => setPassword(e.target.value)} />
          <input className="input" type="password" placeholder="パスワード確認" value={passwordConfirm} onChange={(e) => setPasswordConfirm(e.target.value)} />
          <div id="ts-signup" className="signup-captcha" />
          <p className="muted">
            会員登録の前に、<Link to="/terms">利用規約</Link> と <Link to="/policy">プライバシーポリシー</Link> をご確認ください。
            登録ボタンを押すことで、内容に同意のうえ登録を進めることができます。
          </p>
          <p className="muted">
            使い捨てメール（例: 10MinuteMail など）や一部の受信制限があるメールアドレスでは、認証メールが届かない場合があります。
          </p>
          <button className="btn" type="button" disabled={busy} onClick={() => void onSubmit()}>
            {busy ? "送信中…" : "登録する"}
          </button>
          {err ? <p className="error">{err}</p> : null}
        </div>
      )}
      <p><Link to="/login">ログインへ</Link></p>
    </article>
  );
}
