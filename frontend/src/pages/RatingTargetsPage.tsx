import { useEffect, useMemo, useState } from "react";
import { fetchMe, fetchRatingTargets, type RatedTrack } from "../api";
import { useAuth } from "../auth/AuthContext";
import { LoadingBar } from "../components/LoadingBar";
import { fetchMusicExJson } from "../lib/musicExCache";
import { buildMusicExIndex } from "../lib/musicExIndex";
import { usePersistedState } from "../lib/persistedState";
import { makeConstKey, pickBestConstCandidate, type ConstCandidate } from "../lib/ratingCalc";
import { catalogConstByDifficulty, extractMusicCatalog, indexMusicCatalogById, resolveTrackJacketUrl } from "../lib/ratingView";

const NEW_COUNT = 10;
const OLD_COUNT = 50;
const PLAT_COUNT = 50;
const musicExUrl = import.meta.env.VITE_BEATMAP_BUCKET_URL?.trim() ?? "";

type RatedRow = {
  name: string;
  difficulty: string;
  level: string;
  musicExId?: string;
  technicalHighScore: number;
  platinumHighScore: number;
  platinumStar: number;
  lampForRating: string;
  techRate: number;
  platRate: number;
};

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

function sumTop(rows: RatedRow[], count: number, pick: (r: RatedRow) => number): number {
  return rows.slice(0, count).reduce((acc, r) => acc + pick(r), 0);
}

function mapRatedRow(r: RatedTrack): RatedRow {
  return {
    name: r.name,
    difficulty: r.difficulty,
    level: r.level,
    musicExId: typeof r.music_ex_id === "number" ? String(r.music_ex_id) : undefined,
    technicalHighScore: r.technical_high_score,
    platinumHighScore: r.platinum_high_score,
    platinumStar: r.platinum_star,
    lampForRating: r.lamp_for_rating,
    techRate: r.tech_rate,
    platRate: r.plat_rate,
  };
}

type CatalogLookup = {
  byId: Map<string, Record<string, string>>;
  byTitle: Map<string, Record<string, string>>;
};

function findTrackForRow(r: RatedRow, lookup: CatalogLookup): Record<string, string> | undefined {
  if (r.musicExId) {
    const hit = lookup.byId.get(r.musicExId);
    if (hit) return hit;
  }
  return lookup.byTitle.get(r.name);
}

function displayConstForRow(
  r: RatedRow,
  lookup: CatalogLookup,
  fallbackConstMap: Map<string, number>,
  fallbackCandidatesMap: Map<string, ConstCandidate[]>,
): string {
  const track = findTrackForRow(r, lookup);
  const key = makeConstKey(r.name, r.difficulty);
  const fallbackByLevel = pickBestConstCandidate(r, fallbackCandidatesMap.get(key) ?? []);
  const c = catalogConstByDifficulty(track, r.difficulty) ?? fallbackByLevel ?? fallbackConstMap.get(key);
  return c !== undefined ? c.toFixed(1) : "";
}

