import { useEffect, useRef, useState } from "react";

type Options = {
  /** 위젯을 붙일 DOM 요소의 id. */
  containerId: string;
  /** false 이면 렌더링을 보류(예: 실패가 N회 이상일 때만 표시). 기본 true. */
  enabled?: boolean;
};

type Result = {
  /** 현재 유효한 Turnstile 토큰. 만료/에러시 "". */
  token: string;
  /** 수동으로 챌린지를 리셋(재시도 시 호출). */
  reset: () => void;
};

/**
 * Cloudflare Turnstile 위젯 렌더링 로직을 캡슐화한다.
 * - VITE_TURNSTILE_SITE_KEY 가 없으면 아무 일도 하지 않는다(CAPTCHA 비활성 배포용).
 * - Turnstile 스크립트 로딩 타이밍이 뒤늦을 수 있어 setInterval 로 폴링한다.
 * - reset() 은 실패 후 재시도시 기존 토큰을 무효화하기 위해 사용한다.
 */
export function useTurnstileWidget({ containerId, enabled = true }: Options): Result {
  const [token, setToken] = useState("");
  const widgetRendered = useRef(false);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || widgetRendered.current) return;
    const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
    if (!siteKey) return;
    const timer = window.setInterval(() => {
      const el = document.getElementById(containerId);
      if (!el || !window.turnstile) return;
      const widgetId = window.turnstile.render(el, {
        sitekey: siteKey,
        callback: (t) => setToken(t),
        "expired-callback": () => setToken(""),
        "error-callback": () => setToken(""),
      });
      widgetIdRef.current = widgetId;
      widgetRendered.current = true;
      window.clearInterval(timer);
    }, 150);
    return () => window.clearInterval(timer);
  }, [containerId, enabled]);

  const reset = () => {
    setToken("");
    if (window.turnstile) {
      try {
        window.turnstile.reset(widgetIdRef.current ?? undefined);
      } catch {
        // 최선의 노력으로 리셋 시도. 위젯 미초기화 등 예외는 무시한다.
      }
    }
  };

  return { token, reset };
}
