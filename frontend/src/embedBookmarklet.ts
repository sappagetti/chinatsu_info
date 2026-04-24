/**
 * 서버가 /api/v1/bookmarklet.js?id= 로 풀 스크립트를 내려줄 때용 최소 로더.
 * - 메인 스크립트가 자체 오버레이를 띄우므로 로더 측 UI 는 생략한다.
 * - 실패 시에만 alert 로 안내(만료/재발급 유도). URL 길이를 최대한 줄이기 위함.
 */
export function buildShortBookmarkletLoaderUrl(scriptBase: string, sessionId: string): string {
  const base = scriptBase.replace(/\/$/, "");
  const src = `${base}/api/v1/bookmarklet.js?id=${encodeURIComponent(sessionId)}`;
  const errMsg = "ブックマークURLが無効です。インフォサイトで再発行してください。";
  const body =
    `void(function(){` +
    `var s=document.createElement("script");` +
    `s.src=${JSON.stringify(src)};` +
    `s.onerror=function(){alert(${JSON.stringify(errMsg)})};` +
    `document.head.appendChild(s)` +
    `})();`;
  return `javascript:${body}`;
}
