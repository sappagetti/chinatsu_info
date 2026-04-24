import { useEffect, useMemo, useState } from "react";
import { fetchMe } from "../api";
import { useAuth } from "../auth/AuthContext";
import { catalogConstByDifficulty, extractMusicCatalog, extractScoreRows, indexMusicCatalogById, resolveTrackJacketUrl } from "../lib/ratingView";
import { fetchMusicExJson } from "../lib/musicExCache";
import { buildMusicExIndex } from "../lib/musicExIndex";
import { usePersistedState } from "../lib/persistedState";
import {
  calcLampBonus,
  calcMainRate,
  calcPlatinumRate,
  calcRankBonus,
  getLampForRating,
  makeConstKey,
  normalizeLevel,
  pickBestConstCandidate,
  type ConstCandidate,
} from "../lib/ratingCalc";
import type { IngestScoreRow } from "../types/ingestPayload";
import { LoadingBar } from "../components/LoadingBar";

type BandKey = string;

type Row = IngestScoreRow & {
  resolvedConst?: number;
  resolvedLevel: string;
  inferredFullCombo: boolean;
  techRate?: number;
  platRate?: number;
};
type SortMode = "score" | "pscore";

const BANDS: Array<{ key: BandKey; label: string }> = (() => {
  const out: Array<{ key: BandKey; label: string }> = [{ key: "15", label: "Lv15 (15+を含む)" }];
  for (let lv = 14; lv >= 1; lv -= 1) {
    out.push({ key: `${lv}+`, label: `Lv${lv}+` });
    out.push({ key: `${lv}`, label: `Lv${lv}` });
  }
  out.push({ key: "0", label: "Lv0" });
  return out;
})();

const musicExUrl = import.meta.env.VITE_BEATMAP_BUCKET_URL?.trim() ?? "";

function bandOfLevel(level: string): BandKey | null {
  const lv = normalizeLevel(level);
  if (!lv) return null;
  if (lv.startsWith("15")) return "15";
  if (BANDS.some((b) => b.key === lv)) return lv;
  if (lv === "0+") return "0";
  return null;
}

