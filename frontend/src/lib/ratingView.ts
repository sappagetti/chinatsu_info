/**
 * 인제스트 JSON에서 스코어 배열을 꺼내고, 레이팅 참고용으로 쓸 정렬·필터를 한다.
 * 게임 공식의 '레이팅 대상'과 1:1로 일치하지 않을 수 있음（定数·バージョンはGCSが取れた場合のみ有効）.
 */

import type { IngestScoreRow, MusicExTrack } from "../types/ingestPayload";
const JACKET_BASE = (import.meta.env.VITE_JACKET_BASE_URL ?? "").trim();

function buildInternalJacketUrl(fileName: string): string {
  const safe = fileName.trim();
  if (!safe) return "";
  if (JACKET_BASE) return `${JACKET_BASE.replace(/\/$/, "")}/${safe}`;
  const apiBase = (import.meta.env.VITE_API_URL ?? "").trim().replace(/\/$/, "");
  if (apiBase) return `${apiBase}/api/v1/jacket/${safe}`;
  return `/api/v1/jacket/${safe}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** last_payload を安全にパースして scores 行だけ取り出す */
export function extractScoreRows(lastPayload: Record<string, unknown> | null): IngestScoreRow[] {
  if (!lastPayload) return [];
  const raw = lastPayload.scores;
  if (!Array.isArray(raw)) return [];
  const out: IngestScoreRow[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = typeof item.name === "string" ? item.name : "";
    if (!name) continue;
    const n = (x: unknown, d = 0) => (typeof x === "number" && !Number.isNaN(x) ? x : d);
    const b = (x: unknown) => x === true;
    const s = (x: unknown) => (typeof x === "string" ? x : "");
    const c = item.const;
    const constVal = typeof c === "number" && !Number.isNaN(c) ? c : undefined;
    const level = s(item.level);
    const fullComboRaw = (item as { fullCombo?: unknown; full_combo?: unknown }).fullCombo ?? (item as { full_combo?: unknown }).full_combo;
    const mid = item.music_ex_id;
    const musicExID =
      typeof mid === "string" && mid.trim()
        ? mid.trim()
        : typeof mid === "number" && Number.isFinite(mid)
          ? String(Math.trunc(mid))
          : undefined;
    out.push({
      name,
      difficulty: s(item.difficulty),
      level,
      genre: s(item.genre),
      technicalHighScore: n(item.technicalHighScore),
      overDamageHighScore: n(item.overDamageHighScore),
      battleHighScore: n(item.battleHighScore),
      fullBell: b(item.fullBell),
      fullCombo: fullComboRaw === true,
      allBreak: b(item.allBreak),
      const: constVal,
      platinumHighScore: n(item.platinumHighScore),
      platinumStar: n(item.platinumStar),
      platinumMaxScore: n(item.platinumMaxScore),
      character: item.character !== undefined && item.character !== null ? s(item.character) : undefined,
      version: item.version !== undefined && item.version !== null ? s(item.version) : undefined,
      music_ex_id: musicExID,
    });
  }
  return out;
}

/** last_payload.music_catalog を取り出す（無ければ空配列） */
export function extractMusicCatalog(lastPayload: Record<string, unknown> | null): MusicExTrack[] {
  if (!lastPayload) return [];
  const raw = lastPayload.music_catalog;
  if (!Array.isArray(raw)) return [];
  const out: MusicExTrack[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const row: MusicExTrack = {};
    for (const [k, v] of Object.entries(item)) {
      if (typeof v === "string") row[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") row[k] = String(v);
      else if (v == null) row[k] = "";
    }
    out.push(row);
  }
  return out;
}

/** id（music-ex の id）→ 曲レコード。重複 id は後勝ち */
export function indexMusicCatalogById(catalog: MusicExTrack[]): Map<string, MusicExTrack> {
  const m = new Map<string, MusicExTrack>();
  for (const t of catalog) {
    const id = (t.id ?? "").trim();
    if (id) m.set(id, t);
  }
  return m;
}

export function resolveTrackJacketUrl(track: MusicExTrack | undefined): string | undefined {
  if (!track) return undefined;
  const raw = (track.image_url ?? track.jacket_url ?? track.jacket ?? track.image ?? "").trim();
  if (!raw) return undefined;
  const cleaned = raw.replace(/\\/g, "/");
  if (/^https?:\/\//i.test(cleaned)) {
    try {
      const u = new URL(cleaned);
      const fileNameFromPath = u.pathname.split("/").pop() ?? "";
      if (!/\.(png|jpe?g|webp|gif)$/i.test(fileNameFromPath)) return undefined;
      const internal = buildInternalJacketUrl(fileNameFromPath);
      return internal || undefined;
    } catch {
      return undefined;
    }
  }
  const fileName = cleaned.split("/").pop() ?? "";
  if (!fileName || !/\.(png|jpe?g|webp|gif)$/i.test(fileName)) return undefined;
  const internal = buildInternalJacketUrl(fileName);
  return internal || undefined;
}

function parseTrackConst(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

/** music-ex 행에서 난이도별 정수 추출 */
export function catalogConstByDifficulty(track: MusicExTrack | undefined, difficulty: string): number | undefined {
  if (!track) return undefined;
  const d = difficulty.toUpperCase();
  if (d === "BASIC") return parseTrackConst(track.lev_bas_i);
  if (d === "ADVANCED") return parseTrackConst(track.lev_adv_i);
  if (d === "EXPERT") return parseTrackConst(track.lev_exc_i);
  if (d === "MASTER") return parseTrackConst(track.lev_mas_i);
  if (d === "LUNATIC") return parseTrackConst(track.lev_lnt_i);
  return undefined;
}

