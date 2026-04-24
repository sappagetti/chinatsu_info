import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { resetPassword } from "../api";

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const [pwd, setPwd] = useState("");
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");
  const token = params.get("token") ?? "";
  const onSubmit = async () => {
    try {
      await resetPassword(token, pwd);
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error");
    }
  };
  return (
    <article className="prose">
      <h1>新しいパスワード設定</h1>
      {done ? (
        <p>変更が完了しました。<Link to="/login">ログインへ</Link></p>
      ) : (
        <>
          <input className="input" type="password" placeholder="新しいパスワード(10文字以上)" value={pwd} onChange={(e) => setPwd(e.target.value)} />
          <button className="btn" type="button" onClick={() => void onSubmit()}>変更する</button>
          {err ? <p className="error">{err}</p> : null}
        </>
      )}
    </article>
  );
}
