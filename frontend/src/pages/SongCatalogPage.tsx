import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { LoadingBar } from "../components/LoadingBar";
import { fetchMusicExJson } from "../lib/musicExCache";
import { usePersistedState } from "../lib/persistedState";
import { resolveTrackJacketUrl } from "../lib/ratingView";

type DifficultyKey = "bas" | "adv" | "exc" | "mas" | "lnt";
type SortOrder = "asc" | "desc";

type Track = {
  id: string;
  title: string;
  artist: string;
  version: string;
  genre: string;
  attr: string;
  bpm: number | undefined;
  lev_bas: string;
  lev_adv: string;
  lev_exc: string;
  lev_mas: string;
  lev_lnt: string;
  lev_bas_i: number | undefined;
  lev_adv_i: number | undefined;
  lev_exc_i: number | undefined;
  lev_mas_i: number | undefined;
  lev_lnt_i: number | undefined;
  lev_bas_notes: number | undefined;
  lev_adv_notes: number | undefined;
  lev_exc_notes: number | undefined;
  lev_mas_notes: number | undefined;
  lev_lnt_notes: number | undefined;
  lev_bas_bells: number | undefined;
  lev_adv_bells: number | undefined;
  lev_exc_bells: number | undefined;
  lev_mas_bells: number | undefined;
  lev_lnt_bells: number | undefined;
  image_url: string;
};

type SortKey =
  | "title"
  | "artist"
  | "version"
  | "genre"
  | "attr"
  | "bpm"
  | "bas_level"
  | "adv_level"
  | "exc_level"
  | "mas_level"
  | "lnt_level"
  | "bas_const"
  | "adv_const"
  | "exc_const"
  | "mas_const"
  | "lnt_const"
  | "bas_notes"
  | "adv_notes"
  | "exc_notes"
  | "mas_notes"
  | "lnt_notes"
  | "bas_bells"
  | "adv_bells"
  | "exc_bells"
  | "mas_bells"
  | "lnt_bells"
  | "bas_star"
  | "adv_star"
  | "exc_star"
  | "mas_star"
  | "lnt_star";

const sourceUrl = import.meta.env.VITE_BEATMAP_BUCKET_URL?.trim() ?? "";
const ROWS_PER_PAGE = 20;

function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

function toInt(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseTrack(raw: unknown): Track | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const title = String(o.title ?? "").trim();
  if (!title) return null;
  return {
    id: String(o.id ?? "").trim(),
    title,
    artist: String(o.artist ?? "").trim(),
    version: String(o.version ?? "").trim(),
    genre: String(o.category ?? "").trim(),
    attr: String(o.enemy_type ?? "").trim(),
    bpm: toNumber(o.bpm),
    lev_bas: String(o.lev_bas ?? "").trim(),
    lev_adv: String(o.lev_adv ?? "").trim(),
    lev_exc: String(o.lev_exc ?? "").trim(),
    lev_mas: String(o.lev_mas ?? "").trim(),
    lev_lnt: String(o.lev_lnt ?? "").trim(),
    lev_bas_i: toNumber(o.lev_bas_i),
    lev_adv_i: toNumber(o.lev_adv_i),
    lev_exc_i: toNumber(o.lev_exc_i),
    lev_mas_i: toNumber(o.lev_mas_i),
    lev_lnt_i: toNumber(o.lev_lnt_i),
    lev_bas_notes: toInt(o.lev_bas_notes),
    lev_adv_notes: toInt(o.lev_adv_notes),
    lev_exc_notes: toInt(o.lev_exc_notes),
    lev_mas_notes: toInt(o.lev_mas_notes),
    lev_lnt_notes: toInt(o.lev_lnt_notes),
    lev_bas_bells: toInt(o.lev_bas_bells),
    lev_adv_bells: toInt(o.lev_adv_bells),
    lev_exc_bells: toInt(o.lev_exc_bells),
    lev_mas_bells: toInt(o.lev_mas_bells),
    lev_lnt_bells: toInt(o.lev_lnt_bells),
    image_url: String(o.image_url ?? "").trim(),
  };
}

