package main

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/rhythm-info/backend/internal/bmshort"
	"github.com/rhythm-info/backend/internal/store"
)

func handleBookmarkletSessionCreate(st *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := bearerToken(r)
		if tok == "" {
			http.Error(w, "missing token", http.StatusUnauthorized)
			return
		}
		if _, err := st.UserByIngestToken(tok); err != nil {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		var body struct {
			APIBase          string `json:"api_base"`
			BeatmapBucketURL string `json:"beatmap_bucket_url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		apiBase := strings.TrimSpace(strings.TrimRight(body.APIBase, "/"))
		if apiBase == "" {
			http.Error(w, "api_base required", http.StatusBadRequest)
			return
		}
		u, err := url.Parse(apiBase)
		if err != nil || u.Scheme == "" || u.Host == "" {
			http.Error(w, "invalid api_base", http.StatusBadRequest)
			return
		}
		if u.Scheme != "http" && u.Scheme != "https" {
			http.Error(w, "api_base must be http or https", http.StatusBadRequest)
			return
		}
		id, expiresAt, reissueAt, reused, err := bmshort.CreateSession(tok, apiBase, strings.TrimSpace(body.BeatmapBucketURL), 15*time.Minute)
		if err != nil {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{
				"error":                "reissue cooldown active",
				"reissue_available_at": reissueAt.UTC().Format(time.RFC3339),
			})
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{
			"bookmarklet_session_id": id,
			"expires_at":             expiresAt.UTC().Format(time.RFC3339),
			"reissue_available_at":   reissueAt.UTC().Format(time.RFC3339),
			"reused":                 reused,
		})
	}
}

func handleBookmarkletSessionCurrent(st *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := bearerToken(r)
		if tok == "" {
			http.Error(w, "missing token", http.StatusUnauthorized)
			return
		}
		if _, err := st.UserByIngestToken(tok); err != nil {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		id, expiresAt, reissueAt, hasActive, hasCooldown := bmshort.SessionStatus(tok)
		writeJSON(w, http.StatusOK, map[string]any{
			"bookmarklet_session_id": id,
			"expires_at":             tsOrNil(expiresAt),
			"reissue_available_at":   tsOrNil(reissueAt),
			"has_active":             hasActive,
			"has_cooldown":           hasCooldown,
		})
	}
}

func handleBookmarkletScript() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			http.Error(w, "missing id", http.StatusBadRequest)
			return
		}
		ingestTok, apiBase, beatmap, ok := bmshort.ConsumeSession(id)
		if !ok {
			http.Error(w, "expired or invalid id", http.StatusNotFound)
			return
		}
		tpl, err := bmshort.LoadTemplate()
		if err != nil {
			log.Printf("bookmarklet template: %v (hint: run bookmarklet build, or set BOOKMARKLET_TEMPLATE_PATH)", err)
			http.Error(w, "template not available", http.StatusInternalServerError)
			return
		}
		out := bmshort.SubstitutePlaceholders(tpl, ingestTok, apiBase, beatmap)
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(out)
	}
}

func tsOrNil(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}
