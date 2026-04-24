// HTTP API 서버 진입점.
// 브라우저(또는 북마크릿)와 통신해 사용자 등록, 데이터 수집(ingest), 내 정보 조회를 처리한다.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/rhythm-info/backend/internal/mail"
	"github.com/rhythm-info/backend/internal/session"
	"github.com/rhythm-info/backend/internal/store"
)

func main() {
	// SQLite 파일 경로. Docker에서는 환경변수로 /data/app.db 등으로 바꾼다.
	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "./data/app.db"
	}
	// DB가 들어갈 디렉터리가 없으면 만든다. 권한 0755 = 소유자 전체, 그룹/기타 읽기+실행.
	if err := os.MkdirAll("./data", 0o755); err != nil {
		log.Fatalf("mkdir data: %v", err)
	}

	st, err := store.Open(dbPath)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer st.Close()
	redisStore := session.New(
		mustEnv("REDIS_ADDR", "127.0.0.1:6379"),
		os.Getenv("REDIS_PASSWORD"),
		envInt("REDIS_DB", 0),
	)
	if err := redisStore.Ping(context.Background()); err != nil {
		log.Fatalf("redis unavailable: %v", err)
	}
	// music-ex.json 미러 캐시. 기동 즉시 디스크 캐시를 올리고 백그라운드에서 주기 갱신.
	musicEx := newMusicExCache()
	musicEx.start(context.Background())

	a := &app{
		store:           st,
		sessions:        redisStore,
		turnstileSecret: os.Getenv("TURNSTILE_SECRET_KEY"),
		frontendBaseURL: mustEnv("FRONTEND_BASE_URL", "https://chinatsu.sappagetti.com"),
		appBaseURL:      mustEnv("APP_BASE_URL", "https://chinatsu.sappagetti.com"),
		mailer: mail.Sender{
			Host: mustEnv("SMTP_HOST", "mail.sappagetti.com"),
			Port: mustEnv("SMTP_PORT", "587"),
			User: os.Getenv("SMTP_USER"),
			Pass: os.Getenv("SMTP_PASS"),
			From: mustEnv("SMTP_FROM", "no-reply@sappagetti.com"),
		},
	}

	r := chi.NewRouter()
	// 요청 로그, 패닉 복구, 60초 타임아웃을 전역 미들웨어로 적용.
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	// ingest 는 스코어 JSON 이 수 MB 될 수 있어 여유 있게 둔다.
	r.Use(middleware.Timeout(300 * time.Second))

	// - 로컬 Vite(5173)에서 백엔드로 직접 fetch
	// - 북마크릿은 https://ongeki-net.com 에서 실행되어 API로 POST → 반드시 해당 Origin 허용
	// - 프론트가 다른 호스트(예: https://app.example.com)에서 API 서브도메인으로 fetch할 때는
	//   CORS_ALLOWED_ORIGINS 에 콤마로 구분해 해당 https://... Origin 을 추가
	allowedOrigins := []string{
		"http://localhost:5173",
		"http://127.0.0.1:5173",
		"https://localhost:5173",
		"https://127.0.0.1:5173",
		"https://ongeki-net.com",
	}
	if extra := os.Getenv("CORS_ALLOWED_ORIGINS"); extra != "" {
		for _, o := range strings.Split(extra, ",") {
			o = strings.TrimSpace(o)
			if o != "" {
				allowedOrigins = append(allowedOrigins, o)
			}
		}
	}
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   allowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "ngrok-skip-browser-warning", "Access-Control-Request-Private-Network"},
		AllowCredentials: true,
		MaxAge:           300,
	}))
	// Chrome PNA: 공인 페이지(ongeki-net) -> 사설망/로컬로 판단되면 preflight에 이 헤더가 필요할 수 있다.
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.EqualFold(r.Header.Get("Access-Control-Request-Private-Network"), "true") {
				w.Header().Set("Access-Control-Allow-Private-Network", "true")
			}
			next.ServeHTTP(w, r)
		})
	})

	// 헬스체크용. 본문은 단순 문자열.
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	// REST API 버전 prefix. 이후 엔드포인트를 v2로 옮길 때 구분하기 쉽다.
	r.Route("/api/v1", func(r chi.Router) {
		r.Post("/register", handleRegister(st)) // 레거시 토큰 발급(호환 유지)
		r.Post("/ingest", handleIngest(st))     // 북마크릿이 수집한 JSON 저장
		r.Get("/me", handleMe(st))              // 대시보드: 마지막 스냅샷 + 메타
		r.Post("/bookmarklet-session", handleBookmarkletSessionCreate(st))
		r.Get("/bookmarklet-session", handleBookmarkletSessionCurrent(st))
		r.Get("/bookmarklet.js", handleBookmarkletScript())
		r.Get("/rating-targets", handleRatingTargets(st))
		// music-ex.json 미러. 프론트는 VITE_BEATMAP_BUCKET_URL 로 이 경로를 가리킨다.
		r.Get("/music-ex.json", musicEx.serveHTTP())
		r.Head("/music-ex.json", musicEx.serveHTTP())
		r.Get("/jacket/{filename}", handleJacketImage())
		r.Get("/icon/{filename}", handleProfileIconImage())
		r.Get("/chara/{filename}", handleProfileCharaImage())
		r.Route("/auth", func(r chi.Router) {
			r.Post("/signup", a.handleSignup())
			r.Post("/login", a.handleLogin())
			r.Post("/logout", a.handleLogout())
			r.Post("/forgot-password", a.handleForgotPassword())
			r.Post("/reset-password", a.handleResetPassword())
			r.Get("/verify-email", a.handleVerifyEmail())
			r.Post("/resend-verification", a.handleResendVerification())
			r.Get("/me", a.handleAuthMe())
			r.Delete("/account", a.handleDeleteAccount())
		})
	})

	addr := ":8080"
	if v := os.Getenv("PORT"); v != "" {
		addr = ":" + v
	}
	log.Printf("listening on %s", addr)
	if err := http.ListenAndServe(addr, r); err != nil {
		log.Fatal(err)
	}
}

