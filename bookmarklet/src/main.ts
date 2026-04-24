/**
 * オンゲキNET (ongeki-net.com) 上で実行。
 * ingest トークン・API・譜面バケットURLはセットアップ画面で埋め込んだブックマークとして配布する。
 */

import { withElapsedLog } from "./elapsedLog";
import { ongekiDocumentReferer, ongekiMobileOrigin, runOngekiFetch } from "./ongekiFetch";

/** フロントの「ブックマーク用URL生成」で置換する（ビルド直後は未置換のまま） */
const INGEST_TOKEN = "%%%INGEST_TOKEN%%%";
const API_BASE = "%%%API_BASE%%%";
const BEATMAP_BUCKET_URL = "%%%BEATMAP_BUCKET_URL%%%";

const OVERLAY_ID = "rhythm-info-bm-overlay";
const FORCE_FULL_NEXT_KEY = "chinatsu-bookmarklet-force-full-next";

function isPlaceholderUnreplaced(): boolean {
  return (
    INGEST_TOKEN.includes("%%%") ||
    API_BASE.includes("%%%") ||
    BEATMAP_BUCKET_URL.includes("%%%")
  );
}

function defaultApiBase(): string {
  const w = window as unknown as { __RHYTHM_INFO_API__?: string };
  if (w.__RHYTHM_INFO_API__) return w.__RHYTHM_INFO_API__;
  return API_BASE.replace(/\/$/, "").trim() || "http://127.0.0.1:8080";
}

/**
 * BEATMAP_BUCKET_URL은 프런트 빌드 시 상대 경로(예: "/api/v1/music-ex.json")로 세팅될 수 있다.
 * 북마크렛은 ongeki-net.com 상에서 실행되므로, 상대 경로를 그대로 쓰면 ongeki-net.com 쪽으로
 * 요청이 가서 HTML 로그인/404 페이지가 돌아오고 JSON 파싱이 실패한다.
 * 여기서 API_BASE 기준으로 절대화해 우리 백엔드 쪽으로 분명히 향하게 한다.
 */
function resolveBeatmapBucketUrl(apiBase: string): string {
  const raw = BEATMAP_BUCKET_URL.trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    const baseTrimmed = apiBase.replace(/\/$/, "");
    return new URL(raw, `${baseTrimmed}/`).href;
  } catch {
    return raw;
  }
}

function ingestHeaders(apiBase: string, token: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  try {
    const host = new URL(apiBase, location.href).hostname.toLowerCase();
    if (host.includes("ngrok")) {
      h["ngrok-skip-browser-warning"] = "69420";
    }
  } catch {
    /* ignore */
  }
  return h;
}

function mixedContentBlocked(apiBase: string): boolean {
  if (location.protocol !== "https:") return false;
  try {
    const u = new URL(apiBase, location.href);
    return u.protocol === "http:";
  } catch {
    return false;
  }
}

function isOngekiNetPage(): boolean {
  return /\.ongeki-net\.com$/i.test(location.hostname);
}

function mixedContentMessage(apiBase: string): string {
  return [
    "通信エラーが発生しました。API 接続先が HTTPS か確認してください。",
    "問題が続く場合は運営者へお問い合わせください。",
    `現在の API: ${apiBase}`,
  ].join("\n");
}

type PrevMeResponse = {
  last_payload?: PrevPayload | null;
};

type PrevPayload = {
  scores?: unknown[];
  profile?: PlayerProfilePayload | null;
  profile_icon?: ProfileIconPayload | null;
  profile_chara?: ProfileCharaPayload | null;
};

type ProfileIconPayload = {
  icon_key: string;
  icon_url: string;
  icon_data_url: string;
  collected_at: string;
};

type ProfileCharaPayload = {
  chara_key: string;
  chara_url: string;
  chara_data_url: string;
  collected_at: string;
};

type PlayerProfilePayload = {
  game_name?: string;
  title?: string;
  level?: string;
  rating?: string;
  comment?: string;
  friend_code?: string;
  collected_at: string;
};

