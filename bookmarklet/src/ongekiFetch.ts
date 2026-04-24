/**
 * オンゲキNETからプレーデータを取得し、譜面情報と結合する処理。
 * - マイページ: record/musicGenre/search の HTML をパース
 * - 譜面定数など: CSV または music-ex.json（lev_*_i）で結合
 */

import Papa from "papaparse";
import { withElapsedLog } from "./elapsedLog";

/** Same origin as the page running the bookmarklet (avoids www vs apex cookie mismatch). */
export function ongekiMobileOrigin(): string {
  if (typeof location !== "undefined" && /\.ongeki-net\.com$/i.test(location.hostname)) {
    return location.origin;
  }
  return "https://ongeki-net.com";
}

/**
 * ブックマークレットは「今開いているタブ」の document 上で動く。fetch の Referer を
 * 実際の表示 URL に合わせないと、オンゲキ側でセッション無効（エラー HTML）につながることがある。
 * DevTools のコピーでは record検索なども Referer: .../home/ になっている例が多い。
 */
export function ongekiDocumentReferer(): string {
  const fallback = `${ongekiMobileOrigin()}/ongeki-mobile/home/`;
  if (typeof location === "undefined") return fallback;
  if (!/\.ongeki-net\.com$/i.test(location.hostname)) return fallback;
  try {
    const u = new URL(location.href);
    u.hash = "";
    if (!u.pathname.startsWith("/ongeki-mobile/")) {
      return fallback;
    }
    return u.toString();
  } catch {
    return fallback;
  }
}

type UserDataScoreDifficultyType =
  | "BASIC"
  | "ADVANCED"
  | "EXPERT"
  | "MASTER"
  | "LUNATIC";

type UserDataScoreType = {
  difficulty: UserDataScoreDifficultyType;
  level: string;
  name: string;
  genre: string;
  technicalHighScore: number;
  overDamageHighScore: number;
  battleHighScore: number;
  fullBell: boolean;
  fullCombo: boolean;
  allBreak: boolean;
  platinumHighScore: number;
  platinumStar: number;
  platinumMaxScore: number;
  /** オンゲキNET 側で取得できたときだけ付与する譜面ID（music-ex id 相当） */
  musicExId?: string;
};

type BeatmapDataDifficultyType = UserDataScoreDifficultyType;

type BeatmapDataType = {
  name: string;
  genre: string;
  character: string;
  version: string;
  difficulty: BeatmapDataDifficultyType;
  level?: string;
  const: number | undefined;
  /** music-ex.json の id（CSV 由来のときは無し） */
  musicExId?: string;
};

type CombinedRow = {
  name: string;
  difficulty: UserDataScoreDifficultyType;
  level: string;
  genre: string;
  technicalHighScore: number;
  overDamageHighScore: number;
  battleHighScore: number;
  fullBell: boolean;
  fullCombo: boolean;
  allBreak: boolean;
  const: number | undefined;
  platinumHighScore: number;
  platinumStar: number;
  platinumMaxScore: number;
  character: string | undefined;
  version: string | undefined;
  /** scores と music_catalog を id で結合するためのキー */
  music_ex_id?: string;
};

/** music-ex の1曲分（値は文字列に揃えて保持） */
type MusicExTrack = Record<string, string>;

type MusicCatalogMeta = {
  schema: "otoge-db/music-ex";
  source_url: string;
  track_count: number;
};

type FetchBeatmapResult = {
  beatmaps: BeatmapDataType[];
  /** music-ex.json 経由のときのみ全曲メタ */
  musicCatalog: MusicExTrack[] | null;
  musicCatalogSourceUrl: string | null;
};

type CourseSubscription = {
  /** スタンダードコース（マイページ相当の閲覧に必要な想定） */
  standardActive: boolean;
  premiumActive: boolean;
};

/**
 * courseDetail の HTML を見て「利用中」か判定。
 */
