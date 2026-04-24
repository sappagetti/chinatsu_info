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
  isBonusTrackText,
  isRefreshVersion,
  makeConstKey,
  normalizeTitle,
} from "../lib/ratingCalc";
import type { IngestScoreRow } from "../types/ingestPayload";
import { LoadingBar } from "../components/LoadingBar";

type RatedRow = IngestScoreRow & {
  rowId: string;
  resolvedConst: number;
  resolvedVersion: string;
  lampForRating: string;
  techRate: number;
  platRate: number;
  inferredFullCombo: boolean;
};

type CalcSummary = {
  total: number;
  newContrib: number;
  oldContrib: number;
  platContrib: number;
};
type ScenarioPatch = {
  score: number;
  star: number;
  fc: boolean;
  ab: boolean;
  fb: boolean;
};
type TargetPools = {
  newTop: RatedRow[];
  oldTop: RatedRow[];
  platTop: RatedRow[];
};

const NEW_COUNT = 10;
const OLD_COUNT = 50;
const PLAT_COUNT = 50;
const musicExUrl = import.meta.env.VITE_BEATMAP_BUCKET_URL?.trim() ?? "";
const SIM_STORAGE_PREFIX = "rating-sim-v1";

function calcTotalRating(rows: RatedRow[]): CalcSummary {
  const newPool = rows.filter((r) => isRefreshVersion(r.resolvedVersion)).sort((a, b) => b.techRate - a.techRate || b.technicalHighScore - a.technicalHighScore);
  const oldPool = rows.filter((r) => !isRefreshVersion(r.resolvedVersion)).sort((a, b) => b.techRate - a.techRate || b.technicalHighScore - a.technicalHighScore);
  const platPool = rows.filter((r) => r.platinumHighScore > 0).sort((a, b) => b.platRate - a.platRate || b.platinumStar - a.platinumStar);
  const newContrib = Math.floor(((newPool.slice(0, NEW_COUNT).reduce((a, r) => a + r.techRate, 0) / NEW_COUNT) / 5) * 1000) / 1000;
  const oldContrib = Math.floor((oldPool.slice(0, OLD_COUNT).reduce((a, r) => a + r.techRate, 0) / OLD_COUNT) * 1000) / 1000;
  const platContrib = Math.floor((platPool.slice(0, PLAT_COUNT).reduce((a, r) => a + r.platRate, 0) / PLAT_COUNT) * 1000) / 1000;
  return { total: Math.floor((newContrib + oldContrib + platContrib) * 1000) / 1000, newContrib, oldContrib, platContrib };
}
function getTargetPools(rows: RatedRow[]): TargetPools {
  const newTop = rows
    .filter((r) => isRefreshVersion(r.resolvedVersion))
    .sort((a, b) => b.techRate - a.techRate || b.technicalHighScore - a.technicalHighScore)
    .slice(0, NEW_COUNT);
  const oldTop = rows
    .filter((r) => !isRefreshVersion(r.resolvedVersion))
    .sort((a, b) => b.techRate - a.techRate || b.technicalHighScore - a.technicalHighScore)
    .slice(0, OLD_COUNT);
  const platTop = rows
    .filter((r) => r.platinumHighScore > 0)
    .sort((a, b) => b.platRate - a.platRate || b.platinumStar - a.platinumStar)
    .slice(0, PLAT_COUNT);
  return { newTop, oldTop, platTop };
}