export function AchievementBoardPage() {
  const { user } = useAuth();
  const token = user?.ingest_token ?? "";
  const [loading, setLoading] = useState(!!token);
  const [err, setErr] = useState<string | null>(null);
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);
  const [fallbackConstMap, setFallbackConstMap] = useState<Map<string, number>>(new Map());
  const [fallbackCandidatesMap, setFallbackCandidatesMap] = useState<Map<string, ConstCandidate[]>>(new Map());
  const [activeBand, setActiveBand] = usePersistedState<BandKey>("achievement.activeBand", "15", {
    validate: (v) => typeof v === "string",
  });
  const [sortMode, setSortMode] = usePersistedState<SortMode>("achievement.sortMode", "score", {
    validate: (v) => v === "score" || v === "pscore",
  });
  const [showJackets, setShowJackets] = usePersistedState<boolean>("achievement.showJackets", true, {
    validate: (v) => typeof v === "boolean",
  });

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const me = await fetchMe(token);
        if (cancelled) return;
        setPayload(me.last_payload as Record<string, unknown> | null);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!musicExUrl) return;
        const data = await fetchMusicExJson(musicExUrl);
        const { constMap, candidatesMap } = buildMusicExIndex(data);
        if (!cancelled) {
          setFallbackConstMap(constMap);
          setFallbackCandidatesMap(candidatesMap);
        }
      } catch {
        // music-ex.json 폴백은 보조 수단이므로 실패해도 무시한다.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sourceRows = useMemo(() => extractScoreRows(payload), [payload]);
  const catalogByID = useMemo(() => indexMusicCatalogById(extractMusicCatalog(payload)), [payload]);
  const rows = useMemo<Row[]>(
    () =>
      sourceRows.map((r) => {
        const key = makeConstKey(r.name, r.difficulty);
        const byID = r.music_ex_id ? catalogByID.get(r.music_ex_id) : undefined;
        const fallbackByLevel = pickBestConstCandidate(r, fallbackCandidatesMap.get(key) ?? []);
        const resolvedConst = r.const ?? catalogConstByDifficulty(byID, r.difficulty) ?? fallbackByLevel ?? fallbackConstMap.get(key);
        const resolvedLevel = normalizeLevel(r.level);
        const inferredFullCombo = r.fullCombo === true || r.allBreak === true;
        const techRate =
          resolvedConst !== undefined && resolvedConst > 0
            ? calcMainRate(resolvedConst, r.technicalHighScore) +
              calcRankBonus(r.technicalHighScore) +
              calcLampBonus(getLampForRating(r.technicalHighScore, r.fullBell, inferredFullCombo, r.allBreak))
            : undefined;
        const platRate =
          resolvedConst !== undefined && resolvedConst > 0
            ? calcPlatinumRate(resolvedConst, r.platinumStar)
            : undefined;
        return { ...r, resolvedConst, resolvedLevel, inferredFullCombo, techRate, platRate };
      }),
    [sourceRows, catalogByID, fallbackConstMap, fallbackCandidatesMap],
  );

  const groupedByBand = useMemo(() => {
    const byBand: Record<BandKey, Row[]> = Object.fromEntries(BANDS.map((b) => [b.key, []])) as Record<BandKey, Row[]>;
    for (const r of rows) {
      const b = bandOfLevel(r.resolvedLevel);
      if (!b) continue;
      byBand[b].push(r);
    }
    return byBand;
  }, [rows]);

  if (!token) return <article className="prose"><h1>達成表</h1><LoadingBar /></article>;
  if (loading) return <article className="prose"><h1>達成表</h1><LoadingBar /></article>;
  if (err) return <article className="prose"><h1>達成表</h1><p className="error">{err}</p></article>;

  return (
    <article className="prose">
      <h1>レコード</h1>
      <div className="row">
        <strong>レベル</strong>
        <select
          className="input"
          value={activeBand}
          onChange={(e) => setActiveBand(e.target.value)}
        >
          {BANDS.map((band) => (
            <option key={band.key} value={band.key}>
              {band.label}
            </option>
          ))}
        </select>
        <label className="theme-toggle" title="ジャケット表示切替">
          <input type="checkbox" checked={showJackets} onChange={(e) => setShowJackets(e.target.checked)} />
          <span className="theme-toggle-track" />
          <span className="theme-toggle-label">{showJackets ? "ジャケット: ON" : "ジャケット: OFF"}</span>
        </label>
      </div>
      <BandSection
        label={BANDS.find((b) => b.key === activeBand)?.label ?? activeBand}
        rows={groupedByBand[activeBand]}
        sortMode={sortMode}
        onSortModeChange={setSortMode}
        catalogByID={catalogByID}
        showJackets={showJackets}
      />
    </article>
  );
}

