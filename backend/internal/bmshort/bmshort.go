// 북마크릿 단축 URL용 인메모리 세션 + 템플릿 치환.
package bmshort

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

type payload struct {
	id               string
	ingestToken      string
	apiBase          string
	beatmapBucketURL string
	expires          time.Time
	reissueAt        time.Time
	used             bool
}

var (
	mu       sync.Mutex
	sessions = make(map[string]*payload)
	byToken  = make(map[string]string)
	tplOnce  sync.Once
	tplBytes []byte
	tplErr   error
)

// CreateSession: Bearer 로 검증된 ingest 토큰과 함께 저장. 반환 id는 GET bookmarklet.js?id= 에 사용.
func CreateSession(ingestToken, apiBase, beatmapBucketURL string, ttl time.Duration) (string, time.Time, time.Time, bool, error) {
	if ttl <= 0 {
		ttl = 15 * time.Minute
	}
	now := time.Now()
	mu.Lock()
	defer mu.Unlock()
	pruneLocked()
	if existingID, ok := byToken[ingestToken]; ok {
		if p, ok := sessions[existingID]; ok {
			if !p.used && now.Before(p.expires) {
				return p.id, p.expires, p.reissueAt, true, nil
			}
			if now.Before(p.reissueAt) {
				return "", p.expires, p.reissueAt, false, fmt.Errorf("reissue cooldown active")
			}
		}
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", time.Time{}, time.Time{}, false, err
	}
	id := hex.EncodeToString(b)
	p := &payload{
		id:               id,
		ingestToken:      ingestToken,
		apiBase:          apiBase,
		beatmapBucketURL: beatmapBucketURL,
		expires:          now.Add(ttl),
		reissueAt:        now.Add(ttl),
	}
	sessions[id] = p
	byToken[ingestToken] = id
	return id, p.expires, p.reissueAt, false, nil
}

// ConsumeSession: 북마크릿 스크립트 전달 시 즉시 1회용으로 소모한다.
// 정상 소모 시에는 세션을 바로 정리하여 재발급 쿨다운을 해제한다
// (정상 사용 직후에는 사용자가 즉시 새 북마크 URL을 받을 수 있어야 한다).
// 같은 id로의 재시도는 sessions 맵에 더 이상 존재하지 않으므로 자연스럽게 실패한다.
func ConsumeSession(id string) (ingestToken, apiBase, beatmapBucketURL string, ok bool) {
	mu.Lock()
	defer mu.Unlock()
	pruneLocked()
	p, ok := sessions[id]
	if !ok || time.Now().After(p.expires) || p.used {
		if ok {
			p.used = true
		}
		return "", "", "", false
	}
	p.used = true
	delete(sessions, id)
	if existing, hit := byToken[p.ingestToken]; hit && existing == id {
		delete(byToken, p.ingestToken)
	}
	return p.ingestToken, p.apiBase, p.beatmapBucketURL, true
}

func SessionStatus(ingestToken string) (id string, expiresAt, reissueAt time.Time, hasActive bool, hasCooldown bool) {
	mu.Lock()
	defer mu.Unlock()
	pruneLocked()
	sid, ok := byToken[ingestToken]
	if !ok {
		return "", time.Time{}, time.Time{}, false, false
	}
	p, ok := sessions[sid]
	if !ok {
		return "", time.Time{}, time.Time{}, false, false
	}
	now := time.Now()
	if !p.used && now.Before(p.expires) {
		return p.id, p.expires, p.reissueAt, true, false
	}
	if now.Before(p.reissueAt) {
		return "", p.expires, p.reissueAt, false, true
	}
	return "", p.expires, p.reissueAt, false, false
}

func pruneLocked() {
	now := time.Now()
	for k, p := range sessions {
		if now.After(p.reissueAt) {
			delete(byToken, p.ingestToken)
			delete(sessions, k)
		}
	}
}

// LoadTemplate: bookmarklet.iife.js 원문 (플레이스홀더 포함). 최초 1회 디스크에서 읽고 캐시.
func LoadTemplate() ([]byte, error) {
	tplOnce.Do(func() {
		tplBytes, tplErr = readTemplateFromDisk()
	})
	if tplErr != nil {
		return nil, tplErr
	}
	out := make([]byte, len(tplBytes))
	copy(out, tplBytes)
	return out, nil
}

func readTemplateFromDisk() ([]byte, error) {
	if p := os.Getenv("BOOKMARKLET_TEMPLATE_PATH"); p != "" {
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, fmt.Errorf("BOOKMARKLET_TEMPLATE_PATH: %w", err)
		}
		return b, nil
	}
	candidates := []string{
		"../frontend/public/bookmarklet.iife.js",
		"frontend/public/bookmarklet.iife.js",
		"../../frontend/public/bookmarklet.iife.js",
	}
	for _, c := range candidates {
		b, err := os.ReadFile(c)
		if err == nil {
			return b, nil
		}
	}
	return nil, fmt.Errorf("bookmarklet.iife.js not found (set BOOKMARKLET_TEMPLATE_PATH)")
}

// SubstitutePlaceholders: 빌드 산출물의 %%%...%%% 를 치환.
func SubstitutePlaceholders(template []byte, ingestToken, apiBase, beatmapBucketURL string) []byte {
	s := string(template)
	s = strings.ReplaceAll(s, "%%%INGEST_TOKEN%%%", ingestToken)
	s = strings.ReplaceAll(s, "%%%API_BASE%%%", apiBase)
	s = strings.ReplaceAll(s, "%%%BEATMAP_BUCKET_URL%%%", beatmapBucketURL)
	return []byte(s)
}
