package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// helper: 머지 결과 바이트를 다시 파싱해 곡 한 건의 필드 값을 꺼낸다.
func extractField(t *testing.T, body []byte, title, field string) string {
	t.Helper()
	var arr []map[string]any
	if err := json.Unmarshal(body, &arr); err != nil {
		t.Fatalf("unmarshal merged body: %v", err)
	}
	for _, item := range arr {
		if s, _ := item["title"].(string); s == title {
			return musicExOverrideValueString(item[field])
		}
	}
	return ""
}

func TestApplyOverrides_FillEmptyByTitle(t *testing.T) {
	raw := []byte(`[
		{"id":"1","title":"星綴りのアルケミスト","artist":"X","lev_mas":"14","lev_mas_i":"","lev_exc":"12","lev_exc_i":""}
	]`)
	overrides, err := parseMusicExOverrides([]byte(`[
		{"title":"星綴りのアルケミスト","lev_mas_i":"14.6","lev_exc_i":"12.4"}
	]`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	merged, applied, err := applyMusicExOverrides(raw, overrides)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if applied != 1 {
		t.Fatalf("applied = %d, want 1", applied)
	}
	if got := extractField(t, merged, "星綴りのアルケミスト", "lev_mas_i"); got != "14.6" {
		t.Errorf("lev_mas_i = %q, want 14.6", got)
	}
	if got := extractField(t, merged, "星綴りのアルケミスト", "lev_exc_i"); got != "12.4" {
		t.Errorf("lev_exc_i = %q, want 12.4", got)
	}
}

func TestApplyOverrides_FillOnlyLeavesExisting(t *testing.T) {
	raw := []byte(`[
		{"id":"1","title":"既存曲","lev_mas_i":"13.7"}
	]`)
	overrides, err := parseMusicExOverrides([]byte(`[
		{"title":"既存曲","lev_mas_i":"99.9"}
	]`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	merged, applied, err := applyMusicExOverrides(raw, overrides)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if applied != 0 {
		t.Fatalf("applied = %d, want 0 (fill-only must not overwrite)", applied)
	}
	if got := extractField(t, merged, "既存曲", "lev_mas_i"); got != "13.7" {
		t.Errorf("lev_mas_i = %q, want 13.7 (untouched)", got)
	}
}

func TestApplyOverrides_ForceOverwrites(t *testing.T) {
	raw := []byte(`[{"id":"1","title":"既存曲","lev_mas_i":"13.7"}]`)
	overrides, err := parseMusicExOverrides([]byte(`[
		{"title":"既存曲","lev_mas_i":"14.0","force":true}
	]`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	merged, applied, err := applyMusicExOverrides(raw, overrides)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if applied != 1 {
		t.Fatalf("applied = %d, want 1", applied)
	}
	if got := extractField(t, merged, "既存曲", "lev_mas_i"); got != "14.0" {
		t.Errorf("lev_mas_i = %q, want 14.0 (force should overwrite)", got)
	}
}

func TestApplyOverrides_MatchByID(t *testing.T) {
	raw := []byte(`[
		{"id":"100","title":"同名曲","artist":"A","lev_mas_i":""},
		{"id":"200","title":"同名曲","artist":"B","lev_mas_i":""}
	]`)
	overrides, err := parseMusicExOverrides([]byte(`[
		{"id":"200","lev_mas_i":"15.0"}
	]`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	merged, applied, err := applyMusicExOverrides(raw, overrides)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if applied != 1 {
		t.Fatalf("applied = %d, want 1", applied)
	}
	var arr []map[string]any
	_ = json.Unmarshal(merged, &arr)
	got100 := musicExOverrideValueString(arr[0]["lev_mas_i"])
	got200 := musicExOverrideValueString(arr[1]["lev_mas_i"])
	if got100 != "" {
		t.Errorf("id=100 lev_mas_i = %q, want empty (not matched)", got100)
	}
	if got200 != "15.0" {
		t.Errorf("id=200 lev_mas_i = %q, want 15.0", got200)
	}
}

func TestApplyOverrides_MatchByTitleArtist(t *testing.T) {
	raw := []byte(`[
		{"id":"100","title":"同名曲","artist":"A","lev_mas_i":""},
		{"id":"200","title":"同名曲","artist":"B","lev_mas_i":""}
	]`)
	overrides, err := parseMusicExOverrides([]byte(`[
		{"title":"同名曲","artist":"B","lev_mas_i":"15.0"}
	]`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	merged, _, err := applyMusicExOverrides(raw, overrides)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	var arr []map[string]any
	_ = json.Unmarshal(merged, &arr)
	if got := musicExOverrideValueString(arr[0]["lev_mas_i"]); got != "" {
		t.Errorf("artist=A lev_mas_i = %q, want empty", got)
	}
	if got := musicExOverrideValueString(arr[1]["lev_mas_i"]); got != "15.0" {
		t.Errorf("artist=B lev_mas_i = %q, want 15.0", got)
	}
}

func TestApplyOverrides_NumericValueAccepted(t *testing.T) {
	// 사용자가 문자열 대신 숫자로 적어도 받아준다.
	raw := []byte(`[{"id":"1","title":"X","lev_mas_i":""}]`)
	overrides, err := parseMusicExOverrides([]byte(`[
		{"title":"X","lev_mas_i":13.0}
	]`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	merged, applied, err := applyMusicExOverrides(raw, overrides)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if applied != 1 {
		t.Fatalf("applied = %d, want 1", applied)
	}
	if got := extractField(t, merged, "X", "lev_mas_i"); got != "13" {
		t.Errorf("lev_mas_i = %q, want 13 (numeric→string)", got)
	}
}

func TestApplyOverrides_ZeroAppliedReturnsRawIdentity(t *testing.T) {
	// 매칭 0건이면 같은 슬라이스가 반환되어야 한다 (불필요 재마샬 회피).
	raw := []byte(`[{"id":"1","title":"X","lev_mas_i":"13.0"}]`)
	overrides, _ := parseMusicExOverrides([]byte(`[
		{"title":"未知の曲","lev_mas_i":"99.9"}
	]`))
	merged, applied, _ := applyMusicExOverrides(raw, overrides)
	if applied != 0 {
		t.Fatalf("applied = %d, want 0", applied)
	}
	if &merged[0] != &raw[0] {
		t.Errorf("expected to return rawBody as-is when no overrides applied")
	}
}

func TestParseOverrides_SkipsUnknownFieldsAndEmpty(t *testing.T) {
	overrides, err := parseMusicExOverrides([]byte(`[
		{"title":"A","unknown_field":"x","lev_mas_i":"13.0"},
		{"title":"B"},
		{"title":"C","lev_mas_i":""},
		{"lev_mas_i":"14.0"},
		{"title":"","lev_mas_i":"14.0"}
	]`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(overrides) != 1 {
		for _, o := range overrides {
			t.Logf("entry: id=%q title=%q fields=%v", o.id, o.title, o.fields)
		}
		t.Fatalf("len(overrides) = %d, want 1 (only A should remain)", len(overrides))
	}
	if overrides[0].title != "A" {
		t.Errorf("overrides[0].title = %q, want A", overrides[0].title)
	}
	if _, ok := overrides[0].fields["unknown_field"]; ok {
		t.Errorf("unknown_field should have been dropped")
	}
	if overrides[0].fields["lev_mas_i"] != "13.0" {
		t.Errorf("lev_mas_i = %q, want 13.0", overrides[0].fields["lev_mas_i"])
	}
}

func TestParseOverrides_BadJSONReturnsError(t *testing.T) {
	_, err := parseMusicExOverrides([]byte(`{not-an-array}`))
	if err == nil {
		t.Fatalf("expected error on bad JSON")
	}
	if !strings.Contains(err.Error(), "parse overrides") {
		t.Errorf("err = %v, want wrapped 'parse overrides'", err)
	}
}