function chartLevel(t: Track, d: DifficultyKey): string {
  if (d === "bas") return t.lev_bas;
  if (d === "adv") return t.lev_adv;
  if (d === "exc") return t.lev_exc;
  if (d === "mas") return t.lev_mas;
  return t.lev_lnt;
}

function chartConst(t: Track, d: DifficultyKey): number | undefined {
  if (d === "bas") return t.lev_bas_i;
  if (d === "adv") return t.lev_adv_i;
  if (d === "exc") return t.lev_exc_i;
  if (d === "mas") return t.lev_mas_i;
  return t.lev_lnt_i;
}

function chartNotes(t: Track, d: DifficultyKey): number | undefined {
  if (d === "bas") return t.lev_bas_notes;
  if (d === "adv") return t.lev_adv_notes;
  if (d === "exc") return t.lev_exc_notes;
  if (d === "mas") return t.lev_mas_notes;
  return t.lev_lnt_notes;
}

function chartBells(t: Track, d: DifficultyKey): number | undefined {
  if (d === "bas") return t.lev_bas_bells;
  if (d === "adv") return t.lev_adv_bells;
  if (d === "exc") return t.lev_exc_bells;
  if (d === "mas") return t.lev_mas_bells;
  return t.lev_lnt_bells;
}

function fiveStarLimit(notes: number | undefined): number | undefined {
  if (notes === undefined || Number.isNaN(notes)) return undefined;
  // P 스코어 최대치 = notes * 2, 5★ 기준점 = 98%. 점수는 정수이므로 기준점 = ceil(notes*1.96).
  // 허용치(최대치 - 기준점) = notes*2 - ceil(notes*1.96) = floor(notes*4/100) (정수식으로 정확).
  return Math.floor((notes * 4) / 100);
}

function numOrSentinel(v: number | undefined): number {
  return v === undefined ? Number.NEGATIVE_INFINITY : v;
}

type DifficultySortKind = "level" | "const" | "notes" | "bells" | "star";
type DifficultySortKey = Exclude<SortKey, "title" | "artist" | "version" | "genre" | "attr" | "bpm">;

// 정렬 키 → (난이도, 어떤 지표) 매핑. 렌더마다 재할당되지 않도록 모듈 수준에 보관.
const DIFFICULTY_SORT_MAP: Record<DifficultySortKey, [DifficultyKey, DifficultySortKind]> = {
  bas_level: ["bas", "level"],
  adv_level: ["adv", "level"],
  exc_level: ["exc", "level"],
  mas_level: ["mas", "level"],
  lnt_level: ["lnt", "level"],
  bas_const: ["bas", "const"],
  adv_const: ["adv", "const"],
  exc_const: ["exc", "const"],
  mas_const: ["mas", "const"],
  lnt_const: ["lnt", "const"],
  bas_notes: ["bas", "notes"],
  adv_notes: ["adv", "notes"],
  exc_notes: ["exc", "notes"],
  mas_notes: ["mas", "notes"],
  lnt_notes: ["lnt", "notes"],
  bas_bells: ["bas", "bells"],
  adv_bells: ["adv", "bells"],
  exc_bells: ["exc", "bells"],
  mas_bells: ["mas", "bells"],
  lnt_bells: ["lnt", "bells"],
  bas_star: ["bas", "star"],
  adv_star: ["adv", "star"],
  exc_star: ["exc", "star"],
  mas_star: ["mas", "star"],
  lnt_star: ["lnt", "star"],
};