async function checkCourseSubscription(log: (message: string) => void): Promise<CourseSubscription> {
  log("利用できる状態か確認しています…");
  const origin = ongekiMobileOrigin();
  const url = `${origin}/ongeki-mobile/courseDetail/`;
  const headers = new Headers();
  headers.append("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  headers.append("Accept-Language", "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7");
  headers.append("Referer", ongekiDocumentReferer());
  return withElapsedLog(log, "courseDetail の取得・解析", async () => {
    const response = await fetch(url, { headers, credentials: "include" });
    if (!response.ok) {
      throw new Error(`courseDetail の取得に失敗: ${response.status}`);
    }
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const standardText =
      doc.querySelector(".back_course_standard span")?.textContent?.trim() ?? "";
    const premiumText =
      doc.querySelector(".back_course_premium span")?.textContent?.trim() ?? "";
    const standardActive = standardText === "利用中";
    const premiumActive = premiumText === "利用中";
    if (standardActive) {
      log(
        `課金確認完了: スタンダードコース 利用中${premiumActive ? " / プレミアムコース 利用中" : ""}`,
      );
    } else {
      log("利用状況を確認できませんでした。時間をおいて再度お試しください。");
    }
    return { standardActive, premiumActive };
  });
}

/** ページコンテキストの fetch では Host/User-Agent 等は禁止されるため最小限に（拡張機能より緩い） */
function createHeaders(): Headers {
  const header = new Headers();
  header.append(
    "Accept",
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  );
  header.append("Accept-Language", "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7");
  header.append("Referer", ongekiDocumentReferer());
  return header;
}

async function fetchHtml(
  url: string,
  log: (message: string) => void,
  elapsedLabel: string,
): Promise<string> {
  return withElapsedLog(log, elapsedLabel, async () => {
    const response = await fetch(url, {
      headers: createHeaders(),
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error(`fetch ${url}: ${response.status}`);
    }
    return response.text();
  });
}

/**
 * ongekiMypageUserDataSource.parseScoreHTML と同じ DOM 前提（サイト改修で壊れる可能性あり）
 */
function parseScoreHTML(html: string, dif: UserDataScoreDifficultyType): UserDataScoreType[] {
  const domparser = new DOMParser();
  const doc = domparser.parseFromString(html, "text/html");
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("HTML Parse Error");
  }
  const divParentXpath = "/html/body/div[2]/div[5]";
  const divParentNode = doc.evaluate(
    divParentXpath,
    doc,
    null,
    XPathResult.FIRST_ORDERED_NODE_TYPE,
    null,
  ).singleNodeValue;
  // Layout can change on ongeki-net. Fall back to body scanning instead of hard-failing.
  const divParent = divParentNode instanceof HTMLElement ? divParentNode : doc.body;
  const datas: UserDataScoreType[] = [];
  let currnetGenre = "";
  const hasClass = (el: Element, cls: string): boolean =>
    el.classList.contains(cls) || (el.getAttribute("class") ?? "").split(/\s+/).includes(cls);
  const getDirectDivChildren = (parent: HTMLElement) => {
    const children = parent.getElementsByTagName("div");
    const directChildren: HTMLDivElement[] = [];
    for (const child of children) {
      if (child.parentElement === parent) {
        directChildren.push(child);
      }
    }
    return directChildren;
  };
  const extractMusicExIdFromForm = (form: HTMLFormElement): string | undefined => {
    const candidates: string[] = [];
    const queryCandidates: string[] = [];
    const action = form.getAttribute("action") ?? "";
    candidates.push(action);
    const href = (form as unknown as { action?: string }).action ?? "";
    candidates.push(href);
    for (const src of [action, href]) {
      if (!src) continue;
      try {
        const u = new URL(src, location.href);
        for (const key of ["idx", "music_id", "musicId", "music_ex_id"]) {
          const v = u.searchParams.get(key);
          if (v) queryCandidates.push(v);
        }
      } catch {
        // ignore malformed URL and continue
      }
    }
    const hiddenInputs = form.querySelectorAll("input[type='hidden'], input[name], input[id]");
    for (const input of hiddenInputs) {
      const name = (input.getAttribute("name") ?? "").toLowerCase();
      const id = (input.getAttribute("id") ?? "").toLowerCase();
      const value = (input.getAttribute("value") ?? "").trim();
      if (!value) continue;
      if (name === "idx" || name === "music_id" || name === "musicid" || name === "music_ex_id") queryCandidates.push(value);
      if (id === "idx" || id === "music_id" || id === "musicid" || id === "music_ex_id") queryCandidates.push(value);
    }
    const attrs = ["data-music-id", "data-idx", "data-music-ex-id"];
    for (const key of attrs) {
      const v = form.getAttribute(key);
      if (v) queryCandidates.push(v);
    }
    for (const raw of queryCandidates) {
      const m = raw.match(/^\d{3,}$/);
      if (m) return m[0];
    }
    for (const src of candidates) {
      if (!src) continue;
      const m = src.match(/(?:idx|music(?:_ex)?_?id|musicId)=([0-9]{3,})/i);
      if (m?.[1]) return m[1];
    }
    return undefined;
  };

  for (const child of divParent.childNodes) {
    if (child instanceof HTMLDivElement) {
      if (hasClass(child, "p_5") && hasClass(child, "f_20")) {
        currnetGenre = child.textContent || "";
      } else if (hasClass(child, "t_l") && hasClass(child, "f_0")) {
        // マイリスト画像 — 無視
      } else {
        const form = child.getElementsByTagName("form")[0];
        if (!form) continue;

        const formdivs = getDirectDivChildren(form);
        const div0 = formdivs[0];
        const div0divs = getDirectDivChildren(div0);
        const div0div0 = div0divs[0];
        const div0div0div0 = div0div0.getElementsByTagName("div")[0];
        const level = div0div0div0?.textContent || "";
        const div0div1 = div0divs[1];
        const name = div0div1?.textContent || "";
        const tables = form.getElementsByTagName("table");
        const extractedMusicExId = extractMusicExIdFromForm(form);
        if (tables.length === 0 || formdivs.length === 1) {
          datas.push({
            difficulty: dif,
            level,
            name,
            genre: currnetGenre,
            technicalHighScore: 0,
            overDamageHighScore: 0,
            battleHighScore: 0,
            fullBell: false,
            fullCombo: false,
            allBreak: false,
            platinumHighScore: 0,
            platinumStar: 0,
            platinumMaxScore: 0,
            musicExId: extractedMusicExId,
          });
          continue;
        }
        const table0 = tables[0];
        const table0tbody = table0.getElementsByTagName("tbody")[0];
        const table0tbodytr1 = table0tbody.getElementsByTagName("tr")[1];
        const table0tbodytr1td0 = table0tbodytr1.getElementsByTagName("td")[0];
        const overDamageHighScoreStr = table0tbodytr1td0.textContent || "";
        const overDamageHighScore = Number.parseFloat(overDamageHighScoreStr.replace("%", ""));
        const table0tbodytr1td1 = table0tbodytr1.getElementsByTagName("td")[1];
        const battleHighScoreStr = table0tbodytr1td1.textContent || "";
        const battleHighScore = Number.parseInt(battleHighScoreStr.replace(/,/g, ""), 10);
        const table0tbodytr1td2 = table0tbodytr1.getElementsByTagName("td")[2];
        const technicalHighScoreStr = table0tbodytr1td2.textContent || "";
        const technicalHighScore = Number.parseInt(technicalHighScoreStr.replace(/,/g, ""), 10);
        const div1 = formdivs[1];
        const div1table0 = div1.getElementsByTagName("table")[0];
        const div1table0tbody = div1table0.getElementsByTagName("tbody")[0];
        const div1table0tbodytr1 = div1table0tbody.getElementsByTagName("tr")[1];
        const div1table0tbodytr1td0 = div1table0tbodytr1.getElementsByTagName("td")[0];
        const div1table0tbodytr1td0_phssbs = div1table0tbodytr1td0.getElementsByClassName(
          "platinum_high_score_star_block",
        );
        const div1table0tbodytr1td0div0: HTMLDivElement | null =
          div1table0tbodytr1td0_phssbs.length > 0
            ? (div1table0tbodytr1td0_phssbs[0] as HTMLDivElement)
            : null;
        const div1table0tbodytr1td0div0divs = div1table0tbodytr1td0div0?.getElementsByTagName("div");
        let platinumStar = 0;
        if (div1table0tbodytr1td0div0divs && div1table0tbodytr1td0div0divs.length > 0) {
          const starDiv0 = div1table0tbodytr1td0div0divs[0];
          if (starDiv0.className === "platinum_score_star_r_block_s") {
            platinumStar = 6;
          } else {
            const starDiv1 = div1table0tbodytr1td0div0divs[1];
            platinumStar = Number(starDiv1.textContent || "0");
          }
        }
        const div1table0tbodytr1td0div1 = div1table0tbodytr1td0.getElementsByClassName(
          "platinum_high_score_text_block",
        )[0];
        const platinumText = div1table0tbodytr1td0div1?.textContent || "";
        const platinumParts = platinumText.split("/");
        const platinumHighScoreStr = (platinumParts[0] || "").trim();
        const platinumMaxScoreStr = (platinumParts[1] || "").trim();
        const platinumHighScore = Number.parseInt(platinumHighScoreStr.replace(/,/g, ""), 10);
        const platinumMaxScore = Number.parseInt(platinumMaxScoreStr.replace(/,/g, ""), 10);
        const div1div0 = getDirectDivChildren(div1)[0];
        const div1imgs = div1div0.getElementsByTagName("img");
        const lampSrcs = Array.from(div1imgs).map((img) => img.src.toLowerCase());
        const hasActiveLamp = (token: "fb" | "ab" | "fc"): boolean => {
          // OFF アイコンや無関係アイコンを除外し、点灯状態のみを拾う。
          return lampSrcs.some((s) => {
            if (!s.includes(token)) return false;
            if (s.includes("off")) return false;
            return true;
          });
        };
        const fullBell = hasActiveLamp("fb");
        const allBreak = hasActiveLamp("ab");
        // AB は FC を内包するため、AB 検出時は FC=true とみなす。
        const fullCombo = allBreak || hasActiveLamp("fc");
        datas.push({
          difficulty: dif,
          level,
          name,
          genre: currnetGenre,
          technicalHighScore,
          overDamageHighScore,
          battleHighScore,
          fullBell,
          fullCombo,
          allBreak,
          platinumHighScore,
          platinumStar,
          platinumMaxScore,
          musicExId: extractedMusicExId,
        });
      }
    }
  }
  return datas;
}

const DIFS: [UserDataScoreDifficultyType, number][] = [
  ["BASIC", 0],
  ["ADVANCED", 1],
  ["EXPERT", 2],
  ["MASTER", 3],
  ["LUNATIC", 10],
];

async function fetchUserScoreRows(
  log: (message: string) => void,
): Promise<UserDataScoreType[]> {
  log("プレーデータを読み込みます…");
  const scoreDatas: UserDataScoreType[] = [];
  for (let i = 0; i < DIFS.length; i++) {
    const dif = DIFS[i];
    log(`${dif[0]} の譜面HTMLを取得中… (${i + 1}/${DIFS.length})`);
    const url = `${ongekiMobileOrigin()}/ongeki-mobile/record/musicGenre/search/?genre=99&diff=${dif[1]}`;
    const html = await fetchHtml(url, log, `${dif[0]} 譜面ページ`);
    log(`${dif[0]} のHTMLをパース中…`);
    const scoreData = parseScoreHTML(html, dif[0]);
    scoreDatas.push(...scoreData);
    log(`${dif[0]}のユーザースコアデータ取得完了（${scoreData.length} 行）`);
  }
  log("プレーデータの読み込みが完了しました。");
  return scoreDatas;
}

/** music-ex.json の lev_*_i を譜面定数として取り込む */
function parseConstField(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

/** JSON の1オブジェクトをフラットな文字列レコードに（追加フィールドも落とさない） */
function normalizeMusicExTrack(raw: unknown): MusicExTrack | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: MusicExTrack = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) out[k] = "";
    else if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    else out[k] = JSON.stringify(v);
  }
  return out;
}