export function RatingSimulatorPage() {
  const { user } = useAuth();
  const token = user?.ingest_token ?? "";
  const storageKey = user ? `${SIM_STORAGE_PREFIX}:${user.user_id}` : `${SIM_STORAGE_PREFIX}:guest`;
  const [loading, setLoading] = useState(!!token);
  const [err, setErr] = useState<string | null>(null);
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);
  const [constMap, setConstMap] = useState<Map<string, number>>(new Map());
  const [versionMap, setVersionMap] = useState<Map<string, string>>(new Map());
  const [scenarioMap, setScenarioMap] = useState<Record<string, ScenarioPatch>>({});
  const [constFilter, setConstFilter] = usePersistedState<string>("rating-sim.constFilter", "15+", {
    validate: (v) => typeof v === "string",
  });
  const [showTargetsOverlay, setShowTargetsOverlay] = useState(false);
  const [showJackets, setShowJackets] = usePersistedState<boolean>("rating-sim.showJackets", true, {
    validate: (v) => typeof v === "boolean",
  });
  const catalogByID = useMemo(() => indexMusicCatalogById(extractMusicCatalog(payload)), [payload]);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const me = await fetchMe(token);
        if (!cancelled) setPayload(me.last_payload as Record<string, unknown> | null);
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
        const { constMap: cm, versionMap: vm } = buildMusicExIndex(data);
        if (!cancelled) {
          setConstMap(cm);
          setVersionMap(vm);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const baseRows = useMemo<RatedRow[]>(() => {
    const catalog = extractMusicCatalog(payload);
    const byId = catalogByID;
    const bonusTitleSet = new Set(
      catalog
        .filter((t) => Object.values(t).some((v) => isBonusTrackText(String(v ?? ""))))
        .map((t) => normalizeTitle(String(t.title ?? "")))
        .filter(Boolean),
    );
    return extractScoreRows(payload)
      .filter((r) => {
        const cat = r.music_ex_id ? byId.get(r.music_ex_id) : undefined;
        if (cat && Object.values(cat).some((v) => isBonusTrackText(String(v ?? "")))) return false;
        if (bonusTitleSet.has(normalizeTitle(r.name))) return false;
        return true;
      })
      .map((r, i) => {
      const byID = r.music_ex_id ? byId.get(r.music_ex_id) : undefined;
      const key = makeConstKey(r.name, r.difficulty);
      const resolvedConst = r.const ?? catalogConstByDifficulty(byID, r.difficulty) ?? constMap.get(key) ?? 0;
      const inferredFullCombo = r.fullCombo === true || r.allBreak === true;
      const lamp = getLampForRating(r.technicalHighScore, r.fullBell, inferredFullCombo, r.allBreak);
      const techRate = resolvedConst > 0 ? calcMainRate(resolvedConst, r.technicalHighScore) + calcRankBonus(r.technicalHighScore) + calcLampBonus(lamp) : 0;
      const platRate = resolvedConst > 0 ? calcPlatinumRate(resolvedConst, r.platinumStar) : 0;
      const stableRowID = r.music_ex_id?.trim() ? `${r.music_ex_id}:${r.difficulty}` : `${r.name}-${r.difficulty}-${i}`;
      return { ...r, rowId: stableRowID, resolvedConst, resolvedVersion: (r.version && r.version.trim()) || versionMap.get(key) || "", lampForRating: lamp, techRate, platRate, inferredFullCombo };
    });
  }, [payload, constMap, versionMap, catalogByID]);

  const scenarioEntries = useMemo(
    () =>
      Object.entries(scenarioMap)
        .map(([rowId, patch]) => {
          const row = baseRows.find((r) => r.rowId === rowId);
          return row ? { row, patch } : null;
        })
        .filter((v): v is { row: RatedRow; patch: ScenarioPatch } => v !== null),
    [scenarioMap, baseRows],
  );
  const selectableRows = useMemo(() => {
    return baseRows
      .filter((r) => String(r.level ?? "").trim() === constFilter)
      .sort((a, b) => {
        const c = (b.resolvedConst ?? -1) - (a.resolvedConst ?? -1);
        if (c !== 0) return c;
        return b.technicalHighScore - a.technicalHighScore;
      });
  }, [baseRows, constFilter]);

  function defaultPatchForRow(row: RatedRow): ScenarioPatch {
    return {
      score: row.technicalHighScore,
      star: Math.max(0, row.platinumStar),
      fc: row.inferredFullCombo,
      ab: row.allBreak,
      fb: row.fullBell,
    };
  }
  function addScenarioRow(row: RatedRow) {
    setScenarioMap((prev) => {
      if (prev[row.rowId]) return prev;
      return { ...prev, [row.rowId]: defaultPatchForRow(row) };
    });
  }
  function removeScenarioRow(rowId: string) {
    setScenarioMap((prev) => {
      const next = { ...prev };
      delete next[rowId];
      return next;
    });
  }
  function clearScenario() {
    setScenarioMap({});
  }
  function updateScenario(row: RatedRow, nextPatch: Partial<ScenarioPatch>) {
    setScenarioMap((prev) => {
      const curr = prev[row.rowId] ?? defaultPatchForRow(row);
      let merged: ScenarioPatch = { ...curr, ...nextPatch };
      merged = {
        ...merged,
        score: Math.max(0, Math.min(1010000, Math.floor(merged.score || 0))),
        star: Math.max(row.platinumStar, Math.min(5, Math.max(0, Math.floor(merged.star || 0)))),
      };
      if (row.inferredFullCombo) merged.fc = true;
      if (row.allBreak) merged.ab = true;
      if (row.fullBell) merged.fb = true;
      return { ...prev, [row.rowId]: merged };
    });
  }

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const valid: Record<string, ScenarioPatch> = {};
      for (const [rowId, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!v || typeof v !== "object" || Array.isArray(v)) continue;
        const p = v as Partial<ScenarioPatch>;
        if (
          typeof p.score !== "number" ||
          typeof p.star !== "number" ||
          typeof p.fc !== "boolean" ||
          typeof p.ab !== "boolean" ||
          typeof p.fb !== "boolean"
        ) {
          continue;
        }
        valid[rowId] = {
          score: p.score,
          star: p.star,
          fc: p.fc,
          ab: p.ab,
          fb: p.fb,
        };
      }
      setScenarioMap(valid);
    } catch {
      // ignore parse/storage failures
    }
  }, [storageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(scenarioMap));
    } catch {
      // ignore quota/storage failures
    }
  }, [storageKey, scenarioMap]);

  useEffect(() => {
    if (baseRows.length === 0) return;
    setScenarioMap((prev) => {
      const rowIds = new Set(baseRows.map((r) => r.rowId));
      let changed = false;
      const next: Record<string, ScenarioPatch> = {};
      for (const [rowId, patch] of Object.entries(prev)) {
        if (rowIds.has(rowId)) next[rowId] = patch;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [baseRows]);

  const currentSummary = useMemo(() => calcTotalRating(baseRows), [baseRows]);
  const simulatedRows = useMemo(() => {
    if (scenarioEntries.length === 0) return baseRows;
    const patchMap = new Map<string, ScenarioPatch>();
    for (const it of scenarioEntries) patchMap.set(it.row.rowId, it.patch);
    return baseRows.map((r) => {
      const patch = patchMap.get(r.rowId);
      if (!patch) return r;
      const technicalHighScore = Math.max(r.technicalHighScore, Math.min(1010000, Math.floor(patch.score || 0)));
      const allBreak = r.allBreak || patch.ab;
      const inferredFullCombo = r.inferredFullCombo || patch.fc || allBreak;
      const fullBell = r.fullBell || patch.fb;
      const platinumStar = Math.max(r.platinumStar, Math.min(5, Math.max(0, Math.floor(patch.star || 0))));
      // 미플레이 곡(원래 platinumHighScore = 0)에서도 사용자가 플라티나 스타를 지정했다면
      // 시뮬레이션상 "해당 곡을 플레이한 것"으로 간주하여 플라티나 풀 필터에 포함되도록 한다.
      const platinumHighScore = r.platinumHighScore > 0 || platinumStar > 0 ? Math.max(r.platinumHighScore, 1) : 0;
      const lamp = getLampForRating(technicalHighScore, fullBell, inferredFullCombo, allBreak);
      const techRate = r.resolvedConst > 0 ? calcMainRate(r.resolvedConst, technicalHighScore) + calcRankBonus(technicalHighScore) + calcLampBonus(lamp) : 0;
      const platRate = r.resolvedConst > 0 ? calcPlatinumRate(r.resolvedConst, platinumStar) : 0;
      return { ...r, technicalHighScore, allBreak, fullBell, inferredFullCombo, platinumHighScore, platinumStar, lampForRating: lamp, techRate, platRate };
    });
  }, [baseRows, scenarioEntries]);
  const simulatedSummary = useMemo(() => calcTotalRating(simulatedRows), [simulatedRows]);
  const currentPools = useMemo(() => getTargetPools(baseRows), [baseRows]);
  const simulatedPools = useMemo(() => getTargetPools(simulatedRows), [simulatedRows]);
  const targetDiff = useMemo(() => {
    const calc = (before: RatedRow[], after: RatedRow[]) => {
      const beforeMap = new Map(before.map((r) => [r.rowId, r]));
      const afterMap = new Map(after.map((r) => [r.rowId, r]));
      const outRows: RatedRow[] = [];
      const inRows: RatedRow[] = [];
      for (const r of before) if (!afterMap.has(r.rowId)) outRows.push(r);
      for (const r of after) if (!beforeMap.has(r.rowId)) inRows.push(r);
      return { outRows, inRows };
    };
    return {
      newDiff: calc(currentPools.newTop, simulatedPools.newTop),
      oldDiff: calc(currentPools.oldTop, simulatedPools.oldTop),
      platDiff: calc(currentPools.platTop, simulatedPools.platTop),
    };
  }, [currentPools, simulatedPools]);
  const scenarioDiffRows = useMemo(
    () =>
      scenarioEntries.map(({ row }) => {
        const after = simulatedRows.find((r) => r.rowId === row.rowId) ?? row;
        return {
          row,
          after,
          techDelta: after.techRate - row.techRate,
          platDelta: after.platRate - row.platRate,
        };
      }),
    [scenarioEntries, simulatedRows],
  );
  const scenarioDiffMap = useMemo(() => {
    const map = new Map<string, { beforeTech: number; afterTech: number; beforePlat: number; afterPlat: number }>();
    for (const { row, after } of scenarioDiffRows) {
      map.set(row.rowId, {
        beforeTech: row.techRate,
        afterTech: after.techRate,
        beforePlat: row.platRate,
        afterPlat: after.platRate,
      });
    }
    return map;
  }, [scenarioDiffRows]);

  if (!token) return <article className="prose"><h1>レーティング目標計算</h1><LoadingBar /></article>;
  if (loading) return <article className="prose"><h1>レーティング目標計算</h1><LoadingBar /></article>;
  if (err) return <article className="prose"><h1>レーティング目標計算</h1><p className="error">{err}</p></article>;

  return (
    <article className="prose">
      <h1>レーティング目標達成計算機</h1>
      <p className="muted">複数曲をシナリオに追加して、想定達成値を同時入力できます。曲別差分と総合レート差分を確認できます。</p>
      <div className="row sim-controls">
        <label className="sim-level-filter">
          レベル
          <select className="input" value={constFilter} onChange={(e) => setConstFilter(e.target.value)}>
            {["15+", "15", "14+", "14", "13+", "13", "12+", "12", "11+", "11", "10+", "10", "9+", "9", "8+", "8", "7+", "7", "6+", "6", "5+", "5", "4+", "4", "3+", "3", "2+", "2", "1+", "1", "0"].map((lv) => (
              <option key={lv} value={lv}>Lv{lv}</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn secondary" disabled={scenarioEntries.length === 0} onClick={clearScenario}>
          初期化
        </button>
        <label className="theme-toggle" title="ジャケット表示切替">
          <input type="checkbox" checked={showJackets} onChange={(e) => setShowJackets(e.target.checked)} />
          <span className="theme-toggle-track" />
          <span className="theme-toggle-label">{showJackets ? "ジャケット: ON" : "ジャケット: OFF"}</span>
        </label>
      </div>

      <div className="table-wrap sim-scroll-box">
        <table className="data-table simulator-table">
          <thead>
            <tr><th>Title</th><th>Dif</th><th>定数</th><th>Score</th><th /></tr>
          </thead>
          <tbody>
            {selectableRows.map((r) => (
              <tr key={r.rowId}>
                    <td className={showJackets ? "cell-name with-jacket" : "cell-name"}>
                      {showJackets ? (() => {
                        const track = r.music_ex_id ? catalogByID.get(r.music_ex_id) : undefined;
                        const jacket = resolveTrackJacketUrl(track);
                        return (
                          <span className="jacket-inline">
                            {jacket ? <img src={jacket} alt="" className="song-jacket" loading="lazy" /> : <span className="song-jacket placeholder" />}
                            <span>{r.name}</span>
                          </span>
                        );
                      })() : r.name}
                    </td>
                <td>{r.difficulty}</td>
                <td>{r.resolvedConst > 0 ? r.resolvedConst.toFixed(1) : ""}</td>
                <td>{r.technicalHighScore.toLocaleString("ja-JP")}</td>
                <td>
                  <button
                    type="button"
                    className="btn"
                    disabled={!!scenarioMap[r.rowId]}
                    onClick={() => addScenarioRow(r)}
                  >
                    追加
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {scenarioEntries.length > 0 ? (
        <div className="table-wrap sim-scroll-box compact">
          <table className="data-table simulator-table">
            <thead>
              <tr><th>曲</th><th>Score</th><th>Star</th><th>FC</th><th>AB</th><th>FB</th><th>rate</th><th>Pスコア rate</th><th /></tr>
            </thead>
            <tbody>
              {scenarioEntries.map(({ row, patch }) => {
                const diff = scenarioDiffMap.get(row.rowId);
                return (
                  <tr key={row.rowId}>
                    <td className={showJackets ? "cell-name with-jacket" : "cell-name"}>
                      {showJackets ? (() => {
                        const track = row.music_ex_id ? catalogByID.get(row.music_ex_id) : undefined;
                        const jacket = resolveTrackJacketUrl(track);
                        return (
                          <span className="jacket-inline">
                            {jacket ? <img src={jacket} alt="" className="song-jacket" loading="lazy" /> : <span className="song-jacket placeholder" />}
                            <span>{row.name} [{row.difficulty}]</span>
                          </span>
                        );
                      })() : `${row.name} [${row.difficulty}]`}
                    </td>
                    <td><input className="input" type="number" min={0} max={1010000} value={patch.score} onChange={(e) => updateScenario(row, { score: Number(e.target.value || 0) })} /></td>
                    <td>
                      <select className="input" value={patch.star} onChange={(e) => updateScenario(row, { star: Number(e.target.value) })}>
                        {[0, 1, 2, 3, 4, 5].map((n) => (
                          <option key={n} value={n} disabled={n < row.platinumStar}>{n}★</option>
                        ))}
                      </select>
                    </td>
                    <td><input type="checkbox" checked={patch.fc} disabled={row.inferredFullCombo} onChange={(e) => updateScenario(row, { fc: e.target.checked })} /></td>
                    <td><input type="checkbox" checked={patch.ab} disabled={row.allBreak} onChange={(e) => updateScenario(row, { ab: e.target.checked })} /></td>
                    <td><input type="checkbox" checked={patch.fb} disabled={row.fullBell} onChange={(e) => updateScenario(row, { fb: e.target.checked })} /></td>
                    <td>{row.resolvedConst > 0 && diff ? `${diff.beforeTech.toFixed(3)} → ${diff.afterTech.toFixed(3)}` : ""}</td>
                    <td>{row.resolvedConst > 0 && diff ? `${diff.beforePlat.toFixed(3)} → ${diff.afterPlat.toFixed(3)}` : ""}</td>
                    <td><button type="button" className="btn secondary" onClick={() => removeScenarioRow(row.rowId)}>削除</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">上の選択欄から曲を追加してください。</p>
      )}

      <div className="table-wrap">
        <table className="data-table simulator-table">
          <thead><tr><th>項目</th><th>現在</th><th>想定後</th><th>差分</th></tr></thead>
          <tbody>
            <tr><td>総合RATING</td><td>{currentSummary.total.toFixed(3)}</td><td>{simulatedSummary.total.toFixed(3)}</td><td>{(simulatedSummary.total - currentSummary.total).toFixed(3)}</td></tr>
            <tr><td>新曲寄与</td><td>{currentSummary.newContrib.toFixed(3)}</td><td>{simulatedSummary.newContrib.toFixed(3)}</td><td>{(simulatedSummary.newContrib - currentSummary.newContrib).toFixed(3)}</td></tr>
            <tr><td>ベスト寄与</td><td>{currentSummary.oldContrib.toFixed(3)}</td><td>{simulatedSummary.oldContrib.toFixed(3)}</td><td>{(simulatedSummary.oldContrib - currentSummary.oldContrib).toFixed(3)}</td></tr>
            <tr><td>プラチナ寄与</td><td>{currentSummary.platContrib.toFixed(3)}</td><td>{simulatedSummary.platContrib.toFixed(3)}</td><td>{(simulatedSummary.platContrib - currentSummary.platContrib).toFixed(3)}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="row">
        <button type="button" className="btn secondary" onClick={() => setShowTargetsOverlay(true)}>
          レーティング対象曲を表示
        </button>
      </div>

      <div className="table-wrap">
        <table className="data-table simulator-table">
          <thead><tr><th>枠</th><th>OUT</th><th>IN</th></tr></thead>
          <tbody>
            <tr><td>新曲枠</td><td>{targetDiff.newDiff.outRows.map((r) => `${r.name}[${r.difficulty}]`).join(", ") || "-"}</td><td>{targetDiff.newDiff.inRows.map((r) => `${r.name}[${r.difficulty}]`).join(", ") || "-"}</td></tr>
            <tr><td>ベスト枠</td><td>{targetDiff.oldDiff.outRows.map((r) => `${r.name}[${r.difficulty}]`).join(", ") || "-"}</td><td>{targetDiff.oldDiff.inRows.map((r) => `${r.name}[${r.difficulty}]`).join(", ") || "-"}</td></tr>
            <tr><td>プラチナ枠</td><td>{targetDiff.platDiff.outRows.map((r) => `${r.name}[${r.difficulty}]`).join(", ") || "-"}</td><td>{targetDiff.platDiff.inRows.map((r) => `${r.name}[${r.difficulty}]`).join(", ") || "-"}</td></tr>
          </tbody>
        </table>
      </div>

      {showTargetsOverlay && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 9999, padding: "2rem", overflow: "auto" }}>
          <div style={{ maxWidth: "72rem", margin: "0 auto", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "12px", padding: "1rem" }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>想定後レーティング対象曲</strong>
              <button type="button" className="btn secondary" onClick={() => setShowTargetsOverlay(false)}>閉じる</button>
            </div>
            <h2>新曲枠 Top {NEW_COUNT}</h2>
            <SimpleTargetTable rows={simulatedPools.newTop} kind="tech" catalogByID={catalogByID} showJackets={showJackets} />
            <h2>ベスト枠 Top {OLD_COUNT}</h2>
            <SimpleTargetTable rows={simulatedPools.oldTop} kind="tech" catalogByID={catalogByID} showJackets={showJackets} />
            <h2>プラチナ枠 Top {PLAT_COUNT}</h2>
            <SimpleTargetTable rows={simulatedPools.platTop} kind="plat" catalogByID={catalogByID} showJackets={showJackets} />
          </div>
        </div>
      )}
    </article>
  );
}

function SimpleTargetTable({
  rows,
  kind,
  catalogByID,
  showJackets,
}: {
  rows: RatedRow[];
  kind: "tech" | "plat";
  catalogByID: Map<string, Record<string, string>>;
  showJackets: boolean;
}) {
  return (
    <div className="table-wrap">
      <table className="data-table simulator-table">
        <thead><tr><th>#</th><th>曲</th><th>Dif</th><th>Lv</th><th>Rate</th></tr></thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={`${r.rowId}-${kind}`}>
              <td>{idx + 1}</td>
              <td className={showJackets ? "cell-name with-jacket" : "cell-name"}>
                {showJackets ? (() => {
                  const track = r.music_ex_id ? catalogByID.get(r.music_ex_id) : undefined;
                  const jacket = resolveTrackJacketUrl(track);
                  return (
                    <span className="jacket-inline">
                      {jacket ? <img src={jacket} alt="" className="song-jacket" loading="lazy" /> : <span className="song-jacket placeholder" />}
                      <span>{r.name}</span>
                    </span>
                  );
                })() : r.name}
              </td>
              <td>{r.difficulty}</td>
              <td>{r.level}</td>
              <td>{(kind === "tech" ? r.techRate : r.platRate).toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
