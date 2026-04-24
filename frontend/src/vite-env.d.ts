/// <reference types="vite/client" />

// Vite가 주입하는 환경 변수 타입. .env 의 VITE_API_URL 과 대응.
interface ImportMetaEnv {
  /** 예: https://api.example.com (끝 슬래시 없이). 비우면 상대 경로 /api 사용. */
  readonly VITE_API_URL?: string;
  /**
   * 북마크릿에만 넣을 API 베이스(https). 비우면 VITE_API_URL → 없으면 현재 창 origin(로컬이면 http://localhost:5173).
   * 로컬에서 SPA는 /api 프록시를 쓰고, 온게키NET에서 북마크릿만 ngrok 등 https URL을 쓸 때 사용.
   */
  readonly VITE_BOOKMARKLET_API_URL?: string;
  /** GCS 譜面CSV URL（末尾スラッシュなし）。例: https://storage.googleapis.com/... */
  readonly VITE_BEATMAP_BUCKET_URL: string;
  /** ジャケット画像配信ベースURL。未設定時は /api/v1/jacket を使用 */
  readonly VITE_JACKET_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
