/**
 * music-ex.json(약 1~3MB)의 공용 캐시 유틸.
 *
 * 전략:
 * - 같은 페이지 세션 안에서는 in-memory 캐시(+진행 중인 fetch promise 공유)로 중복 네트워크/파싱을 제거한다.
 * - 브라우저 세션 간에는 localStorage 에 파싱 완료된 body 를 보관해 재방문시 즉시 표시한다.
 * - 캐시는 기본 24시간 후 자동 만료되며, 그 전에는 네트워크 요청 없이 즉시 반환한다.
 * - 24시간 경과 후에는 네트워크 재요청 + 실패시 stale 캐시로 폴백한다.
 * - CORS preflight 를 유발하는 조건부 헤더(If-None-Match 등)는 직접 보내지 않고,
 *   실제 재검증은 브라우저 HTTP 캐시에 맡긴다(cache: "default").
 */

type MemoEntry = {
  promise: Promise<unknown[]>;
  cachedAt: number;
};

const MEMORY_CACHE = new Map<string, MemoEntry>();
const STORAGE_KEY_PREFIX = "music-ex-cache:v1:";
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type StoredEntry = {
  url: string;
  body: unknown[];
  cachedAt: number;
};

function storageKey(url: string): string {
  return STORAGE_KEY_PREFIX + url;
}

function readStorage(url: string): StoredEntry | null {
  try {
    const raw = localStorage.getItem(storageKey(url));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<StoredEntry> | null;
    if (!p || typeof p !== "object") return null;
    if (typeof p.url !== "string" || p.url !== url) return null;
    if (!Array.isArray(p.body)) return null;
    if (typeof p.cachedAt !== "number" || !Number.isFinite(p.cachedAt)) return null;
    return { url: p.url, body: p.body, cachedAt: p.cachedAt };
  } catch {
    return null;
  }
}

function writeStorage(entry: StoredEntry): void {
  try {
    localStorage.setItem(storageKey(entry.url), JSON.stringify(entry));
  } catch {
    // localStorage 용량 초과 등은 무시 (in-memory 캐시는 계속 동작)
  }
}

/** github.com/<owner>/<repo>/blob/<branch>/<path> 를 raw.githubusercontent.com 으로 변환 */
function resolveMusicExUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const parts = u.pathname.split("/").filter(Boolean);
    if (host === "github.com" && parts.length >= 5 && parts[2] === "blob") {
      const owner = parts[0];
      const repo = parts[1];
      const branch = parts[3];
      const rest = parts.slice(4).join("/");
      return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest}`;
    }
    return url;
  } catch {
    return url;
  }
}

async function fetchFresh(url: string): Promise<unknown[]> {
  const res = await fetch(url, { cache: "default" });
  if (!res.ok) {
    throw new Error(`music_ex fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("music_ex payload is not an array");
  }
  writeStorage({ url, body: data, cachedAt: Date.now() });
  return data;
}

/**
 * music-ex.json 을 파싱된 배열로 반환한다.
 * opts.maxAgeMs: 로컬 캐시 만료(기본 24시간). 이보다 오래되면 재요청.
 * opts.forceRefresh: true 이면 in-memory/localStorage 캐시를 무시하고 재요청.
 */
export async function fetchMusicExJson(
  rawUrl: string,
  opts?: { maxAgeMs?: number; forceRefresh?: boolean },
): Promise<unknown[]> {
  if (!rawUrl) throw new Error("music_ex url is empty");
  const url = resolveMusicExUrl(rawUrl);
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const forceRefresh = opts?.forceRefresh ?? false;

  const now = Date.now();
  if (!forceRefresh) {
    const memo = MEMORY_CACHE.get(url);
    if (memo && now - memo.cachedAt < maxAgeMs) return memo.promise;
    if (memo) MEMORY_CACHE.delete(url);
    const stored = readStorage(url);
    if (stored && now - stored.cachedAt < maxAgeMs) {
      const p = Promise.resolve(stored.body);
      MEMORY_CACHE.set(url, { promise: p, cachedAt: stored.cachedAt });
      return p;
    }
  }

  const p = (async () => {
    try {
      return await fetchFresh(url);
    } catch (e) {
      const stored = readStorage(url);
      if (stored) return stored.body;
      throw e;
    }
  })();
  MEMORY_CACHE.set(url, { promise: p, cachedAt: now });
  p.catch(() => {
    MEMORY_CACHE.delete(url);
  });
  return p;
}