type FriendProfilePayload = {
  game_name?: string;
  title?: string;
  comment?: string;
  friend_code?: string;
};

function extractIconKeyFromUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl, location.href);
    const file = (u.pathname.split("/").pop() ?? "").trim();
    if (/^[A-Za-z0-9._-]+\.(png|jpg|jpeg|webp|gif)$/i.test(file)) return file;
    return null;
  } catch {
    return null;
  }
}

function resolveImgUrl(img: HTMLImageElement): string {
  const data =
    img.getAttribute("data-src") ||
    img.getAttribute("data-original") ||
    img.getAttribute("data-lazy-src") ||
    "";
  const src = (img.getAttribute("src") || "").trim();
  if (src && !src.startsWith("data:") && src !== "about:blank") return img.src || src;
  return data.trim();
}

function findSelectedIconSrc(doc: Document): string | null {
  const charaIconSel =
    "img[src*='/img/chara/icon/'], img[src*='img/chara/icon/'], img[data-src*='/img/chara/icon/'], img[data-src*='img/chara/icon/']";
  for (const el of doc.querySelectorAll(charaIconSel)) {
    const u = resolveImgUrl(el as HTMLImageElement);
    if (u && (u.includes("/img/chara/icon/") || u.includes("img/chara/icon/"))) return u;
  }
  const portalIconSel =
    "img[src*='/img/icon/'], img[src*='img/icon/'], img[data-src*='/img/icon/'], img[data-src*='img/icon/']";
  for (const el of doc.querySelectorAll(portalIconSel)) {
    const u = resolveImgUrl(el as HTMLImageElement);
    if (!u) continue;
    if (u.includes("/img/chara/") || u.includes("img/chara/")) continue;
    if (u.includes("/img/icon/") || u.includes("img/icon/")) return u;
  }
  return null;
}

function findSelectedCharaSrc(doc: Document): string | null {
  const imgs = doc.querySelectorAll(
    "img[src*='/img/chara/'], img[src*='img/chara/'], img[data-src*='/img/chara/'], img[data-src*='img/chara/']",
  );
  for (const el of imgs) {
    const raw = resolveImgUrl(el as HTMLImageElement);
    if (!raw) continue;
    if (raw.includes("/img/chara/icon/") || raw.includes("img/chara/icon/")) continue;
    return raw;
  }
  return null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("icon FileReader result is not a string"));
    };
    reader.onerror = () => reject(new Error("icon FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

function cleanOneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function formatSyncError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function describeDocForDebug(doc: Document, bodyMax = 320): string {
  const title = cleanOneLine(doc.title || "");
  const body = cleanOneLine(doc.body?.textContent ?? "");
  const preview = body.length > bodyMax ? `${body.slice(0, bodyMax)}…` : body;
  return `title="${title}" preview="${preview}"`;
}

function assertOngekiHtmlResponse(pageLabel: string, res: Response, doc: Document): void {
  if (!res.ok) {
    throw new Error(`${pageLabel} fetch failed | HTTP ${res.status} | ${describeDocForDebug(doc)}`);
  }
  if (isErrorLikePage(doc)) {
    throw new Error(`${pageLabel} is error state | HTTP ${res.status} | ${describeDocForDebug(doc)}`);
  }
}

function isErrorLikePage(doc: Document): boolean {
  const title = cleanOneLine(doc.title || "");
  const body = cleanOneLine(doc.body?.textContent ?? "");
  if (title.includes("エラー")) return true;
  if (/エラーコード[:：]\s*\d+/.test(body)) return true;
  if (body.includes("再度ログインしてください")) {
    return title.includes("エラー") || /エラーコード[:：]\s*\d+/.test(body);
  }
  return false;
}

function extractRating(text: string): string | undefined {
  const m = text.match(/RATING\s*([0-9]+(?:\.[0-9]+)?)/i);
  return m?.[1];
}

function extractFriendCode(text: string): string | undefined {
  const compact = text.replace(/\s+/g, "");
  const m = compact.match(/([0-9]{12,16})/);
  return m?.[1];
}

function findValueByLabel(doc: Document, labels: string[]): string | undefined {
  const all = Array.from(doc.querySelectorAll("div,span,p,li,td,th"));
  for (const el of all) {
    const t = cleanOneLine(el.textContent ?? "");
    if (!t) continue;
    for (const label of labels) {
      if (!t.includes(label)) continue;
      const v = cleanOneLine(t.replace(label, "").replace(/^[:：\s-]+/, ""));
      if (v && v !== t) return v;
    }
  }
  return undefined;
}

function findGameName(doc: Document): string | undefined {
  const img = doc.querySelector("img[src*='/img/chara/icon/'], img[src*='img/chara/icon/']") as HTMLImageElement | null;
  if (img) {
    const alt = cleanOneLine(img.alt || "");
    if (alt) return alt;
    const parentText = cleanOneLine(img.parentElement?.textContent ?? "");
    if (parentText) return parentText;
  }
  const candidates = Array.from(doc.querySelectorAll("div,span,p"))
    .map((el) => cleanOneLine(el.textContent ?? ""))
    .filter(Boolean)
    .filter((t) => t.length <= 24 && /^[^\d\s][\s\S]*$/.test(t));
  return candidates[0];
}

async function fetchProfileIconPayloadFromSrc(
  src: string,
  resolveBase: string,
  imageReferer: string,
  log: (m: string) => void,
): Promise<ProfileIconPayload | null> {
  const iconUrl = new URL(src, resolveBase).toString();
  const iconKey = extractIconKeyFromUrl(iconUrl);
  if (!iconKey) {
    log("アイコンキーを抽出できませんでした。");
    return null;
  }
  log("アイコン画像を取得しています…");
  const imgRes = await fetch(iconUrl, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      Referer: imageReferer,
    },
  });
  if (!imgRes.ok) {
    throw new Error(`icon image fetch failed: ${imgRes.status}`);
  }
  const blob = await imgRes.blob();
  const dataUrl = await blobToDataUrl(blob);
  return {
    icon_key: iconKey,
    icon_url: iconUrl,
    icon_data_url: dataUrl,
    collected_at: new Date().toISOString(),
  };
}