function BandSection({
  label,
  rows,
  sortMode,
  onSortModeChange,
  catalogByID,
  showJackets,
}: {
  label: string;
  rows: Row[];
  sortMode: SortMode;
  onSortModeChange: (mode: SortMode) => void;
  catalogByID: Map<string, Record<string, string>>;
  showJackets: boolean;
}) {
  const constGroups = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) {
      const key = r.resolvedConst !== undefined ? r.resolvedConst.toFixed(1) : "未設定";
      if (!m.has(key)) m.set(key, []);
      m.get(key)?.push(r);
    }
    return [...m.entries()]
      .sort((a, b) => {
        const an = Number.parseFloat(a[0]);
        const bn = Number.parseFloat(b[0]);
        if (Number.isNaN(an)) return 1;
        if (Number.isNaN(bn)) return -1;
        return bn - an;
      })
      .map(([k, group]) => [
        k,
        [...group].sort((a, b) => {
          if ((b.resolvedConst ?? -1) !== (a.resolvedConst ?? -1)) return (b.resolvedConst ?? -1) - (a.resolvedConst ?? -1);
          if (sortMode === "pscore") {
            if (b.platinumHighScore !== a.platinumHighScore) return b.platinumHighScore - a.platinumHighScore;
            if (b.platinumStar !== a.platinumStar) return b.platinumStar - a.platinumStar;
          } else if (b.technicalHighScore !== a.technicalHighScore) {
            return b.technicalHighScore - a.technicalHighScore;
          }
          if (b.technicalHighScore !== a.technicalHighScore) return b.technicalHighScore - a.technicalHighScore;
          return a.name.localeCompare(b.name, "ja");
        }),
      ] as const);
  }, [rows, sortMode]);

  const total = rows.length;
  const fc = rows.filter((r) => r.inferredFullCombo).length;
  const ab = rows.filter((r) => r.allBreak).length;
  const fb = rows.filter((r) => r.fullBell).length;

  return (
    <section>
      <h2>{label}</h2>
      <p className="muted">
        譜面数 {total.toLocaleString("ja-JP")} / FC {fc.toLocaleString("ja-JP")} / AB {ab.toLocaleString("ja-JP")} / FB {fb.toLocaleString("ja-JP")}
      </p>

      {constGroups.length === 0 ? (
        <p className="muted">対象譜面がありません。</p>
      ) : (
        constGroups.map(([constLabel, group]) => (
          <div key={`${label}-${constLabel}`} className="table-wrap">
            <table className="data-table achievement-table">
              <colgroup>
                <col style={{ width: "34%" }} />
                <col style={{ width: "8%" }} />
                <col style={{ width: "8%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "7%" }} />
                <col style={{ width: "7%" }} />
                <col style={{ width: "7%" }} />
                <col style={{ width: "13%" }} />
                <col style={{ width: "11%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th colSpan={10}>定数 {constLabel} / 譜面 {group.length.toLocaleString("ja-JP")}</th>
                </tr>
                <tr>
                  <th>Title</th>
                  <th>Dif</th>
                  <th>Lv</th>
                  <th>
                    <button
                      type="button"
                      className="sort-link-btn"
                      onClick={() => onSortModeChange("score")}
                      title="Scoreで並び替え"
                    >
                      Score {sortMode === "score" ? "▼" : "↕"}
                    </button>
                  </th>
                  <th>Rate</th>
                  <th>FC</th>
                  <th>AB</th>
                  <th>FB</th>
                  <th>
                    <button
                      type="button"
                      className="sort-link-btn"
                      onClick={() => onSortModeChange("pscore")}
                      title="Pスコアで並び替え"
                    >
                      Pスコア {sortMode === "pscore" ? "▼" : "↕"}
                    </button>
                  </th>
                  <th>PRate</th>
                </tr>
              </thead>
              <tbody>
                {group.map((r, i) => (
                  <tr key={`${r.name}-${r.difficulty}-${i}`}>
                    <td className={showJackets ? "cell-name with-jacket" : "cell-name"}>
                      {showJackets ? (
                        (() => {
                          const track = r.music_ex_id ? catalogByID.get(r.music_ex_id) : undefined;
                          const jacket = resolveTrackJacketUrl(track);
                          return (
                            <span className="jacket-inline">
                              {jacket ? <img src={jacket} alt="" className="song-jacket" loading="lazy" /> : <span className="song-jacket placeholder" />}
                              <span>{r.name}</span>
                            </span>
                          );
                        })()
                      ) : (
                        r.name
                      )}
                    </td>
                    <td>{r.difficulty.slice(0, 3)}</td>
                    <td>{r.resolvedConst !== undefined ? r.resolvedConst.toFixed(1) : ""}</td>
                    <td>{r.technicalHighScore.toLocaleString("ja-JP")}</td>
                    <td>{r.techRate !== undefined ? r.techRate.toFixed(3) : ""}</td>
                    <td>{r.inferredFullCombo ? "○" : ""}</td>
                    <td>{r.allBreak ? "○" : ""}</td>
                    <td>{r.fullBell ? "○" : ""}</td>
                    <td>
                      {r.platinumHighScore > 0
                        ? `${r.platinumHighScore.toLocaleString("ja-JP")} (${r.platinumStar}★)`
                        : ""}
                    </td>
                    <td>{r.platRate !== undefined ? r.platRate.toFixed(3) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </section>
  );
}
