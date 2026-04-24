/**
 * 오는게키 레이팅 계산용 순수 함수 모음.
 *
 * 백엔드(`backend/cmd/server/rating_targets.go`)의 동일 로직과 동작이 맞아야 하므로,
 * 수정 시 양쪽을 함께 갱신할 것.
 * Vitest 단위 테스트는 `frontend/src/lib/__tests__/ratingCalc.test.ts` 참조.
 */

export function normalizeTitle(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, "").trim().toLowerCase();
}

export function isBonusTrackText(v: string): boolean {
  const t = v.normalize("NFKC").toLowerCase();
  return (
    t.includes("ボーナス") ||
    t.includes("bonustrack") ||
    t.includes("bonus track") ||
    t.includes("bonus")
  );
}

export function makeConstKey(title: string, difficulty: string): string {
  return `${normalizeTitle(title)}::${difficulty}`;
}

export function parseConst(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

export function isRefreshVersion(version: string | undefined): boolean {
  const v = (version ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  return v.includes("re:fresh") || v.includes("refresh");
}

/**
 * 기본 레이트(定数 기반). 백엔드 `calcMainRate` 와 수치적으로 동일해야 함.
 * 구간별 정수 나눗셈은 Go의 `int / int` 와 맞추기 위해 `Math.floor` 를 사용.
 */
export function calcMainRate(constVal: number, technical: number): number {
  const extra = constVal * 1000;
  let result = 0;
  if (technical === 1010000) result = extra + 2000;
  else if (technical >= 1007500) result = extra + 1750 + Math.floor((technical - 1007500) / 10);
  else if (technical >= 1000000) result = extra + 1250 + Math.floor((technical - 1000000) / 15);
  else if (technical >= 990000) result = extra + 750 + Math.floor((technical - 990000) / 20);
  else if (technical >= 970000) result = extra + Math.floor((technical - 970000) / 26.666);
  else result = extra - Math.floor((970000 - technical) / 18);
  return Math.max(0, result) / 1000;
}

export function calcRankBonus(technical: number): number {
  if (technical >= 1007500) return 0.3;
  if (technical >= 1000000) return 0.2;
  if (technical >= 990000) return 0.1;
  return 0;
}

export function getLampForRating(
  technical: number,
  fullBell: boolean,
  fullCombo: boolean,
  allBreak: boolean,
): string {
  if (technical === 1010000) return fullBell ? "FB/AB+" : "AB+";
  if (allBreak) return fullBell ? "FB/AB" : "AB";
  if (fullCombo) return fullBell ? "FB/FC" : "FC";
  if (fullBell) return "FB";
  return "";
}

export function calcLampBonus(lamp: string): number {
  if (lamp === "FB/AB+") return 0.4;
  if (lamp === "AB+" || lamp === "FB/AB") return 0.35;
  if (lamp === "AB") return 0.3;
  if (lamp === "FB/FC") return 0.15;
  if (lamp === "FC") return 0.1;
  if (lamp === "FB") return 0.05;
  return 0;
}

export function calcPlatinumRate(constVal: number, star: number): number {
  const s = Math.max(0, Math.min(5, star));
  return (constVal * constVal * s) / 1000;
}

/** "14.0" → "14", 공백·전각 온점·일본어 온점 등을 정규화 */
export function normalizeLevel(raw: string): string {
  const s = raw.normalize("NFKC").replace(/\s+/g, "").replace(/．/g, ".").replace(/。/g, ".").trim();
  if (!s) return "";
  if (/^\d+\.0$/.test(s)) return s.replace(/\.0$/, "");
  return s;
}

/** 정규화된 레벨 문자열을 수치로 변환한다. "13+" → 13.7 (근사치). */
function levelToNumber(level: string): number | undefined {
  const lv = normalizeLevel(level);
  if (!lv) return undefined;
  if (lv.endsWith("+")) {
    const n = Number.parseInt(lv.slice(0, -1), 10);
    return Number.isFinite(n) ? n + 0.7 : undefined;
  }
  const n = Number.parseFloat(lv);
  return Number.isFinite(n) ? n : undefined;
}

export type ConstCandidate = { constVal: number; level: string };

/**
 * 같은 제목·난이도에 여러 const 후보가 있을 때, 행의 level 과 가장 가까운 값을 고른다.
 * - 보통은 동일 곡/난이도에 1 건이지만, 과거 버전 이력이 남아 다건일 수 있다.
 */
export function pickBestConstCandidate(
  row: { level: string },
  candidates: ConstCandidate[],
): number | undefined {
  if (candidates.length === 0) return undefined;
  const rowLevelNum = levelToNumber(row.level);
  if (rowLevelNum === undefined) return candidates[0]?.constVal;
  let best = candidates[0];
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const cLevelNum = levelToNumber(c.level);
    if (cLevelNum === undefined) continue;
    const diff = Math.abs(cLevelNum - rowLevelNum);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best.constVal;
}
