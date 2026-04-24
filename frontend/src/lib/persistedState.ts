/**
 * UI 환경설정(레벨필터/자켓토글/정렬 등)을 localStorage 에 간단히 저장하는 훅.
 *
 * - 같은 `key` 에 대해 여러 페이지가 같이 바라봐도 되고(동일 설정 공유), 페이지별 prefix 를 붙여도 된다.
 * - JSON serialization 기준이므로 primitive/배열/객체 전부 사용 가능.
 * - 파싱/저장 실패는 무시하고 initial 로 폴백한다. (프라이빗 브라우징/쿼터 초과 대비)
 */

import { useEffect, useRef, useState } from "react";

const PREFIX = "ui-pref:v1:";

function fullKey(key: string): string {
  return PREFIX + key;
}

function readStorage<T>(key: string, fallback: T, validate?: (v: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(fullKey(key));
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (validate && !validate(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

function writeStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(fullKey(key), JSON.stringify(value));
  } catch {
    // quota exceeded 등은 무시
  }
}

export function usePersistedState<T>(
  key: string,
  initial: T,
  options?: { validate?: (v: unknown) => boolean },
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => readStorage(key, initial, options?.validate));
  const isFirst = useRef(true);
  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }
    writeStorage(key, state);
  }, [key, state]);
  return [state, setState];
}