type MusicExParseResult = {
  beatmapRows: BeatmapDataType[];
  tracks: MusicExTrack[];
};

function normalizeLevelString(v: string): string {
  return v.normalize("NFKC").replace(/\s+/g, "").trim();
}

/** 全フィールドを `tracks` に保持しつつ、結合用に難易度別 beatmap 行を展開する */
function parseMusicExJson(data: unknown): MusicExParseResult {
  if (!Array.isArray(data)) {
    throw new Error("music-ex: ルートが配列ではありません");
  }
  const tracks: MusicExTrack[] = [];
  const beatmapRows: BeatmapDataType[] = [];
  for (const raw of data) {
    const row = normalizeMusicExTrack(raw);
    if (!row) continue;
    const name = (row.title ?? "").trim();
    if (!name) continue;
    tracks.push(row);
    const genre = (row.category ?? "").trim();
    const character = (row.character ?? "").trim();
    const version = (row.version ?? "").trim();
    const musicExId = (row.id ?? "").trim() || undefined;
    const pairs: Array<[BeatmapDataDifficultyType, string, string]> = [
      ["BASIC", row.lev_bas_i ?? "", row.lev_bas ?? ""],
      ["ADVANCED", row.lev_adv_i ?? "", row.lev_adv ?? ""],
      ["EXPERT", row.lev_exc_i ?? "", row.lev_exc ?? ""],
      ["MASTER", row.lev_mas_i ?? "", row.lev_mas ?? ""],
      ["LUNATIC", row.lev_lnt_i ?? "", row.lev_lnt ?? ""],
    ];
    for (const [difficulty, s, level] of pairs) {
      beatmapRows.push({
        name,
        genre,
        character,
        version,
        difficulty,
        level: String(level).trim(),
        const: parseConstField(s),
        musicExId,
      });
    }
  }
  return { beatmapRows, tracks };
}

function isMusicExJsonUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.searchParams.get("format") === "music-ex") return true;
    const path = u.pathname.toLowerCase();
    return path.endsWith(".json") && path.includes("music-ex");
  } catch {
    return /music-ex\.json/i.test(url);
  }
}

async function parseBeatmapCsv(csvText: string): Promise<BeatmapDataType[]> {
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(csvText, {
      header: false,
      complete: (results) => {
        if (results.errors.length) {
          reject(results.errors);
          return;
        }
        const rows = results.data as string[][];
        const beatmapDatas: BeatmapDataType[] = [];
        const createRow = (
          row: string[],
          difficulty: BeatmapDataDifficultyType,
          versionIndex: number,
          constIndex: number,
        ) => {
          beatmapDatas.push({
            name: row[0],
            genre: row[1],
            character: row[2],
            version: row[versionIndex],
            difficulty,
            const: row[constIndex] ? Number(row[constIndex]) : undefined,
          });
        };
        for (const row of rows) {
          if (!row || row.length < 10) continue;
          createRow(row, "BASIC", 3, 5);
          createRow(row, "ADVANCED", 3, 6);
          createRow(row, "EXPERT", 3, 7);
          createRow(row, "MASTER", 3, 8);
          createRow(row, "LUNATIC", 4, 9);
        }
        resolve(beatmapDatas);
      },
      error: reject,
    });
  });
}

