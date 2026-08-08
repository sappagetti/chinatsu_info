// music-ex-overrides.json 을 로그인 사용자가 웹/API 로 갱신하기 위한 핸들러.
// docker cp 없이 Windows 브라우저에서 보면정수를 바로 반영하기 위함.
//
// 권한: 환경변수 CONST_OVERRIDE_ADMIN_EMAILS (콤마 구분 이메일) 에 등록된
// 계정만 GET/POST 가능. 미설정이면 전원 거부.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/rhythm-info/backend/internal/store"
)

// constOverrideAdminEmails: CONST_OVERRIDE_ADMIN_EMAILS 를 소문자 trim 집합으로.
func constOverrideAdminEmails() map[string]struct{} {
	raw := strings.TrimSpace(os.Getenv("CONST_OVERRIDE_ADMIN_EMAILS"))
	out := map[string]struct{}{}
	if raw == "" {
		return out
	}
	for _, p := range strings.Split(raw, ",") {
		e := strings.ToLower(strings.TrimSpace(p))
		if e != "" {
			out[e] = struct{}{}
		}
	}
	return out
}

func isConstOverrideAdmin(u *store.User) bool {
	if u == nil {
		return false
	}
	admins := constOverrideAdminEmails()
	if len(admins) == 0 {
		return false
	}
	_, ok := admins[strings.ToLower(strings.TrimSpace(u.Email))]
	return ok
}

// handleMusicExOverridesMerge: POST /api/v1/music-ex-overrides/merge
//
//	{ "songs": [ {"title":"...", "lev_mas_i":"14.2", "lev_exc_i":"12.6", "force": true } ] }
//
// title(또는 id) 기준으로 기존 override entry 를 upsert 하고 디스크에 쓴 뒤
// 즉시 applyOverrides() 한다.
func handleMusicExOverridesMerge(a *app, mc *musicExCache) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := a.userFromSession(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !isConstOverrideAdmin(u) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			Songs []map[string]any `json:"songs"`
			Force bool             `json:"force"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if len(body.Songs) == 0 {
			http.Error(w, "songs required", http.StatusBadRequest)
			return
		}
		upserted, total, err := mc.MergeOverrideSongs(body.Songs, body.Force)
		if err != nil {
			log.Printf("music-ex overrides merge failed: %v", err)
			http.Error(w, "merge failed", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"upserted":       upserted,
			"override_count": total,
			"ok":             true,
		})
	}
}

// handleMusicExOverridesGet: GET /api/v1/music-ex-overrides
func handleMusicExOverridesGet(a *app, mc *musicExCache) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := a.userFromSession(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !isConstOverrideAdmin(u) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		raw, meta, err := mc.ReadOverridesRaw()
		if err != nil {
			http.Error(w, "read failed", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"songs":             raw,
			"new_song_versions": meta.NewSongVersions,
			"count":             len(raw),
		})
	}
}

// MergeOverrideSongs: overrides 파일에 songs 를 upsert 하고 즉시 머지 반영.
func (c *musicExCache) MergeOverrideSongs(incoming []map[string]any, defaultForce bool) (upserted, total int, err error) {
	if strings.TrimSpace(c.overridesPath) == "" {
		return 0, 0, fmt.Errorf("overrides path empty")
	}
	existing, meta, err := readOverridesBundleFile(c.overridesPath)
	if err != nil {
		return 0, 0, err
	}

	byKey := map[string]int{}
	keyOf := func(m map[string]any) string {
		id := strings.TrimSpace(musicExOverrideValueString(m["id"]))
		title := strings.TrimSpace(musicExOverrideValueString(m["title"]))
		if id != "" {
			return "id:" + id
		}
		if title != "" {
			return "title:" + title
		}
		return ""
	}
	for i, m := range existing {
		if k := keyOf(m); k != "" {
			byKey[k] = i
		}
	}

	for _, in := range incoming {
		entry := normalizeIncomingOverride(in, defaultForce)
		k := keyOf(entry)
		if k == "" {
			continue
		}
		if idx, ok := byKey[k]; ok {
			for fk, fv := range entry {
				if fk == "title" || fk == "id" {
					existing[idx][fk] = fv
					continue
				}
				s := strings.TrimSpace(musicExOverrideValueString(fv))
				if s == "" && fk != "force" {
					continue
				}
				existing[idx][fk] = fv
			}
			upserted++
			continue
		}
		existing = append(existing, entry)
		byKey[k] = len(existing) - 1
		upserted++
	}

	if err := writeOverridesBundleFile(c.overridesPath, existing, meta); err != nil {
		return 0, 0, err
	}
	if err := c.applyOverrides(); err != nil {
		return upserted, len(existing), err
	}
	return upserted, len(existing), nil
}

func normalizeIncomingOverride(in map[string]any, defaultForce bool) map[string]any {
	out := map[string]any{}
	for k, v := range in {
		key := strings.TrimSpace(k)
		if key == "" {
			continue
		}
		if key == "force" {
			if b, ok := v.(bool); ok {
				out["force"] = b
			}
			continue
		}
		s := strings.TrimSpace(musicExOverrideValueString(v))
		if s == "" {
			continue
		}
		out[key] = s
	}
	if _, ok := out["force"]; !ok && defaultForce {
		out["force"] = true
	}
	return out
}

func (c *musicExCache) ReadOverridesRaw() ([]map[string]any, musicExOverrideMeta, error) {
	return readOverridesBundleFile(c.overridesPath)
}

func readOverridesBundleFile(path string) ([]map[string]any, musicExOverrideMeta, error) {
	meta := defaultMusicExOverrideMeta()
	if strings.TrimSpace(path) == "" {
		return nil, meta, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []map[string]any{}, meta, nil
		}
		return nil, meta, err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return []map[string]any{}, meta, nil
	}
	_, meta2, err := parseMusicExOverridesBundle(b)
	if err != nil {
		return nil, meta, err
	}
	trimmed := strings.TrimSpace(string(b))
	if len(trimmed) > 0 && trimmed[0] == '{' {
		var obj struct {
			Songs []map[string]any `json:"songs"`
		}
		if err := json.Unmarshal(b, &obj); err != nil {
			return nil, meta2, err
		}
		if obj.Songs == nil {
			obj.Songs = []map[string]any{}
		}
		return obj.Songs, meta2, nil
	}
	var arr []map[string]any
	if err := json.Unmarshal(b, &arr); err != nil {
		return nil, meta2, err
	}
	if arr == nil {
		arr = []map[string]any{}
	}
	return arr, meta2, nil
}

func writeOverridesBundleFile(path string, songs []map[string]any, meta musicExOverrideMeta) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	keepObject := false
	if b, err := os.ReadFile(path); err == nil {
		t := strings.TrimSpace(string(b))
		keepObject = len(t) > 0 && t[0] == '{'
	}
	var out []byte
	var err error
	if keepObject {
		payload := map[string]any{
			"_meta": map[string]any{
				"new_song_versions": meta.NewSongVersions,
				"version_splits": func() []map[string]string {
					splits := make([]map[string]string, 0, len(meta.VersionSplits))
					for _, s := range meta.VersionSplits {
						splits = append(splits, map[string]string{
							"from": s.From, "to": s.To, "since": s.Since,
						})
					}
					return splits
				}(),
			},
			"songs": songs,
		}
		out, err = json.MarshalIndent(payload, "", "  ")
	} else {
		out, err = json.MarshalIndent(songs, "", "  ")
	}
	if err != nil {
		return err
	}
	out = append(out, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