async function tryProfileIconFromPlayerDataDetailDoc(
  doc: Document,
  log: (m: string) => void,
): Promise<ProfileIconPayload | null> {
  const detailUrl = `${ongekiMobileOrigin()}/ongeki-mobile/home/playerDataDetail/`;
  log("現在のアイコン情報を確認しています（playerDataDetail）…");
  const src = findSelectedIconSrc(doc);
  if (!src) return null;
  return fetchProfileIconPayloadFromSrc(src, detailUrl, detailUrl, log);
}

async function fetchCurrentProfileIcon(log: (m: string) => void): Promise<ProfileIconPayload | null> {
  const origin = ongekiMobileOrigin();
  const iconPageUrl = `${origin}/ongeki-mobile/cardMaker/icon/`;
  log("現在のアイコン情報を確認しています…");
  const iconPageRes = await fetch(iconPageUrl, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
      Referer: ongekiDocumentReferer(),
    },
  });
  const html = await iconPageRes.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  assertOngekiHtmlResponse("icon page", iconPageRes, doc);
  const src = findSelectedIconSrc(doc);
  if (!src) {
    log("現在のアイコンを取得できませんでした。");
    return null;
  }
  return fetchProfileIconPayloadFromSrc(src, iconPageUrl, iconPageUrl, log);
}

async function fetchPlayerDataDetailDocument(log: (m: string) => void): Promise<Document> {
  const origin = ongekiMobileOrigin();
  const url = `${origin}/ongeki-mobile/home/playerDataDetail/`;
  log("プレイヤー詳細ページを取得しています…");
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
      Referer: ongekiDocumentReferer(),
    },
  });
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  assertOngekiHtmlResponse("playerDataDetail page", res, doc);
  return doc;
}

/**
 * ongeki-score getScore.ts の PlayerData.parsePlayerData と同じ DOM 前提。
 * @see https://github.com/project-primera/ongeki-score
 */