/** gcsBeatmapDataSource と同様: result-latest.json → CSV。または music-ex.json（raw URL） */
async function fetchBeatmapData(
  bucketUrl: string,
  log: (message: string) => void,
): Promise<FetchBeatmapResult> {
  log("必要な楽曲情報を準備しています…");
  const base = bucketUrl.replace(/\/$/, "");

  if (isMusicExJsonUrl(bucketUrl)) {
    log("楽曲情報を取得しています…");
    const response = await withElapsedLog(log, "music-ex.json ダウンロード", () =>
      fetch(base, { cache: "default" }),
    );
    if (!response.ok) {
      throw new Error(`music-ex.json 取得に失敗: ${response.status}`);
    }
    const raw = await response.text();
    log("楽曲情報を確認しています…");
    const head = raw.slice(0, 64).trimStart().toLowerCase();
    if (head.startsWith("<!doctype") || head.startsWith("<html")) {
      throw new Error(
        `music-ex.json のURLがHTMLを返しました（${base}）。設定の絶対URL化が必要かもしれません。`,
      );
    }
    const parsed = JSON.parse(raw) as unknown;
    const { beatmapRows, tracks } = await withElapsedLog(log, "music-ex.json パース", () =>
      Promise.resolve(parseMusicExJson(parsed)),
    );
    log("楽曲情報の準備が完了しました。");
    return {
      beatmaps: beatmapRows,
      musicCatalog: tracks,
      musicCatalogSourceUrl: base,
    };
  }

  let dataUrl: string;
  try {
    log("楽曲情報を確認しています…");
    const metadataUrl = `${base}/result-latest.json`;
    const metadataResponse = await withElapsedLog(log, "譜面メタデータ", () =>
      fetch(metadataUrl, { cache: "no-cache" }),
    );
    if (!metadataResponse.ok) {
      throw new Error(`metadata ${metadataResponse.status}`);
    }
    const metadata = (await metadataResponse.json()) as { latestFileName?: string };
    const latestFileName = metadata.latestFileName;
    if (!latestFileName) {
      throw new Error("no latestFileName");
    }
    dataUrl = `${base}/${latestFileName}`;
    log("最新の楽曲情報を使用します。");
  } catch {
    log("別ルートで楽曲情報を取得します。");
    dataUrl = `${base}/result.csv`;
  }
  log("楽曲情報を取得しています…");
  const response = await withElapsedLog(log, "譜面CSVダウンロード", () =>
    fetch(dataUrl, { cache: "default" }),
  );
  if (!response.ok) {
    throw new Error(`CSVデータ取得に失敗: ${response.status}`);
  }
  const rawDatas = await response.text();
  log("楽曲情報を確認しています…");
  const beatmapDatas = await withElapsedLog(log, "譜面CSVパース", () => parseBeatmapCsv(rawDatas));
  log("楽曲情報の準備が完了しました。");
  return { beatmaps: beatmapDatas, musicCatalog: null, musicCatalogSourceUrl: null };
}

