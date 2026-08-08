import { useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { mergeMusicExOverrides } from "../api";
import { useAuth } from "../auth/AuthContext";
import { fetchMusicExJson } from "../lib/musicExCache";
import { parseConstOverridePaste } from "../lib/constOverrideParse";

const musicExUrl = import.meta.env.VITE_BEATMAP_BUCKET_URL?.trim() ?? "";

const EXAMPLE = `それはもうらぶちゅ	MASTER	13	13.5
それはもうらぶちゅ	EXPERT	11	11.0
Cthugha	MASTER	14	14.2
Cthugha	EXPERT	12	12.6
アルメリアの鳥籠	MASTER	13+	13.7
アルメリアの鳥籠	EXPERT	12	12.2`;

export function ConstOverridePage() {
  const { user } = useAuth();
  const [text, setText] = useState("");
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const preview = useMemo(() => parseConstOverridePaste(text, force), [text, force]);

  if (!user?.can_edit_const_overrides) {
    return <Navigate to="/" replace />;
  }

  async function onSubmit() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      if (preview.length === 0) {
        throw new Error("有効な行がありません。曲名 / 難易度 / 定数 を確認してください。");
      }
      const res = await mergeMusicExOverrides(preview, force);
      // 楽曲データページの localStorage キャッシュを即座に更新
      if (musicExUrl) {
        try {
          await fetchMusicExJson(musicExUrl, { forceRefresh: true });
        } catch {
          // ignore — 定数反映自体はサーバ側で完了済み
        }
      }
      setMsg(`${res.upserted} 曲を反映しました（override 合計 ${res.override_count} 件）。レーティング対象を再読み込みしてください。`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="prose">
      <h1>譜面定数の入力</h1>
      <p className="muted">
        otoge-db に定数が入る前に、下へ表を貼り付けて送信するとサーバの override に即反映されます。
        docker cp は不要です。
      </p>
      <p className="muted">形式: <code>曲名[TAB]難易度[TAB]レベル[TAB]定数</code>（レベル列は省略可）</p>

      <div className="row" style={{ marginBottom: "0.5rem" }}>
        <button type="button" className="btn secondary" onClick={() => setText(EXAMPLE)}>
          例を入れる
        </button>
        <label className="theme-toggle" title="既存定数を強制上書き">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          <span className="theme-toggle-track" />
          <span className="theme-toggle-label">{force ? "強制上書き: ON" : "強制上書き: OFF"}</span>
        </label>
      </div>

      <textarea
        className="input"
        rows={12}
        style={{ width: "100%", fontFamily: "ui-monospace, monospace", resize: "vertical" }}
        placeholder={EXAMPLE}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      {preview.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: "1rem" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>BAS</th>
                <th>ADV</th>
                <th>EXP</th>
                <th>MAS</th>
                <th>LNT</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((s) => (
                <tr key={s.title}>
                  <td>{s.title}</td>
                  <td>{s.lev_bas_i ?? ""}</td>
                  <td>{s.lev_adv_i ?? ""}</td>
                  <td>{s.lev_exc_i ?? ""}</td>
                  <td>{s.lev_mas_i ?? ""}</td>
                  <td>{s.lev_lnt_i ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">プレビュー: まだ有効な行がありません。</p>
      )}

      <div className="row" style={{ marginTop: "1rem" }}>
        <button type="button" className="btn" disabled={busy || preview.length === 0} onClick={() => void onSubmit()}>
          {busy ? "送信中…" : `${preview.length} 曲をサーバへ反映`}
        </button>
      </div>
      {msg ? <p>{msg}</p> : null}
      {err ? <p className="error">{err}</p> : null}
    </article>
  );
}