function extractPlayerProfileFromPlayerDataDetailDoc(
  doc: Document,
  log: (m: string) => void,
): PlayerProfilePayload {
  log("プレイヤープロフィールを確認しています（playerDataDetail）…");
  const trophyEl = doc.querySelector(".trophy_block span");
  const title = trophyEl ? cleanOneLine(trophyEl.textContent ?? "") : undefined;
  const nameEl = doc.querySelector(".name_block span");
  const gameName = nameEl ? cleanOneLine(nameEl.textContent ?? "") : undefined;

  const lvSpan = doc.querySelector(".lv_block span");
  const reinSpan = doc.querySelector(".reincarnation_block span");
  const baseLv = lvSpan ? Number.parseInt(cleanOneLine(lvSpan.textContent ?? ""), 10) : NaN;
  const rein = reinSpan ? Number.parseInt(cleanOneLine(reinSpan.textContent ?? ""), 10) : 0;
  let level: string | undefined;
  if (Number.isFinite(baseLv) && baseLv >= 0) {
    const reinPart = Number.isFinite(rein) && rein > 0 ? rein * 100 : 0;
    level = String(baseLv + reinPart);
  }

  const ratingField = doc.querySelector(".rating_new_block .rating_field");
  let rating: string | undefined;
  if (ratingField) {
    const ratingEl = ratingField.querySelector("[class^='rating_']");
    const t = ratingEl ? cleanOneLine(ratingEl.textContent ?? "") : "";
    if (t) rating = t;
  }
  if (!rating) {
    const whole = cleanOneLine(doc.body?.textContent ?? "");
    rating = extractRating(whole);
  }

  const cb = doc.querySelector(".comment_block");
  let comment: string | undefined;
  if (cb?.parentElement) {
    comment = cleanOneLine(cb.parentElement.textContent ?? "").replace(/\t/g, " ");
  }

  return {
    game_name: gameName || undefined,
    title: title || undefined,
    level,
    rating,
    comment: comment || undefined,
    collected_at: new Date().toISOString(),
  };
}

function mergeFriendProfileIntoPlayer(
  playerProfile: PlayerProfilePayload | null,
  friendProfile: FriendProfilePayload | null,
): PlayerProfilePayload | null {
  if (!friendProfile) return playerProfile;
  const baseCollected = playerProfile?.collected_at ?? new Date().toISOString();
  return {
    ...(playerProfile ?? { collected_at: baseCollected }),
    ...(friendProfile.game_name ? { game_name: friendProfile.game_name } : {}),
    ...(friendProfile.title ? { title: friendProfile.title } : {}),
    ...(friendProfile.comment ? { comment: friendProfile.comment } : {}),
    ...(friendProfile.friend_code ? { friend_code: friendProfile.friend_code } : {}),
  };
}

async function fetchPlayerProfileViaDetailAndFriend(
  syncLog: (m: string) => void,
  elapsedLabel: string,
): Promise<{ playerProfile: PlayerProfilePayload | null; detailDoc: Document | null }> {
  let playerProfile: PlayerProfilePayload | null = null;
  let detailDoc: Document | null = null;
  try {
    detailDoc = await withElapsedLog(syncLog, elapsedLabel, () =>
      fetchPlayerDataDetailDocument(syncLog),
    );
    playerProfile = extractPlayerProfileFromPlayerDataDetailDoc(detailDoc, syncLog);
    syncLog("プロフィール（playerDataDetail）: 解析しました。");
  } catch (e) {
    syncLog("プロフィール（playerDataDetail）: 取得できませんでした（同期は続行します）。");
    syncLog(`詳細: ${formatSyncError(e)}`);
  }
  try {
    const friendProfile = await withElapsedLog(syncLog, "フレンドプロフィール取得", () =>
      fetchFriendProfile(syncLog),
    );
    playerProfile = mergeFriendProfileIntoPlayer(playerProfile, friendProfile);
    if (friendProfile) {
      syncLog("フレンドコード情報: 取得できました。");
    } else {
      syncLog("フレンドコード情報: 見つかりませんでした。");
    }
  } catch (e) {
    syncLog("フレンドコード情報: 取得できませんでした（同期は続行します）。");
    syncLog(`詳細: ${formatSyncError(e)}`);
  }
  return { playerProfile, detailDoc };
}