function combineDatas(
  userDatas: UserDataScoreType[],
  beatmapDatas: BeatmapDataType[],
): CombinedRow[] {
  const beatmapByIdDiff = new Map<string, BeatmapDataType>();
  for (const beatmapData of beatmapDatas) {
    const id = beatmapData.musicExId?.trim();
    if (!id) continue;
    beatmapByIdDiff.set(`id::${id}::${beatmapData.difficulty}`, beatmapData);
  }
  const beatmapNameDifficultyMap = new Map<string, Map<BeatmapDataDifficultyType, BeatmapDataType[]>>();
  for (const beatmapData of beatmapDatas) {
    if (!beatmapNameDifficultyMap.has(beatmapData.name)) {
      beatmapNameDifficultyMap.set(beatmapData.name, new Map());
    }
    const byDiff = beatmapNameDifficultyMap.get(beatmapData.name);
    const arr = byDiff?.get(beatmapData.difficulty) ?? [];
    arr.push(beatmapData);
    byDiff?.set(beatmapData.difficulty, arr);
  }
  const groupUseCount = new Map<string, number>();
  return userDatas.map((userData) => {
    const name = userData.name;
    const difficulty = userData.difficulty;
    const idKey = userData.musicExId?.trim() ? `id::${userData.musicExId.trim()}::${difficulty}` : "";
    const byId = idKey ? beatmapByIdDiff.get(idKey) : undefined;
    const candidates = beatmapNameDifficultyMap.get(name)?.get(difficulty) ?? [];
    const normalizedUserLevel = normalizeLevelString(userData.level);
    const sameLevelCandidates = candidates.filter(
      (b) => normalizeLevelString(b.level ?? "") === normalizedUserLevel,
    );
    let beatmapData = byId;
    if (!beatmapData && sameLevelCandidates.length > 0) {
      if (sameLevelCandidates.length === 1) {
        beatmapData = sameLevelCandidates[0];
      } else {
        const groupKey = `${name}::${difficulty}::${normalizedUserLevel}`;
        const used = groupUseCount.get(groupKey) ?? 0;
        beatmapData = sameLevelCandidates[used % sameLevelCandidates.length];
        groupUseCount.set(groupKey, used + 1);
      }
    }
    if (!beatmapData) {
      beatmapData = candidates.find((b) => b.const !== undefined) ?? candidates[0];
    }
    const resolvedConst = beatmapData?.const;
    return {
      name,
      difficulty,
      level: userData.level,
      genre: userData.genre,
      technicalHighScore: userData.technicalHighScore,
      overDamageHighScore: userData.overDamageHighScore,
      battleHighScore: userData.battleHighScore,
      fullBell: userData.fullBell,
      fullCombo: userData.fullCombo,
      allBreak: userData.allBreak,
      const: resolvedConst,
      platinumHighScore: userData.platinumHighScore,
      platinumStar: userData.platinumStar,
      platinumMaxScore: userData.platinumMaxScore,
      character: beatmapData?.character,
      version: beatmapData?.version,
      music_ex_id: beatmapData?.musicExId ?? userData.musicExId,
    };
  });
}

