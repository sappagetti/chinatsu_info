import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { deleteAccount, fetchMe } from "../api";
import { useAuth } from "../auth/AuthContext";

export function AccountSettingsPage() {
  const { user, csrfToken, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const profileCardRef = useRef<HTMLElement | null>(null);
  const [profilePayload, setProfilePayload] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user?.ingest_token) return;
      try {
        const me = await fetchMe(user.ingest_token);
        if (cancelled) return;
        setProfilePayload((me.last_payload as Record<string, unknown> | null) ?? null);
      } catch {
        if (!cancelled) setProfilePayload(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.ingest_token]);

  const profile = useMemo(() => {
    const raw = profilePayload?.profile;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  }, [profilePayload]);

  const profileIcon = useMemo(() => {
    const raw = profilePayload?.profile_icon;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  }, [profilePayload]);

  const profileChara = useMemo(() => {
    const raw = profilePayload?.profile_chara;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  }, [profilePayload]);

  const mediaBase = useMemo(() => (import.meta.env.VITE_API_URL?.replace(/\/$/, "") ?? ""), []);
  const toAbsoluteMediaUrl = (v: unknown): string => {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith("/")) return `${mediaBase}${s}`;
    return s;
  };

  const charaBgUrl = toAbsoluteMediaUrl(profileChara?.local_url);
  const iconUrl = toAbsoluteMediaUrl(profileIcon?.local_url);

  const safeText = (v: unknown, fallback = "—") => {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) return fallback;
    if (/^エラーコード[:：]\s*\d+/.test(s)) return fallback;
    if (s.includes("再度ログインしてください")) return fallback;
    return s;
  };

  const onDelete = async () => {
    if (!window.confirm("本当に退会しますか？この操作は取り消せません。")) return;
    setBusy(true);
    try {
      await deleteAccount(csrfToken);
      setMsg("退会処理が完了しました。");
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "error");
    } finally {
      setBusy(false);
    }
  };

  const gameName = safeText(profile?.game_name, user?.display_name ?? "プレイヤー");
  const title = safeText(profile?.title, "称号未設定");
  const rating = safeText(profile?.rating);
  const level = safeText(profile?.level);
  const friendCode = safeText(profile?.friend_code);
  const comment = safeText(profile?.comment, "コメントなし");
  const sourceSite = "chinatsu.sappagetti.com";
  const legalNote = "非公式ファンサイト / 画像著作権: © SEGA";

  const onExportProfilePng = async () => {
    const el = profileCardRef.current;
    if (!el) return;
    setExportBusy(true);
    try {
      const { default: html2canvas } = await import("html2canvas");
      const now = new Date();
      const pad2 = (n: number) => String(n).padStart(2, "0");
      const timestamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
      const canvas = await html2canvas(el, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        backgroundColor: null,
        foreignObjectRendering: false,
        onclone: (clonedDoc) => {
          const clonedCard = clonedDoc.querySelector<HTMLElement>("[data-profile-card='true']");
          if (clonedCard) clonedCard.classList.add("profile-card-export-safe");
        },
      });
      await new Promise<void>((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error("JPEG の生成に失敗しました"));
              return;
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `chinatsu-profile-${timestamp}.png`;
            a.click();
            URL.revokeObjectURL(url);
            resolve();
          },
          "image/png",
        );
      });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <article className="prose">
      <h1>プロフィール</h1>
      <section
        ref={profileCardRef}
        data-profile-card="true"
        className="profile-card"
        style={charaBgUrl ? ({ "--profile-bg-url": `url("${charaBgUrl}")` } as CSSProperties) : undefined}
      >
        <div className="profile-card-overlay" />
        <div className="profile-card-glow" />
        <div className="profile-card-content">
          <header className="profile-card-head">
            <div className="profile-identity">
              <span className="profile-icon-wrap">
                {iconUrl ? (
                  <img src={iconUrl} alt="" className="profile-icon" loading="lazy" />
                ) : (
                  <span className="profile-icon placeholder" />
                )}
                <span className="profile-level-chip">Lv {level}</span>
              </span>
              <div className="profile-name-wrap">
                <p className="profile-game-name">{gameName}</p>
                <p className="profile-title">{title}</p>
              </div>
            </div>
          </header>

          <div className="profile-meta-grid">
            <div className="profile-meta-panel">
              <p className="profile-label">レーティング</p>
              <p className="profile-rating-value">{rating}</p>
            </div>
            <div className="profile-meta-panel">
              <p className="profile-label">フレンドコード</p>
              <p className="profile-code">{friendCode}</p>
            </div>
          </div>

          <p className="profile-comment">{comment}</p>
        </div>
        <div className="profile-card-footer">
          <p className="profile-site-mark">{sourceSite}</p>
          <p className="profile-site-note">{legalNote}</p>
        </div>
      </section>
      <p className="profile-card-export">
        <button
          className="btn secondary"
          type="button"
          disabled={exportBusy}
          onClick={() => void onExportProfilePng()}
        >
          {exportBusy ? "保存中…" : "プロフィールカードを PNG で保存"}
        </button>
      </p>
      <p>会員番号: <code>{user?.public_id ?? "-"}</code></p>
      <p>メール: <code>{user?.email}</code></p>
      <button className="btn" type="button" disabled={busy} onClick={() => void onDelete()}>
        退会する
      </button>
      {msg ? <p>{msg}</p> : null}
    </article>
  );
}