async function extractProfileCharaFromPlayerDataDetailDoc(
  doc: Document,
  log: (m: string) => void,
): Promise<ProfileCharaPayload | null> {
  const detailUrl = `${ongekiMobileOrigin()}/ongeki-mobile/home/playerDataDetail/`;
  log("現在のキャラクター情報を確認しています…");
  const src = findSelectedCharaSrc(doc);
  if (!src) {
    log("現在のキャラクターを取得できませんでした。");
    return null;
  }
  const charaUrl = new URL(src, detailUrl).toString();
  const charaKey = extractIconKeyFromUrl(charaUrl);
  if (!charaKey) {
    log("キャラクターキーを抽出できませんでした。");
    return null;
  }
  log("キャラクター画像を取得しています…");
  const imgRes = await fetch(charaUrl, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      Referer: detailUrl,
    },
  });
  if (!imgRes.ok) {
    throw new Error(`chara image fetch failed: ${imgRes.status}`);
  }
  const blob = await imgRes.blob();
  const dataUrl = await blobToDataUrl(blob);
  return {
    chara_key: charaKey,
    chara_url: charaUrl,
    chara_data_url: dataUrl,
    collected_at: new Date().toISOString(),
  };
}

async function fetchUserComment(log: (m: string) => void): Promise<string | undefined> {
  const origin = ongekiMobileOrigin();
  const commentUrl = `${origin}/ongeki-mobile/home/userOption/updateUserComment/`;
  log("コメント情報を確認しています…");
  const res = await fetch(commentUrl, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
      Referer: ongekiDocumentReferer(),
    },
  });
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  assertOngekiHtmlResponse("comment page", res, doc);
  const ta = doc.querySelector("textarea[name='comment']") as HTMLTextAreaElement | null;
  const v = cleanOneLine(ta?.value ?? ta?.textContent ?? "");
  return v || undefined;
}

function extractDigits(text: string): string | undefined {
  const m = text.replace(/\s+/g, "").match(/([0-9]{10,20})/);
  return m?.[1];
}

function readText(el: Element | null): string | undefined {
  if (!el) return undefined;
  const t = cleanOneLine(el.textContent ?? "");
  return t || undefined;
}

async function fetchFriendProfile(log: (m: string) => void): Promise<FriendProfilePayload | null> {
  const origin = ongekiMobileOrigin();
  const url = `${origin}/ongeki-mobile/friend/userFriendCode/`;
  log("フレンドコード情報を確認しています…");
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
      Referer: ongekiDocumentReferer(),
    },
  });
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  assertOngekiHtmlResponse("friend page", res, doc);

  const friendCodeRaw = readText(doc.querySelector(".friendcode_block")) ?? "";
  const friendCode = extractDigits(friendCodeRaw);
  const title = readText(doc.querySelector(".friend_trophy_block span"));
  const gameName = readText(doc.querySelector(".friend_name_block span"));
  const comment = readText(doc.querySelector(".border_block"));

  return {
    game_name: gameName,
    title,
    comment,
    friend_code: friendCode,
  };
}

function scoreRowKey(row: Record<string, unknown>): string {
  const dif = String(row.difficulty ?? "").trim();
  const musicExID = String(row.music_ex_id ?? "").trim();
  if (musicExID) return `id::${musicExID}::${dif}`;
  const name = String(row.name ?? "").trim();
  const level = String(row.level ?? "").trim();
  return `${name}::${dif}::${level}`;
}

function scoreRowSignature(row: Record<string, unknown>): string {
  return [
    row.technicalHighScore ?? 0,
    row.overDamageHighScore ?? 0,
    row.battleHighScore ?? 0,
    row.fullBell ?? false,
    row.fullCombo ?? false,
    row.allBreak ?? false,
    row.platinumHighScore ?? 0,
    row.platinumStar ?? 0,
    row.platinumMaxScore ?? 0,
  ].join("|");
}