function compareByKey(a: Track, b: Track, key: SortKey): number {
  const text = (x: string, y: string) => x.localeCompare(y, "ja");
  if (key === "title") return text(a.title, b.title);
  if (key === "artist") return text(a.artist, b.artist);
  if (key === "version") return text(a.version, b.version);
  if (key === "genre") return text(a.genre, b.genre);
  if (key === "attr") return text(a.attr, b.attr);
  if (key === "bpm") return numOrSentinel(a.bpm) - numOrSentinel(b.bpm);

  const [d, kind] = DIFFICULTY_SORT_MAP[key as DifficultySortKey];
  if (kind === "level") return chartLevel(a, d).localeCompare(chartLevel(b, d), "ja");
  if (kind === "const") return numOrSentinel(chartConst(a, d)) - numOrSentinel(chartConst(b, d));
  if (kind === "notes") return numOrSentinel(chartNotes(a, d)) - numOrSentinel(chartNotes(b, d));
  if (kind === "bells") return numOrSentinel(chartBells(a, d)) - numOrSentinel(chartBells(b, d));
  return numOrSentinel(fiveStarLimit(chartNotes(a, d))) - numOrSentinel(fiveStarLimit(chartNotes(b, d)));
}

function parseJsonUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname.toLowerCase().endsWith(".json") || u.searchParams.get("format") === "music-ex";
  } catch {
    return /\.json($|\?)/i.test(url);
  }
}

