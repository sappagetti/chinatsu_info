package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/rhythm-info/backend/internal/store"
)

func TestIsConstOverrideAdmin(t *testing.T) {
	t.Setenv("CONST_OVERRIDE_ADMIN_EMAILS", "Admin@Example.com, other@x.com")
	if !isConstOverrideAdmin(&store.User{Email: "admin@example.com"}) {
		t.Fatal("expected admin match (case-insensitive)")
	}
	if isConstOverrideAdmin(&store.User{Email: "nobody@example.com"}) {
		t.Fatal("expected non-admin")
	}
	t.Setenv("CONST_OVERRIDE_ADMIN_EMAILS", "")
	if isConstOverrideAdmin(&store.User{Email: "admin@example.com"}) {
		t.Fatal("empty env must deny everyone")
	}
}

func TestMergeOverrideSongs_UpsertByTitle(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "music-ex-overrides.json")
	initial := []map[string]any{
		{"title": "既存曲", "lev_mas_i": "14.0"},
	}
	b, _ := json.MarshalIndent(initial, "", "  ")
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}

	// raw music-ex for applyOverrides
	raw := []byte(`[
		{"id":"1","title":"既存曲","lev_mas_i":""},
		{"id":"2","title":"Cthugha","lev_mas":"14","lev_mas_i":"","lev_exc":"12","lev_exc_i":""}
	]`)
	cachePath := filepath.Join(dir, "music-ex.json")
	if err := os.WriteFile(cachePath, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	c := &musicExCache{
		cachePath:       cachePath,
		overridesPath:   path,
		rawBody:         raw,
		rawHash:         sha256Hex(raw),
		newSongVersions: defaultMusicExOverrideMeta().NewSongVersions,
	}

	upserted, total, err := c.MergeOverrideSongs([]map[string]any{
		{"title": "Cthugha", "lev_mas_i": "14.2", "lev_exc_i": "12.6"},
		{"title": "既存曲", "lev_mas_i": "15.1"}, // fill-only: upstream empty so applies; existing override updates
	}, false)
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if upserted != 2 {
		t.Fatalf("upserted=%d want 2", upserted)
	}
	if total != 2 {
		t.Fatalf("total=%d want 2", total)
	}

	songs, _, err := readOverridesBundleFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(songs) != 2 {
		t.Fatalf("len(songs)=%d want 2", len(songs))
	}
	found := false
	for _, s := range songs {
		if musicExOverrideValueString(s["title"]) == "Cthugha" {
			found = true
			if musicExOverrideValueString(s["lev_mas_i"]) != "14.2" {
				t.Errorf("Cthugha lev_mas_i=%q", s["lev_mas_i"])
			}
		}
	}
	if !found {
		t.Fatal("Cthugha missing")
	}
	// mergedBody 에 정수가 반영됐는지
	if c.mergedBody == nil {
		t.Fatal("mergedBody nil")
	}
	if got := extractField(t, c.mergedBody, "Cthugha", "lev_mas_i"); got != "14.2" {
		t.Errorf("merged lev_mas_i=%q want 14.2", got)
	}
}
