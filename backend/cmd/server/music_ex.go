// 외부(OTOGE DB GitHub repo) 에서 가져오는 music-ex.json 을 백엔드에서 일일 1회
// 주기로 미러링하고 `/api/v1/music-ex.json` 으로 서빙한다.
//
// 목적:
//   - 클라이언트가 외부 호스트에 직접 접근하지 않게 해 CSP 를 좁게(same-origin) 유지
//   - 업스트림(GitHub raw) 장애/리미트에 영향을 덜 받고 운영 비용도 낮춤
//   - 브라우저 HTTP 캐시 + ETag 조건부 GET 으로 재전송 최소화
//
// 동작:
//   - 기동 시 디스크 캐시가 있으면 우선 메모리에 올려 즉시 서빙 가능하게 함
//   - 기동 직후 1회 새로고침 시도, 이후 24시간 주기로 새로고침
//   - 원격 응답이 304(Not Modified) 면 body 유지, 내용 바뀌었을 때만 디스크에 덮어씀
//   - 응답 ETag 는 "body 의 sha256"로 설정 (업스트림이 ETag 를 안 주는 경우도 커버)
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	musicExDefaultSource    = "https://raw.githubusercontent.com/zvuc/otoge-db/master/ongeki/data/music-ex.json"
	musicExDefaultCachePath = "./data/music-ex.json"
	musicExRefreshInterval  = 24 * time.Hour
	musicExRetryDelay       = 30 * time.Second
	musicExHTTPTimeout      = 60 * time.Second
	musicExMaxBodyBytes     = 32 * 1024 * 1024 // 32 MiB 안전 상한
	// 브라우저가 캐시하는 최대 기간. 이 값이 만료되면 브라우저는 If-None-Match 로 조건부 GET 을 보낸다.
	// 서버 자체 갱신이 24시간이라 짧게 잡아도 실수 내역이 크지 않다.
	musicExBrowserMaxAge = 3600
)

type musicExCache struct {
	mu        sync.RWMutex
	body      []byte
	bodyHash  string // body sha256, 응답 ETag 로도 사용
	remoteTag string // 업스트림 ETag. 조건부 GET 에 쓴다
	fetchedAt time.Time

	sourceURL string
	cachePath string
	http      *http.Client
}

func newMusicExCache() *musicExCache {
	return &musicExCache{
		sourceURL: mustEnv("MUSIC_EX_SOURCE_URL", musicExDefaultSource),
		cachePath: mustEnv("MUSIC_EX_CACHE_PATH", musicExDefaultCachePath),
		http:      &http.Client{Timeout: musicExHTTPTimeout},
	}
}

// start: 디스크 캐시 로드 + 백그라운드 goroutine 에서 초기 refresh 와 주기 루프 수행.
func (c *musicExCache) start(ctx context.Context) {
	if err := c.loadFromDisk(); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("music-ex: load disk cache: %v", err)
		}
	} else {
		log.Printf("music-ex: loaded disk cache (%d bytes, mtime=%s)",
			len(c.body), c.fetchedAt.UTC().Format(time.RFC3339))
	}
	go c.runLoop(ctx)
}

func (c *musicExCache) runLoop(ctx context.Context) {
	go c.initialRefresh(ctx)
	t := time.NewTicker(musicExRefreshInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := c.refresh(ctx); err != nil {
				log.Printf("music-ex: periodic refresh failed: %v", err)
			} else {
				log.Printf("music-ex: periodic refresh ok")
			}
		}
	}
}

func (c *musicExCache) initialRefresh(ctx context.Context) {
	start := time.Now()
	if err := c.refresh(ctx); err == nil {
		log.Printf("music-ex: initial refresh ok (%s)", time.Since(start).Truncate(time.Millisecond))
		return
	} else {
		log.Printf("music-ex: initial refresh failed: %v", err)
	}
	// 디스크 캐시가 아예 없으면 짧게 한 번 더 시도한다.
	c.mu.RLock()
	hasBody := len(c.body) > 0
	c.mu.RUnlock()
	if hasBody {
		return
	}
	select {
	case <-ctx.Done():
		return
	case <-time.After(musicExRetryDelay):
	}
	if err := c.refresh(ctx); err != nil {
		log.Printf("music-ex: initial retry failed: %v", err)
	} else {
		log.Printf("music-ex: initial retry ok")
	}
}

