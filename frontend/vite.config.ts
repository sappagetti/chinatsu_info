import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// VITE_DEV_HTTPS=1 일 때 자체 서명 HTTPS (온게키NET 북마크릿 로컬 검증용). npm run dev:https
const devHttps = process.env.VITE_DEV_HTTPS === "1";

// Vite 개발 서버 설정. npm run dev 시 프록시로 백엔드와 오리진을 맞출 수 있다.
export default defineConfig({
  plugins: [react(), ...(devHttps ? [basicSsl()] : [])],
  server: {
    port: 5173,
    // ngrok 등 터널로 접속할 때 Host が localhost 以外になり Vite がブロックするのを防ぐ（先頭ドットでサブドメイン許可）
    allowedHosts: [
      "localhost",
      "127.0.0.1",
      ".ngrok-free.app",
      ".ngrok-free.dev",
      ".ngrok.io",
    ],
    proxy: {
      // 브라우저는 localhost:5173 만 바라보고, /api 로 시작하는 요청만 8080으로 넘긴다.
      // 그러면 프론트 코드에서 상대 경로 `/api/v1/...` 를 쓰면 CORS 없이 개발 가능.
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
        // ingest 등 대용량 JSON POST·느린 업로드 시 프록시가 먼저 끊기지 않도록
        timeout: 600_000,
        proxyTimeout: 600_000,
      },
    },
  },
});