function diffScoreCount(currentRows: unknown[], previousRows: unknown[]): number {
  const prevMap = new Map<string, string>();
  for (const v of previousRows) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const row = v as Record<string, unknown>;
    prevMap.set(scoreRowKey(row), scoreRowSignature(row));
  }
  let changed = 0;
  for (const v of currentRows) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const row = v as Record<string, unknown>;
    const key = scoreRowKey(row);
    if (prevMap.get(key) !== scoreRowSignature(row)) changed += 1;
  }
  return changed;
}

function changedScoreRows(currentRows: unknown[], previousRows: unknown[]): unknown[] {
  const prevMap = new Map<string, string>();
  for (const v of previousRows) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const row = v as Record<string, unknown>;
    prevMap.set(scoreRowKey(row), scoreRowSignature(row));
  }
  const changed: unknown[] = [];
  for (const v of currentRows) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const row = v as Record<string, unknown>;
    const key = scoreRowKey(row);
    if (prevMap.get(key) !== scoreRowSignature(row)) changed.push(v);
  }
  return changed;
}

async function fetchPreviousPayload(apiBase: string, token: string): Promise<PrevPayload | null> {
  const base = apiBase.replace(/\/$/, "").trim();
  const url = `${base}/api/v1/me`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;
  const me = (await res.json()) as PrevMeResponse;
  return me.last_payload ?? null;
}

function normalizeProfileForCompare(profile: PlayerProfilePayload | null | undefined): string {
  if (!profile) return "";
  return JSON.stringify({
    game_name: profile.game_name ?? "",
    title: profile.title ?? "",
    level: profile.level ?? "",
    rating: profile.rating ?? "",
    comment: profile.comment ?? "",
    friend_code: profile.friend_code ?? "",
  });
}

function normalizeIconForCompare(icon: ProfileIconPayload | null | undefined): string {
  if (!icon) return "";
  return JSON.stringify({
    icon_key: icon.icon_key ?? "",
    icon_url: icon.icon_url ?? "",
    icon_data_url: icon.icon_data_url ?? "",
  });
}

function normalizeCharaForCompare(chara: ProfileCharaPayload | null | undefined): string {
  if (!chara) return "";
  return JSON.stringify({
    chara_key: chara.chara_key ?? "",
    chara_url: chara.chara_url ?? "",
    chara_data_url: chara.chara_data_url ?? "",
  });
}

async function postIngest(apiBase: string, token: string, body: unknown) {
  const base = apiBase.replace(/\/$/, "").trim();
  const url = `${base}/api/v1/ingest`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: ingestHeaders(base, token),
      body: JSON.stringify(body),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    let hint = "";
    if (mixedContentBlocked(apiBase)) {
      hint = `\n\n${mixedContentMessage(apiBase)}`;
    }
    throw new Error(`サーバーへ接続できませんでした: ${msg}${hint}`);
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`ingest ${res.status}: ${t}`);
  }
}

function showProgressOverlay(): { log: (m: string) => void; close: () => void } {
  const existing = document.getElementById(OVERLAY_ID);
  existing?.remove();

  const root = document.createElement("div");
  root.id = OVERLAY_ID;
  root.style.cssText =
    "position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,0.35);font-family:system-ui,sans-serif;padding:16px;box-sizing:border-box;";
  const panel = document.createElement("div");
  panel.style.cssText =
    "max-width:520px;margin:40px auto;background:#171a21;color:#e8eaed;border:1px solid #2a3140;border-radius:12px;padding:12px 14px;max-height:85vh;display:flex;flex-direction:column;";
  const title = document.createElement("div");
  title.textContent = "Chinatsu Info — 取得ログ";
  title.style.cssText = "font-weight:600;margin-bottom:8px;";
  const ta = document.createElement("textarea");
  ta.readOnly = true;
  ta.style.cssText =
    "width:100%;flex:1;min-height:200px;background:#0f1115;color:#e8eaed;border:1px solid #2a3140;border-radius:8px;padding:8px;font-size:12px;resize:vertical;";
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "margin-top:10px;text-align:right;";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "閉じる";
  closeBtn.style.cssText =
    "cursor:pointer;border:1px solid #2a3140;border-radius:8px;padding:6px 12px;background:#171a21;color:#e8eaed;";
  const lines: string[] = [];
  const log = (m: string) => {
    lines.push(`${new Date().toLocaleTimeString()} ${m}`);
    ta.value = lines.join("\n");
    ta.scrollTop = ta.scrollHeight;
  };
  const close = () => {
    root.remove();
  };
  closeBtn.addEventListener("click", close);
  btnRow.appendChild(closeBtn);
  panel.appendChild(title);
  panel.appendChild(ta);
  panel.appendChild(btnRow);
  root.appendChild(panel);
  document.documentElement.appendChild(root);
  return { log, close };
}