func (c *musicExCache) loadFromDisk() error {
	b, err := os.ReadFile(c.cachePath)
	if err != nil {
		return err
	}
	if !isJSONArray(b) {
		return fmt.Errorf("cached music-ex is not a JSON array")
	}
	info, _ := os.Stat(c.cachePath)
	c.mu.Lock()
	c.body = b
	c.bodyHash = sha256Hex(b)
	if info != nil {
		c.fetchedAt = info.ModTime()
	}
	c.mu.Unlock()
	return nil
}

func (c *musicExCache) refresh(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.sourceURL, nil)
	if err != nil {
		return err
	}
	c.mu.RLock()
	if c.remoteTag != "" {
		req.Header.Set("If-None-Match", c.remoteTag)
	}
	c.mu.RUnlock()
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "chinatsu-info-music-ex-sync/1.0")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusNotModified:
		c.mu.Lock()
		c.fetchedAt = time.Now()
		c.mu.Unlock()
		return nil
	case http.StatusOK:
		// 아래에서 계속 처리.
	default:
		return fmt.Errorf("upstream status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, musicExMaxBodyBytes+1))
	if err != nil {
		return err
	}
	if len(body) > musicExMaxBodyBytes {
		return fmt.Errorf("response too large (>%d bytes)", musicExMaxBodyBytes)
	}
	if !isJSONArray(body) {
		return fmt.Errorf("response is not a JSON array")
	}
	// 파싱 유효성만 얕게 검증해서 깨진 JSON 을 캐시하지 않게 한다.
	var probe []any
	if err := json.Unmarshal(body, &probe); err != nil {
		return fmt.Errorf("parse: %w", err)
	}

	hash := sha256Hex(body)
	remoteTag := strings.TrimSpace(resp.Header.Get("ETag"))

	c.mu.Lock()
	defer c.mu.Unlock()

	if hash != c.bodyHash {
		if err := os.MkdirAll(filepath.Dir(c.cachePath), 0o755); err != nil {
			return fmt.Errorf("mkdir cache dir: %w", err)
		}
		tmp := c.cachePath + ".tmp"
		if err := os.WriteFile(tmp, body, 0o644); err != nil {
			return fmt.Errorf("write tmp cache: %w", err)
		}
		if err := os.Rename(tmp, c.cachePath); err != nil {
			_ = os.Remove(tmp)
			return fmt.Errorf("rename cache: %w", err)
		}
	}
	c.body = body
	c.bodyHash = hash
	c.remoteTag = remoteTag
	c.fetchedAt = time.Now()
	return nil
}

// serveHTTP: `GET /api/v1/music-ex.json` 핸들러.
// ETag 는 body sha256 (앞 16자) 로 만들고, If-None-Match 일치시 304 반환.
func (c *musicExCache) serveHTTP() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c.mu.RLock()
		body := c.body
		hash := c.bodyHash
		fetchedAt := c.fetchedAt
		c.mu.RUnlock()

		if len(body) == 0 {
			http.Error(w, "music-ex not ready", http.StatusServiceUnavailable)
			return
		}

		etag := `"` + hash[:16] + `"`
		w.Header().Set("ETag", etag)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d, must-revalidate", musicExBrowserMaxAge))
		if !fetchedAt.IsZero() {
			w.Header().Set("Last-Modified", fetchedAt.UTC().Format(http.TimeFormat))
		}

		if match := strings.TrimSpace(r.Header.Get("If-None-Match")); match != "" {
			// 간단 비교(복수 ETag, W/ prefix 생략). 일치시 304.
			for _, token := range strings.Split(match, ",") {
				token = strings.TrimSpace(token)
				if token == etag || token == hash[:16] {
					w.WriteHeader(http.StatusNotModified)
					return
				}
			}
		}

		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		_, _ = w.Write(body)
	}
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// isJSONArray: 선행 공백 이후 첫 의미 있는 문자가 '[' 이면 true.
func isJSONArray(b []byte) bool {
	for _, r := range b {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			continue
		}
		return r == '['
	}
	return false
}