var jacketFilePattern = regexp.MustCompile(`^[A-Za-z0-9._-]+\.(png|jpg|jpeg|webp|gif)$`)
var iconFilePattern = regexp.MustCompile(`^[A-Za-z0-9._-]+\.(png|jpg|jpeg|webp|gif)$`)

func handleJacketImage() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		filename := chi.URLParam(r, "filename")
		filename = strings.TrimSpace(filename)
		if !jacketFilePattern.MatchString(filename) {
			http.NotFound(w, r)
			return
		}
		jacketDir := os.Getenv("JACKET_DIR")
		if jacketDir == "" {
			jacketDir = "./assets/jacket"
		}
		fullPath := filepath.Join(jacketDir, filename)
		info, err := os.Stat(fullPath)
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=86400")
		http.ServeFile(w, r, fullPath)
	}
}

func profileIconDir() string {
	dir := os.Getenv("ICON_DIR")
	if strings.TrimSpace(dir) == "" {
		return "./data/icons"
	}
	return dir
}

func profileCharaDir() string {
	dir := os.Getenv("CHARA_DIR")
	if strings.TrimSpace(dir) == "" {
		return "./data/chara"
	}
	return dir
}

func handleProfileIconImage() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		filename := strings.TrimSpace(chi.URLParam(r, "filename"))
		if !iconFilePattern.MatchString(filename) {
			http.NotFound(w, r)
			return
		}
		fullPath := filepath.Join(profileIconDir(), filename)
		info, err := os.Stat(fullPath)
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=86400")
		http.ServeFile(w, r, fullPath)
	}
}

func handleProfileCharaImage() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		filename := strings.TrimSpace(chi.URLParam(r, "filename"))
		if !iconFilePattern.MatchString(filename) {
			http.NotFound(w, r)
			return
		}
		fullPath := filepath.Join(profileCharaDir(), filename)
		info, err := os.Stat(fullPath)
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=86400")
		http.ServeFile(w, r, fullPath)
	}
}

func persistProfileIconFromPayload(payload map[string]any) (string, error) {
	raw, ok := payload["profile_icon"]
	if !ok {
		return "", nil
	}
	icon, ok := raw.(map[string]any)
	if !ok {
		return "", nil
	}
	key, _ := icon["icon_key"].(string)
	key = strings.TrimSpace(key)
	if key == "" || !iconFilePattern.MatchString(key) {
		return "", nil
	}

	if err := os.MkdirAll(profileIconDir(), 0o755); err != nil {
		return "", err
	}
	fullPath := filepath.Join(profileIconDir(), key)
	if info, err := os.Stat(fullPath); err == nil && !info.IsDir() {
		icon["local_url"] = "/api/v1/icon/" + key
		return key, nil
	}

	dataURL, _ := icon["icon_data_url"].(string)
	dataURL = strings.TrimSpace(dataURL)
	if !strings.HasPrefix(dataURL, "data:") {
		return "", nil
	}
	commaIdx := strings.Index(dataURL, ",")
	if commaIdx <= 0 {
		return "", nil
	}
	meta := dataURL[:commaIdx]
	if !strings.Contains(meta, ";base64") {
		return "", nil
	}
	rawB64 := dataURL[commaIdx+1:]
	b, err := base64.StdEncoding.DecodeString(rawB64)
	if err != nil {
		return "", err
	}
	if len(b) == 0 || len(b) > 2*1024*1024 {
		return "", nil
	}
	if err := os.WriteFile(fullPath, b, 0o644); err != nil {
		return "", err
	}
	icon["local_url"] = "/api/v1/icon/" + key
	icon["saved"] = true
	delete(icon, "icon_data_url")
	return key, nil
}