void (async () => {
  if (isPlaceholderUnreplaced()) {
    window.alert(
      "このブックマークは未設定です。インフォサイトのセットアップで「ブックマーク用URL」をコピーし、ブックマークを作り直してください。",
    );
    return;
  }

  if (!/ongeki-net\.com$/i.test(location.hostname)) {
    window.alert("オンゲキNET (ongeki-net.com) のページで実行してください。");
    return;
  }

  const apiBase = defaultApiBase();
  const { log } = showProgressOverlay();
  const syncLog = (m: string) => {
    void log(m);
  };
  const shouldForceFullNext = localStorage.getItem(FORCE_FULL_NEXT_KEY) === "1";

  try {
    if (mixedContentBlocked(apiBase)) {
      throw new Error(mixedContentMessage(apiBase));
    }
    let previousScores: unknown[] = [];
    let previousPayload: PrevPayload | null = null;
    if (!shouldForceFullNext) {
      try {
        previousPayload = await withElapsedLog(syncLog, "前回データ確認", () =>
          fetchPreviousPayload(apiBase, INGEST_TOKEN),
        );
        const scores = previousPayload?.scores;
        previousScores = Array.isArray(scores) ? scores : [];
      } catch {
        // 前回比較は最適化目的。失敗しても通常同期は続行。
      }
    } else {
      syncLog("前回差分送信後のため、今回は全データを送信します。");
    }
    const firstDetailFetch = await fetchPlayerProfileViaDetailAndFriend(
      syncLog,
      "プレイヤー詳細取得（先行）",
    );
    let playerProfile: PlayerProfilePayload | null = firstDetailFetch.playerProfile;
    const detailDocForChara = firstDetailFetch.detailDoc;

    const { rows, userDatas, musicCatalog, musicCatalogMeta } = await runOngekiFetch(
      syncLog,
      resolveBeatmapBucketUrl(apiBase),
    );
    let profileIcon: ProfileIconPayload | null = null;
    try {
      profileIcon = await withElapsedLog(syncLog, "プロフィールアイコン取得", async () => {
        if (detailDocForChara) {
          const fromDetail = await tryProfileIconFromPlayerDataDetailDoc(detailDocForChara, syncLog);
          if (fromDetail) return fromDetail;
        }
        return fetchCurrentProfileIcon(syncLog);
      });
      syncLog(profileIcon ? "アイコン情報: 取得できました。" : "アイコン情報: 見つかりませんでした。");
    } catch (e) {
      syncLog("アイコン情報: 取得できませんでした（同期は続行します）。");
      syncLog(`詳細: ${formatSyncError(e)}`);
    }
    let profileChara: ProfileCharaPayload | null = null;
    if (detailDocForChara) {
      try {
      profileChara = await withElapsedLog(syncLog, "プロフィールキャラクター取得", () =>
        extractProfileCharaFromPlayerDataDetailDoc(detailDocForChara, syncLog),
      );
      syncLog(profileChara ? "キャラクター画像: 取得できました。" : "キャラクター画像: 見つかりませんでした。");
      } catch (e) {
        syncLog("キャラクター画像: 取得できませんでした（同期は続行します）。");
        syncLog(`詳細: ${formatSyncError(e)}`);
      }
    }
    if (!playerProfile) {
      const retried = await fetchPlayerProfileViaDetailAndFriend(
        syncLog,
        "プレイヤー詳細取得（再試行）",
      );
      playerProfile = retried.playerProfile;
    }
    if (playerProfile && !playerProfile.comment?.trim()) {
      try {
        const comment = await withElapsedLog(syncLog, "プレイヤーコメント取得", () =>
          fetchUserComment(syncLog),
        );
        if (comment) {
          playerProfile = { ...playerProfile, comment };
          syncLog("コメント: 取得できました。");
        } else {
          syncLog("コメント: 見つかりませんでした。");
        }
      } catch (e) {
        syncLog("コメント: 取得できませんでした（同期は続行します）。");
        syncLog(`詳細: ${formatSyncError(e)}`);
      }
    }
    const profileChanged =
      normalizeProfileForCompare(playerProfile) !== normalizeProfileForCompare(previousPayload?.profile);
    const iconChanged =
      normalizeIconForCompare(profileIcon) !== normalizeIconForCompare(previousPayload?.profile_icon);
    const charaChanged =
      normalizeCharaForCompare(profileChara) !== normalizeCharaForCompare(previousPayload?.profile_chara);
    const profileRelatedChanged = profileChanged || iconChanged || charaChanged;

    if (previousScores.length > 0) {
      const changed = diffScoreCount(rows as unknown[], previousScores);
      if (changed === 0 && !profileRelatedChanged) {
        syncLog("更新が見つからなかったため、送信を省略しました。");
        syncLog("取得ログは「閉じる」ボタンで閉じてください。");
        window.alert("差分がないため送信をスキップしました。");
        return;
      }
      if (changed > 0) {
        syncLog(`更新データを確認しました（${changed}件）。`);
      }
      if (profileRelatedChanged) {
        syncLog("プロフィール関連の更新を確認しました。");
      }
    }
    const scoreChangedRows =
      previousScores.length > 0 ? changedScoreRows(rows as unknown[], previousScores) : (rows as unknown[]);
    const changedRows =
      previousScores.length > 0 && profileRelatedChanged && scoreChangedRows.length === 0
        ? rows
        : scoreChangedRows;
    if (previousScores.length > 0) {
      syncLog(`更新分のみ送信します（${changedRows.length}/${rows.length}件）。`);
    }
    const payload = {
      source: "chinatsu-bookmarklet",
      collected_at: new Date().toISOString(),
      page_url: location.href,
      row_count: changedRows.length,
      total_row_count: rows.length,
      full_snapshot: previousScores.length === 0,
      user_score_count: userDatas.length,
      /** CSV相当の行配列（拡張の combineDatas 相当） */
      scores: changedRows,
      ...(profileIcon ? { profile_icon: profileIcon } : {}),
      ...(profileChara ? { profile_chara: profileChara } : {}),
      ...(playerProfile ? { profile: playerProfile } : {}),
      ...(musicCatalog && musicCatalogMeta
        ? {
            music_catalog: musicCatalog,
            music_catalog_meta: musicCatalogMeta,
          }
        : {}),
    };
    syncLog("サーバーへ送信しています…");
    await withElapsedLog(syncLog, "ingest 送信", () =>
      postIngest(apiBase, INGEST_TOKEN, payload),
    );
    if (previousScores.length > 0) {
      localStorage.setItem(FORCE_FULL_NEXT_KEY, "1");
    } else {
      localStorage.removeItem(FORCE_FULL_NEXT_KEY);
    }
    syncLog("送信が完了しました。");
    syncLog("取得ログは「閉じる」ボタンで閉じてください。");
    window.alert("送信しました。インフォサイトのダッシュボードを更新してください。");
  } catch (e) {
    void log(e instanceof Error ? e.message : String(e));
    void log("取得ログは「閉じる」ボタンで閉じてください。");
    window.alert(e instanceof Error ? e.message : String(e));
  }
})();