function combineDatasWithoutBeatmap(userDatas: UserDataScoreType[]): CombinedRow[] {
  return userDatas.map((userData) => ({
    name: userData.name,
    difficulty: userData.difficulty,
    level: userData.level,
    genre: userData.genre,
    technicalHighScore: userData.technicalHighScore,
    overDamageHighScore: userData.overDamageHighScore,
    battleHighScore: userData.battleHighScore,
    fullBell: userData.fullBell,
    fullCombo: userData.fullCombo,
    allBreak: userData.allBreak,
    const: undefined,
    platinumHighScore: userData.platinumHighScore,
    platinumStar: userData.platinumStar,
    platinumMaxScore: userData.platinumMaxScore,
    character: undefined,
    version: undefined,
  }));
}

export async function runOngekiFetch(log: (message: string) => void, beatmapBucketUrl: string) {
  const sub = await checkCourseSubscription(log);
  if (!sub.standardActive) {
    throw new Error(
      "スタンダードコース（有料）の利用が確認できませんでした。未契約か、ログインセッションが切れている可能性があります。オンゲキNETでマイページが開ける状態で再実行してください。",
    );
  }
  const userDatas = await fetchUserScoreRows(log);
  let rows: CombinedRow[];
  let musicCatalog: MusicExTrack[] | undefined;
  let musicCatalogMeta: MusicCatalogMeta | undefined;
  if (beatmapBucketUrl.trim()) {
    try {
      const { beatmaps, musicCatalog: cat, musicCatalogSourceUrl } = await fetchBeatmapData(
        beatmapBucketUrl.trim(),
        log,
      );
      rows = combineDatas(userDatas, beatmaps);
      if (cat && cat.length > 0 && musicCatalogSourceUrl) {
        musicCatalog = cat;
        musicCatalogMeta = {
          schema: "otoge-db/music-ex",
          source_url: musicCatalogSourceUrl,
          track_count: cat.length,
        };
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      log(`譜面データ取得に失敗: ${m}`);
      log(
        "譜面データなしで続行します（定数・キャラ・バージョンは空）。※ スコア送信自体は継続します",
      );
      rows = combineDatasWithoutBeatmap(userDatas);
    }
  } else {
    log("一部の楽曲情報が未設定のため、基本データのみで続行します。");
    rows = combineDatasWithoutBeatmap(userDatas);
  }
  return { userDatas, rows, musicCatalog, musicCatalogMeta };
}