func persistProfileCharaFromPayload(payload map[string]any) (string, error) {
	raw, ok := payload["profile_chara"]
	if !ok {
		return "", nil
	}
	chara, ok := raw.(map[string]any)
	if !ok {
		return "", nil
	}
	key, _ := chara["chara_key"].(string)
	key = strings.TrimSpace(key)
	if key == "" || !iconFilePattern.MatchString(key) {
		return "", nil
	}

	if err := os.MkdirAll(profileCharaDir(), 0o755); err != nil {
		return "", err
	}
	fullPath := filepath.Join(profileCharaDir(), key)
	if info, err := os.Stat(fullPath); err == nil && !info.IsDir() {
		chara["local_url"] = "/api/v1/chara/" + key
		return key, nil
	}

	dataURL, _ := chara["chara_data_url"].(string)
	dataURL = strings.TrimSpace(dataURL)
	if !strings.HasPrefix(dataURL, "data:") {
		return "", nil
	}
	commaIdx := strings.Index(dataURL, ",")
	if commaIdx <= 0 {
		return "", nil
	}
	meta := dataURL[:commaIdx]
	if !strings.Contains(meta, ";base64") {
		return "", nil
	}
	rawB64 := dataURL[commaIdx+1:]
	b, err := base64.StdEncoding.DecodeString(rawB64)
	if err != nil {
		return "", err
	}
	if len(b) == 0 || len(b) > 5*1024*1024 {
		return "", nil
	}
	if err := os.WriteFile(fullPath, b, 0o644); err != nil {
		return "", err
	}
	chara["local_url"] = "/api/v1/chara/" + key
	chara["saved"] = true
	delete(chara, "chara_data_url")
	return key, nil
}

// handleRegister: 표시 이름(선택)을 받아 DB에 사용자 한 명을 만들고 ingest_token을 돌려준다.
// 프론트는 이 토큰을 로컬스토리지에 넣고, 북마크릿이 Authorization 헤더로 보낸다.
func handleRegister(st *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			DisplayName string `json:"display_name"`
		}
		// JSON이 비어 있어도 DisplayName은 빈 문자열로 처리된다.
		_ = json.NewDecoder(r.Body).Decode(&body)
		u, err := st.CreateUser(body.DisplayName)
		if err != nil {
			http.Error(w, "register failed", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{
			"user_id":      u.ID,
			"ingest_token": u.IngestToken,
		})
	}
}

// handleIngest: Bearer 토큰으로 사용자를 식별한 뒤, 요청 본문 JSON을 스냅샷 한 건으로 저장한다.
// 북마크릿은 공식 사이트 페이지 컨텍스트에서 실행되므로, 서버는 쿠키 대신 이 토큰으로 사용자를 구분한다.
func handleIngest(st *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := bearerToken(r)
		if token == "" {
			http.Error(w, "missing token", http.StatusUnauthorized)
			return
		}
		u, err := st.UserByIngestToken(token)
		if err != nil {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if key, err := persistProfileIconFromPayload(payload); err != nil {
			log.Printf("profile icon persist failed: %v", err)
		} else if key != "" {
			log.Printf("profile icon persisted: %s", key)
		}
		if key, err := persistProfileCharaFromPayload(payload); err != nil {
			log.Printf("profile chara persist failed: %v", err)
		} else if key != "" {
			log.Printf("profile chara persisted: %s", key)
		}
		if err := st.SaveSnapshot(u.ID, payload); err != nil {
			http.Error(w, "save failed", http.StatusInternalServerError)
			return
		}
		// 성공 시 본문 없이 204. 클라이언트는 상태 코드만 보면 된다.
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleMe: 같은 ingest 토큰으로 "내 최신 스냅샷"과 사용자 메타를 JSON으로 반환한다.
// 스냅샷이 아직 없으면 last_payload / last_synced_at 은 null.
func handleMe(st *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := bearerToken(r)
		if token == "" {
			http.Error(w, "missing token", http.StatusUnauthorized)
			return
		}
		u, err := st.UserByIngestToken(token)
		if err != nil {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		snap, err := st.LatestSnapshot(u.ID)
		resp := map[string]any{
			"user_id":      u.ID,
			"display_name": u.DisplayName,
			"ingest_token": u.IngestToken,
		}
		if err == nil {
			resp["last_payload"] = snap.Payload
			resp["last_synced_at"] = snap.CreatedAt.UTC().Format(time.RFC3339)
		} else {
			resp["last_payload"] = nil
			resp["last_synced_at"] = nil
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// bearerToken: "Authorization: Bearer <토큰>" 형식에서 토큰 문자열만 뽑는다.
// RFC 6750 에 따라 스킴 비교는 대소문자 무시한다.
func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) <= 7 {
		return ""
	}
	if !strings.EqualFold(h[:7], "Bearer ") {
		return ""
	}
	return strings.TrimSpace(h[7:])
}

// writeJSON: Content-Type을 맞추고 구조체/맵을 JSON으로 직렬화해 응답한다.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
