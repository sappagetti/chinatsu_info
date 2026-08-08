/**
 * 보면정수 붙여넣기 파서.
 * 지원 형식 (탭/공백 혼용, 헤더 행 무시):
 *   曲名\t難易度\tレベル\t定数
 *   それはもうらぶちゅ	MASTER	13	13.5
 */

export type ConstOverrideSong = {
  title: string;
  lev_bas_i?: string;
  lev_adv_i?: string;
  lev_exc_i?: string;
  lev_mas_i?: string;
  lev_lnt_i?: string;
  force?: boolean;
};

const DIFF_FIELD: Record<string, keyof ConstOverrideSong> = {
  BASIC: "lev_bas_i",
  ADVANCED: "lev_adv_i",
  ADV: "lev_adv_i",
  EXPERT: "lev_exc_i",
  EXP: "lev_exc_i",
  MASTER: "lev_mas_i",
  MAS: "lev_mas_i",
  LUNATIC: "lev_lnt_i",
  LNT: "lev_lnt_i",
};

function normalizeDiff(raw: string): string {
  return raw.normalize("NFKC").trim().toUpperCase();
}

function looksLikeHeader(cols: string[]): boolean {
  const joined = cols.join(" ").toLowerCase();
  return (
    joined.includes("曲名") ||
    joined.includes("title") ||
    joined.includes("難易度") ||
    joined.includes("定数") ||
    (cols[0]?.toLowerCase() === "name" && cols.length >= 3)
  );
}

function splitLine(line: string): string[] {
  if (line.includes("\t")) {
    return line.split("\t").map((s) => s.trim());
  }
  // 공백 구분: 마지막 두 토큰이 level/const, 앞에서 난이도 키워드를 찾음
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3) return parts;
  // 뒤에서부터 const, level, diff 추정
  const constTok = parts[parts.length - 1]!;
  const levelTok = parts[parts.length - 2]!;
  const maybeDiff = parts[parts.length - 3]!;
  if (DIFF_FIELD[normalizeDiff(maybeDiff)]) {
    const title = parts.slice(0, -3).join(" ").trim();
    return [title, maybeDiff, levelTok, constTok];
  }
  return parts;
}

/** 붙여넣기 텍스트 → override song entries (같은 곡 난이도는 한 entry 로 합침) */
export function parseConstOverridePaste(text: string, force = false): ConstOverrideSong[] {
  const byTitle = new Map<string, ConstOverrideSong>();
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = splitLine(line).filter((c) => c.length > 0);
    if (cols.length < 3) continue;
    if (looksLikeHeader(cols)) continue;

    // title, diff, (level?), const — level 은 선택
    let title: string;
    let diff: string;
    let constVal: string;
    if (cols.length >= 4) {
      title = cols[0]!;
      diff = cols[1]!;
      constVal = cols[3]!;
    } else {
      title = cols[0]!;
      diff = cols[1]!;
      constVal = cols[2]!;
    }
    title = title.trim();
    const field = DIFF_FIELD[normalizeDiff(diff)];
    if (!title || !field) continue;
    const n = Number.parseFloat(constVal);
    if (!Number.isFinite(n)) continue;
    const normalized = n.toFixed(1);

    const cur = byTitle.get(title) ?? { title };
    (cur as Record<string, string | boolean | undefined>)[field] = normalized;
    if (force) cur.force = true;
    byTitle.set(title, cur);
  }
  return [...byTitle.values()];
}