export function RatingTargetsPage() {
  const { user } = useAuth();
  const token = user?.ingest_token ?? "";
  const [loading, setLoading] = useState(!!token);
  const [err, setErr] = useState<string | null>(null);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [newTop, setNewTop] = useState<RatedRow[]>([]);
  const [oldTop, setOldTop] = useState<RatedRow[]>([]);
  const [platTop, setPlatTop] = useState<RatedRow[]>([]);
  const [catalogById, setCatalogById] = useState<Map<string, Record<string, string>>>(new Map());
  const [fallbackConstMap, setFallbackConstMap] = useState<Map<string, number>>(new Map());
  const [fallbackCandidatesMap, setFallbackCandidatesMap] = useState<Map<string, ConstCandidate[]>>(new Map());
  const [showJackets, setShowJackets] = usePersistedState<boolean>("rating-targets.showJackets", true, {
    validate: (v) => typeof v === "boolean",
  });

  const catalogLookup = useMemo<CatalogLookup>(() => {
    const byTitle = new Map<string, Record<string, string>>();
    for (const track of catalogById.values()) {
      const title = track.title ?? "";
      if (title && !byTitle.has(title)) byTitle.set(title, track);
    }
    return { byId: catalogById, byTitle };
  }, [catalogById]);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchRatingTargets(token);
        if (cancelled) return;
        setLastSynced(data.last_synced_at);
        setNewTop(data.new_top.map(mapRatedRow));
        setOldTop(data.old_top.map(mapRatedRow));
        setPlatTop(data.plat_top.map(mapRatedRow));
        const me = await fetchMe(token);
        if (cancelled) return;
        const catalog = extractMusicCatalog(me.last_payload ?? null);
        setCatalogById(indexMusicCatalogById(catalog));
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

  const newAvg = sumTop(newTop, NEW_COUNT, (r) => r.techRate) / NEW_COUNT;
  const oldAvg = sumTop(oldTop, OLD_COUNT, (r) => r.techRate) / OLD_COUNT;
  const platAvg = sumTop(platTop, PLAT_COUNT, (r) => r.platRate) / PLAT_COUNT;
  const newContrib = Math.floor((newAvg / 5) * 1000) / 1000;
  const oldContrib = Math.floor(oldAvg * 1000) / 1000;
  const platContrib = Math.floor(platAvg * 1000) / 1000;
  const totalRating = Math.floor((newContrib + oldContrib + platContrib) * 1000) / 1000;

  if (!token) return <article className="prose"><h1>レーティング</h1><LoadingBar /></article>;
  if (loading) return <article className="prose"><h1>レーティング</h1><LoadingBar /></article>;
  if (err) return <article className="prose"><h1>レーティング</h1><p className="error">{err}</p></article>;
  if (newTop.length === 0 && oldTop.length === 0 && platTop.length === 0) {
    return (
      <article className="prose">
        <h1>レーティング</h1>
        <p className="muted">まだスコアデータがありません。オンゲキNETでブックマークレットを実行して同期してください。</p>
      </article>
    );
  }

  return (
    <article className="prose">
      <h1>レーティング対象曲</h1>
      <p className="muted">
        最終同期: {formatDateTime(lastSynced)}
      </p>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>枠</th>
              <th>平均値</th>
              <th>対象曲数</th>
              <th>合計レート値</th>
              <th>寄与値</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>新曲枠</td><td>{newAvg.toFixed(3)}</td><td>{NEW_COUNT}</td><td>{sumTop(newTop, NEW_COUNT, (r) => r.techRate).toFixed(3)}</td><td>{newContrib.toFixed(3)}</td></tr>
            <tr><td>ベスト枠</td><td>{oldAvg.toFixed(3)}</td><td>{OLD_COUNT}</td><td>{sumTop(oldTop, OLD_COUNT, (r) => r.techRate).toFixed(3)}</td><td>{oldContrib.toFixed(3)}</td></tr>
            <tr><td>プラチナ枠</td><td>{platAvg.toFixed(3)}</td><td>{PLAT_COUNT}</td><td>{sumTop(platTop, PLAT_COUNT, (r) => r.platRate).toFixed(3)}</td><td>{platContrib.toFixed(3)}</td></tr>
          </tbody>
        </table>
      </div>
      <p><strong>RATING: {totalRating.toFixed(3)}</strong> = ({newContrib.toFixed(3)} + {oldContrib.toFixed(3)} + {platContrib.toFixed(3)})</p>

      <h2>新曲枠</h2>
      <div className="row" style={{ marginTop: 0 }}>
        <label className="theme-toggle" title="ジャケット表示切替">
          <input type="checkbox" checked={showJackets} onChange={(e) => setShowJackets(e.target.checked)} />
          <span className="theme-toggle-track" />
          <span className="theme-toggle-label">{showJackets ? "ジャケット: ON" : "ジャケット: OFF"}</span>
        </label>
      </div>
      <RateTable
        kind="tech"
        rows={newTop}
        catalogLookup={catalogLookup}
        fallbackConstMap={fallbackConstMap}
        fallbackCandidatesMap={fallbackCandidatesMap}
        showJackets={showJackets}
      />

      <h2>ベスト枠</h2>
      <RateTable
        kind="tech"
        rows={oldTop}
        catalogLookup={catalogLookup}
        fallbackConstMap={fallbackConstMap}
        fallbackCandidatesMap={fallbackCandidatesMap}
        showJackets={showJackets}
      />

      <h2>プラチナ枠</h2>
      <RateTable
        kind="plat"
        rows={platTop}
        catalogLookup={catalogLookup}
        fallbackConstMap={fallbackConstMap}
        fallbackCandidatesMap={fallbackCandidatesMap}
        showJackets={showJackets}
      />
    </article>
  );
}

function RateTable({
  kind,
  rows,
  catalogLookup,
  fallbackConstMap,
  fallbackCandidatesMap,
  showJackets,
}: {
  kind: "tech" | "plat";
  rows: RatedRow[];
  catalogLookup: CatalogLookup;
  fallbackConstMap: Map<string, number>;
  fallbackCandidatesMap: Map<string, ConstCandidate[]>;
  showJackets: boolean;
}) {
  const isTech = kind === "tech";
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Title</th>
            <th>Dif</th>
            <th>Lv</th>
            <th>{isTech ? "T.Score" : "P.Score"}</th>
            <th>{isTech ? "Lamp" : "☆"}</th>
            <th>Rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.name}-${r.difficulty}-${i}`}>
              <td>{i + 1}</td>
              <td className={showJackets ? "cell-name with-jacket" : "cell-name"}>
                {showJackets ? (() => {
                  const track = findTrackForRow(r, catalogLookup);
                  const jacket = resolveTrackJacketUrl(track);
                  return (
                    <span className="jacket-inline">
                      {jacket ? <img src={jacket} alt="" className="song-jacket" loading="lazy" /> : <span className="song-jacket placeholder" />}
                      <span>{r.name}</span>
                    </span>
                  );
                })() : r.name}
              </td>
              <td>{r.difficulty.slice(0, 3)}</td>
              <td>{displayConstForRow(r, catalogLookup, fallbackConstMap, fallbackCandidatesMap)}</td>
              <td>{(isTech ? r.technicalHighScore : r.platinumHighScore).toLocaleString("ja-JP")}</td>
              <td>{isTech ? r.lampForRating : r.platinumStar}</td>
              <td>{(isTech ? r.techRate : r.platRate).toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
