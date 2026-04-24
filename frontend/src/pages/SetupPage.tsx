// 토큰 발행 + 토큰이 포함된 북마크 URL 생성
import { useCallback, useEffect, useMemo, useState } from "react";
import { createBookmarkletSession, getBookmarkletSession } from "../api";
import { useAuth } from "../auth/AuthContext";
import {
  buildShortBookmarkletLoaderUrl,
} from "../embedBookmarklet";

function formatDateTime(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function selectUrlForManualCopy(url: string) {
  const ta = document.getElementById("bookmarklet-url-box") as HTMLTextAreaElement | null;
  if (ta) {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    return;
  }
  // Fallback for mobile timing cases where the visible textarea is not mounted yet.
  const temp = document.createElement("textarea");
  temp.value = url;
  temp.setAttribute("readonly", "true");
  temp.style.position = "fixed";
  temp.style.opacity = "0";
  temp.style.pointerEvents = "none";
  document.body.appendChild(temp);
  temp.focus();
  temp.select();
  temp.setSelectionRange(0, temp.value.length);
  document.body.removeChild(temp);
}

function toFriendlyBookmarkErrorMessage(raw: string): string {
  const msg = raw.trim();
  if (/429/.test(msg) || /too many/i.test(msg) || /rate limit/i.test(msg)) {
    return "短時間に連続で発行されました。しばらく待ってから、もう一度お試しください。";
  }
  if (/cooldown/i.test(msg) || /reissue/i.test(msg)) {
    return "再発行まで少し時間が必要です。現在のブックマークURLをお使いください。";
  }
  return msg || "ブックマークURLの発行に失敗しました。時間をおいて再度お試しください。";
}

export function SetupPage() {
  const [bmErr, setBmErr] = useState<string | null>(null);
  const [bundleLoaded, setBundleLoaded] = useState(false);
  const [shortUrl, setShortUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [shortBusy, setShortBusy] = useState(false);
  const [shortErr, setShortErr] = useState<string | null>(null);
  const { user } = useAuth();
  const token = user?.ingest_token ?? "";

  /** ブックマークレットに埋め込む API ベース（オンゲキNET=HTTPS 側から届く必要あり） */
  const bookmarkletApiBase = useMemo(() => {
    const bm = (import.meta.env.VITE_BOOKMARKLET_API_URL || "").trim();
    if (bm) return bm.replace(/\/$/, "");
    const u = (import.meta.env.VITE_API_URL || "").trim();
    if (u) return u.replace(/\/$/, "");
    return `${window.location.protocol}//${window.location.host}`;
  }, []);

  const beatmapBucketUrl = useMemo(
    () => (import.meta.env.VITE_BEATMAP_BUCKET_URL || "").replace(/\/$/, ""),
    [],
  );

  /** API ベース가 https 인지 점검 */
  const bookmarkletNeedsHttpsApi = useMemo(() => {
    try {
      return new URL(bookmarkletApiBase, window.location.href).protocol === "http:";
    } catch {
      return false;
    }
  }, [bookmarkletApiBase]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        // 존재 확인만 하면 충분하다. 실제 스크립트 본문은 브라우저가 북마클릿 로더에서 다시 받는다.
        const res = await fetch("/bookmarklet.iife.js", { method: "HEAD", cache: "no-store" });
        if (!res.ok) {
          throw new Error(`bookmarklet.iife.js: ${res.status}`);
        }
        if (!cancelled) setBundleLoaded(true);
      } catch (e) {
        if (!cancelled) {
          setBmErr(e instanceof Error ? e.message : String(e));
          setBundleLoaded(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await getBookmarkletSession(token);
        if (cancelled) return;
        setExpiresAt(s.expires_at);
        if (s.has_active && s.bookmarklet_session_id) {
          setShortUrl(buildShortBookmarkletLoaderUrl(bookmarkletApiBase, s.bookmarklet_session_id));
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, bookmarkletApiBase]);

  const copyShortBookmarklet = useCallback(async () => {
    if (!token) return;
    if (!bookmarkletApiBase.startsWith("https:")) {
      window.alert("ブックマークURL発行に失敗しました。サービスの HTTPS 設定を確認してください。");
      return;
    }
    setShortBusy(true);
    setShortErr(null);
    try {
      const { bookmarklet_session_id } = await createBookmarkletSession(
        token,
        bookmarkletApiBase,
        beatmapBucketUrl,
      );
      const latest = await getBookmarkletSession(token);
      const url = buildShortBookmarkletLoaderUrl(bookmarkletApiBase, bookmarklet_session_id);
      setShortUrl(url);
      setExpiresAt(latest.expires_at);
      try {
        await navigator.clipboard.writeText(url);
        window.alert("ブックマークURLをコピーしました（有効約15分）。");
      } catch {
        selectUrlForManualCopy(url);
        window.alert("この端末では自動コピーできないため、URLを選択しました。コピーしてください。");
      }
    } catch (e) {
      const msg = toFriendlyBookmarkErrorMessage(e instanceof Error ? e.message : String(e));
      setShortErr(msg);
      window.alert(msg);
    } finally {
      setShortBusy(false);
    }
  }, [token, bookmarkletApiBase, beatmapBucketUrl]);

  return (
    <article className="prose">
      <h1>ブックマーク</h1>
      {token ? (
        <>
          <h2>ブックマークレット</h2>
          <p className="muted">
            このページで発行したURLをブックマークとして登録し、オンゲキNET上で実行してデータを同期します。
          </p>
          <h3>PCでの使い方</h3>
          <ol>
            <li>「ブックマークURLをコピー」を押します。</li>
            <li>ブラウザで新しいブックマークを作成し、コピーしたURLを貼り付けます。</li>
            <li>オンゲキNETのページで、そのブックマークを実行します。</li>
          </ol>
          <h3>スマートフォンでの使い方（Safari / Chrome）</h3>
          <ol>
            <li>このページで「ブックマークURLをコピー」を押します。</li>
            <li>Safari または Chrome で適当なページをブックマーク登録します（名前は自由でOK）。</li>
            <li>作成したブックマークを編集し、URL欄をコピーしたブックマークURLに置き換えます。</li>
            <li>オンゲキNETを開いた状態で、そのブックマークをタップして実行します。</li>
          </ol>
          <p className="muted">
            うまく動かない場合は、ブックマーク編集画面でもう一度URL全体を貼り直してください。
            ブラウザによっては先頭の <code>javascript:</code> が自動で消えることがあります。
          </p>
          <p className="muted">
            ※ アドレスバーに直接貼り付けると先頭の <code>javascript:</code> が消える場合があります。
            その場合は先頭に <code>javascript:</code> を手入力してください。
          </p>
          <p>ブックマークレットはオンゲキNET上で実行してください。通信に失敗する場合はサービス運営へお問い合わせください。</p>
          {bookmarkletNeedsHttpsApi && (
            <p className="error">
              現在の設定では API が HTTPS ではありません。運営設定を確認してください。
            </p>
          )}
          {bmErr && <p className="error">{bmErr}</p>}
          {!bundleLoaded && !bmErr && <p className="muted">ブックマーク用スクリプトを読み込み中…</p>}
          {bundleLoaded && (
            <>
              <h3>ブックマークURL</h3>
              <p className="muted">
                発行したURLは一定時間で失効します。失効した場合は再発行してください。
              </p>
              <p>
                <button type="button" className="btn" disabled={shortBusy} onClick={copyShortBookmarklet}>
                  {shortBusy ? "発行中…" : "ブックマークURLをコピー"}
                </button>
              </p>
              {shortErr && <p className="error">{shortErr}</p>}
              {expiresAt && <p className="muted">現在のブックマーク有効期限: {formatDateTime(expiresAt)}</p>}
              {shortUrl && (
                <textarea
                  id="bookmarklet-url-box"
                  className="json"
                  readOnly
                  rows={2}
                  value={shortUrl}
                  style={{ width: "100%", fontSize: "11px" }}
                />
              )}
            </>
          )}
        </>
      ) : (
        <p className="error">ログイン情報を読み込めませんでした。</p>
      )}
    </article>
  );
}
