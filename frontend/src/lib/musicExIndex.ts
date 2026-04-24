/**
 * music-ex.json 배열에서 프론트 전반이 쓰는 조회 인덱스를 한 번에 만들어 둔다.
 * 여러 페이지에서 동일한 변환을 반복하던 부분을 공유한다.
 */

import { makeConstKey, parseConst, type ConstCandidate } from "./ratingCalc";

const DIFFICULTIES: Array<[difficulty: string, constField: string, levelField: string]> = [
  ["BASIC", "lev_bas_i", "lev_bas"],
  ["ADVANCED", "lev_adv_i", "lev_adv"],
  ["EXPERT", "lev_exc_i", "lev_exc"],
  ["MASTER", "lev_mas_i", "lev_mas"],
  ["LUNATIC", "lev_lnt_i", "lev_lnt"],
];

type MusicExIndex = {
  /** title+difficulty → 최초로 확인된 定数 값. 폴백용. */
  constMap: Map<string, number>;
  /** title+difficulty → 모든 定数 후보(레벨별로 구분). 여러 버전 공존시 근사 매칭에 사용. */
  candidatesMap: Map<string, ConstCandidate[]>;
  /** title+difficulty → 곡 버전 문자열. 신곡 판정에 활용. */
  versionMap: Map<string, string>;
};

export function buildMusicExIndex(data: unknown[]): MusicExIndex {
  const constMap = new Map<string, number>();
  const candidatesMap = new Map<string, ConstCandidate[]>();
  const versionMap = new Map<string, string>();
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const title = String(row.title ?? "").trim();
    if (!title) continue;
    const version = String(row.version ?? "").trim();
    for (const [difficulty, constField, levelField] of DIFFICULTIES) {
      const c = parseConst(row[constField]);
      if (c === undefined) continue;
      const key = makeConstKey(title, difficulty);
      if (!constMap.has(key)) constMap.set(key, c);
      const level = String(row[levelField] ?? "").trim();
      if (!candidatesMap.has(key)) candidatesMap.set(key, []);
      candidatesMap.get(key)?.push({ constVal: c, level });
      if (version && !versionMap.has(key)) versionMap.set(key, version);
    }
  }
  return { constMap, candidatesMap, versionMap };
}