export function SongCatalogPage() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [mode, setMode] = usePersistedState<"simple" | "detail">("catalog.mode", "simple", {
    validate: (v) => v === "simple" || v === "detail",
  });

  const [titleQ, setTitleQ] = useState("");
  const [artistQ, setArtistQ] = useState("");
  const [versionQ, setVersionQ] = useState("");
  const [genreQ, setGenreQ] = useState("");
  const [attrQ, setAttrQ] = useState("");
  const [selectedDiff, setSelectedDiff] = usePersistedState<DifficultyKey>("catalog.selectedDiff", "mas", {
    validate: (v) => v === "bas" || v === "adv" || v === "exc" || v === "mas" || v === "lnt",
  });
  const [levelQ, setLevelQ] = useState("");
  const [constMin, setConstMin] = useState("");
  const [constMax, setConstMax] = useState("");
  const [bellsMin, setBellsMin] = useState("");
  const [bellsMax, setBellsMax] = useState("");
  const [starMin, setStarMin] = useState("");
  const [starMax, setStarMax] = useState("");
  const [sortKey, setSortKey] = usePersistedState<SortKey>("catalog.sortKey", "mas_const", {
    validate: (v) => typeof v === "string",
  });
  const [sortOrder, setSortOrder] = usePersistedState<SortOrder>("catalog.sortOrder", "desc", {
    validate: (v) => v === "asc" || v === "desc",
  });
  const [page, setPage] = useState(1);
  const [showJackets, setShowJackets] = usePersistedState<boolean>("catalog.showJackets", true, {
    validate: (v) => typeof v === "boolean",
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!sourceUrl) throw new Error("VITE_BEATMAP_BUCKET_URL が未設定です。music-ex.json のURLを設定してください。");
        if (!parseJsonUrl(sourceUrl)) {
          throw new Error("このページは music-ex.json 専用です。VITE_BEATMAP_BUCKET_URL に JSON URL を設定してください。");
        }
        const json = await fetchMusicExJson(sourceUrl);
        const parsed = json.map(parseTrack).filter((v): v is Track => v !== null);
        if (!cancelled) setTracks(parsed);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const versions = useMemo(
    () => [...new Set(tracks.map((t) => t.version).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja")),
    [tracks],
  );
  const genres = useMemo(
    () => [...new Set(tracks.map((t) => t.genre).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja")),
    [tracks],
  );
  const attrs = useMemo(
    () => [...new Set(tracks.map((t) => t.attr).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja")),
    [tracks],
  );

  // 필터와 정렬을 각각 메모이제이션하여, 정렬 키/방향만 바뀔 때는 필터링을 다시 돌리지 않는다.
  const filteredRows = useMemo(() => {
    const qTitle = titleQ.trim().toLowerCase();
    const qArtist = artistQ.trim().toLowerCase();
    const qLevel = levelQ.trim().toLowerCase();
    const cMin = toNumber(constMin);
    const cMax = toNumber(constMax);
    const bellMin = toInt(bellsMin);
    const bellMax = toInt(bellsMax);
    const sMin = toInt(starMin);
    const sMax = toInt(starMax);

    return tracks.filter((t) => {
      if (qTitle && !t.title.toLowerCase().includes(qTitle)) return false;
      if (qArtist && !t.artist.toLowerCase().includes(qArtist)) return false;
      if (versionQ && t.version !== versionQ) return false;
      if (genreQ && t.genre !== genreQ) return false;
      if (attrQ && t.attr !== attrQ) return false;

      const lv = chartLevel(t, selectedDiff).toLowerCase();
      const ct = chartConst(t, selectedDiff);
      const nt = chartNotes(t, selectedDiff);
      const bl = chartBells(t, selectedDiff);
      const st = fiveStarLimit(nt);

      if (qLevel && !lv.includes(qLevel) && !(ct !== undefined && String(ct).includes(qLevel))) return false;
      if (cMin !== undefined && (ct === undefined || ct < cMin)) return false;
      if (cMax !== undefined && (ct === undefined || ct > cMax)) return false;

      if (mode === "detail") {
        if (bellMin !== undefined && (bl === undefined || bl < bellMin)) return false;
        if (bellMax !== undefined && (bl === undefined || bl > bellMax)) return false;
        if (sMin !== undefined && (st === undefined || st < sMin)) return false;
        if (sMax !== undefined && (st === undefined || st > sMax)) return false;
      }
      return true;
    });
  }, [
    tracks,
    titleQ,
    artistQ,
    versionQ,
    genreQ,
    attrQ,
    selectedDiff,
    levelQ,
    constMin,
    constMax,
    bellsMin,
    bellsMax,
    starMin,
    starMax,
    mode,
  ]);

  const filtered = useMemo(() => {
    const sorted = filteredRows.slice();
    sorted.sort((a, b) => {
      const c = compareByKey(a, b, sortKey);
      if (c !== 0) return sortOrder === "asc" ? c : -c;
      return a.title.localeCompare(b.title, "ja");
    });
    return sorted;
  }, [filteredRows, sortKey, sortOrder]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / ROWS_PER_PAGE));
  const pageSafe = Math.min(page, totalPages);
  const startIndex = (pageSafe - 1) * ROWS_PER_PAGE;
  const endIndex = startIndex + ROWS_PER_PAGE;
  const shown = filtered.slice(startIndex, endIndex);

  useEffect(() => {
    setPage(1);
  }, [
    titleQ,
    artistQ,
    versionQ,
    genreQ,
    attrQ,
    selectedDiff,
    levelQ,
    constMin,
    constMax,
    bellsMin,
    bellsMax,
    starMin,
    starMax,
    mode,
    sortKey,
    sortOrder,
  ]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  return (
    <article className="prose">
      <h1>楽曲データブラウザ</h1>

      {loading && <LoadingBar label="楽曲データを読み込み中…" />}
      {err && <p className="error">{err}</p>}

      {!loading && !err && (
        <>
          <div className="row">
            <strong>検索モード</strong>
            <button type="button" className={`btn ${mode === "simple" ? "" : "secondary"}`} onClick={() => setMode("simple")}>
              簡易検索
            </button>
            <button type="button" className={`btn ${mode === "detail" ? "" : "secondary"}`} onClick={() => setMode("detail")}>
              詳細検索
            </button>
          </div>

          <div className="catalog-filters">
            <input className="input" placeholder="曲名" value={titleQ} onChange={(e) => setTitleQ(e.target.value)} />
            <input className="input" placeholder="アーティスト" value={artistQ} onChange={(e) => setArtistQ(e.target.value)} />
            <select className="input" value={versionQ} onChange={(e) => setVersionQ(e.target.value)}>
              <option value="">バージョン（全て）</option>
              {versions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <select className="input" value={genreQ} onChange={(e) => setGenreQ(e.target.value)}>
              <option value="">ジャンル（全て）</option>
              {genres.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <select className="input" value={attrQ} onChange={(e) => setAttrQ(e.target.value)}>
              <option value="">属性（全て）</option>
              {attrs.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <div className="catalog-diff-level-row">
              <select className="input" value={selectedDiff} onChange={(e) => setSelectedDiff(e.target.value as DifficultyKey)}>
                <option value="bas">BASIC</option>
                <option value="adv">ADVANCED</option>
                <option value="exc">EXPERT</option>
                <option value="mas">MASTER</option>
                <option value="lnt">LUNATIC</option>
              </select>
              <input className="input" placeholder="Lv / 定数(部分一致)" value={levelQ} onChange={(e) => setLevelQ(e.target.value)} />
            </div>
            <input className="input" placeholder="定数 Min" value={constMin} onChange={(e) => setConstMin(e.target.value)} />
            <input className="input" placeholder="定数 Max" value={constMax} onChange={(e) => setConstMax(e.target.value)} />

            {mode === "detail" && (
              <>
                <input className="input" placeholder="総ベル Min" value={bellsMin} onChange={(e) => setBellsMin(e.target.value)} />
                <input className="input" placeholder="総ベル Max" value={bellsMax} onChange={(e) => setBellsMax(e.target.value)} />
                <input className="input" placeholder="5星許容値 Min" value={starMin} onChange={(e) => setStarMin(e.target.value)} />
                <input className="input" placeholder="5星許容値 Max" value={starMax} onChange={(e) => setStarMax(e.target.value)} />
              </>
            )}
          </div>

          <div className="row">
            <select className="input" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
              <option value="title">ソート: 曲名</option>
              <option value="artist">ソート: アーティスト</option>
              <option value="version">ソート: バージョン</option>
              <option value="genre">ソート: ジャンル</option>
              <option value="attr">ソート: 属性</option>
              <option value="bpm">ソート: BPM</option>
              <option value="bas_level">BASIC Lv</option>
              <option value="adv_level">ADVANCED Lv</option>
              <option value="exc_level">EXPERT Lv</option>
              <option value="mas_level">MASTER Lv</option>
              <option value="lnt_level">LUNATIC Lv</option>
              <option value="bas_const">BASIC 定数</option>
              <option value="adv_const">ADVANCED 定数</option>
              <option value="exc_const">EXPERT 定数</option>
              <option value="mas_const">MASTER 定数</option>
              <option value="lnt_const">LUNATIC 定数</option>
              {mode === "detail" && (
                <>
                  <option value="bas_notes">BASIC 総ノーツ</option>
                  <option value="adv_notes">ADVANCED 総ノーツ</option>
                  <option value="exc_notes">EXPERT 総ノーツ</option>
                  <option value="mas_notes">MASTER 総ノーツ</option>
                  <option value="lnt_notes">LUNATIC 総ノーツ</option>
                  <option value="bas_bells">BASIC 総ベル</option>
                  <option value="adv_bells">ADVANCED 総ベル</option>
                  <option value="exc_bells">EXPERT 総ベル</option>
                  <option value="mas_bells">MASTER 総ベル</option>
                  <option value="lnt_bells">LUNATIC 総ベル</option>
                  <option value="bas_star">BASIC 5星許容値</option>
                  <option value="adv_star">ADVANCED 5星許容値</option>
                  <option value="exc_star">EXPERT 5星許容値</option>
                  <option value="mas_star">MASTER 5星許容値</option>
                  <option value="lnt_star">LUNATIC 5星許容値</option>
                </>
              )}
            </select>
            <select className="input" value={sortOrder} onChange={(e) => setSortOrder(e.target.value as SortOrder)}>
              <option value="asc">昇順</option>
              <option value="desc">降順</option>
            </select>
            <label className="theme-toggle" title="ジャケット表示切替">
              <input type="checkbox" checked={showJackets} onChange={(e) => setShowJackets(e.target.checked)} />
              <span className="theme-toggle-track" />
              <span className="theme-toggle-label">{showJackets ? "ジャケット: ON" : "ジャケット: OFF"}</span>
            </label>
          </div>

          <p className="muted">
            全 {tracks.length.toLocaleString("ja-JP")} 曲中、条件一致{" "}
            {filtered.length.toLocaleString("ja-JP")} 曲（{pageSafe.toLocaleString("ja-JP")} / {totalPages.toLocaleString("ja-JP")} ページ）
          </p>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>曲名</th>
                  <th>アーティスト</th>
                  <th>バージョン</th>
                  <th>ジャンル</th>
                  <th>属性</th>
                  {mode === "detail" && <th>BPM</th>}
                  <th>BASIC</th>
                  <th>ADVANCED</th>
                  <th>EXPERT</th>
                  <th>MASTER</th>
                  <th>LUNATIC</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={`${t.id || t.title}-${t.artist}`}>
                    <td className={showJackets ? "cell-name with-jacket" : "cell-name"}>
                      {showJackets ? (
                        (() => {
                          const jacket = resolveTrackJacketUrl({ image_url: t.image_url });
                          return (
                            <span className="jacket-inline">
                              {jacket ? <img src={jacket} alt="" className="song-jacket" loading="lazy" /> : <span className="song-jacket placeholder" />}
                              <span>{t.title}</span>
                            </span>
                          );
                        })()
                      ) : (
                        t.title
                      )}
                    </td>
                    <td>{t.artist || ""}</td>
                    <td className="cell-muted">{t.version || ""}</td>
                    <td className="cell-muted">{t.genre || ""}</td>
                    <td className="cell-muted">{t.attr || ""}</td>
                    {mode === "detail" && <td>{t.bpm !== undefined ? t.bpm : ""}</td>}
                    <td>{renderDiffCell(t, "bas", mode)}</td>
                    <td>{renderDiffCell(t, "adv", mode)}</td>
                    <td>{renderDiffCell(t, "exc", mode)}</td>
                    <td>{renderDiffCell(t, "mas", mode)}</td>
                    <td>{renderDiffCell(t, "lnt", mode)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="row">
            <button type="button" className="btn secondary" disabled={pageSafe <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              前へ
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((p) => p === 1 || p === totalPages || Math.abs(p - pageSafe) <= 2)
              .map((p, i, arr) => (
                <span key={p}>
                  {i > 0 && p - arr[i - 1] > 1 ? <span className="muted">…</span> : null}
                  <button
                    type="button"
                    className={`btn ${p === pageSafe ? "" : "secondary"}`}
                    onClick={() => setPage(p)}
                  >
                    {p}
                  </button>
                </span>
              ))}
            <button
              type="button"
              className="btn secondary"
              disabled={pageSafe >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              次へ
            </button>
          </div>
        </>
      )}
    </article>
  );
}

function renderDiffCell(t: Track, d: DifficultyKey, mode: "simple" | "detail"): ReactNode {
  const lv = chartLevel(t, d);
  const c = chartConst(t, d);
  if (!lv && c === undefined) return "";
  const chip = (text: string) => (
    <span key={text} className="diff-chip">
      {text}
    </span>
  );
  if (mode === "simple") {
    const parts = [lv ? `Lv ${lv}` : "", c !== undefined ? c.toFixed(1) : ""].filter(Boolean);
    return <div className="diff-cell">{parts.map(chip)}</div>;
  }
  const nt = chartNotes(t, d);
  const bl = chartBells(t, d);
  const st = fiveStarLimit(nt);
  const parts = [
    lv ? `Lv ${lv}` : "",
    c !== undefined ? c.toFixed(1) : "",
    nt !== undefined ? `Note ${nt}` : "",
    bl !== undefined ? `Bell ${bl}` : "",
    st !== undefined ? `5★ ${st}` : "",
  ].filter(Boolean);
  return <div className="diff-cell">{parts.map(chip)}</div>;
}
