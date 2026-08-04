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

func TestApplyOverrides_NoMatchAndNoTitleReturnsRawIdentity(t *testing.T) {
	// id 는 있지만 매칭 대상 arr 에 없고, title 도 없으면 auto-add 도 발동하지
	// 않아 applied=0. 이 경우 rawBody 를 그대로 돌려줘야 한다 (재마샬 회피).
	raw := []byte(`[{"id":"1","title":"X","lev_mas_i":"13.0"}]`)
	overrides, _ := parseMusicExOverrides([]byte(`[
		{"id":"99999","lev_mas_i":"99.9"}
	]`))
	merged, applied, _ := applyMusicExOverrides(raw, overrides)
	if applied != 0 {
		t.Fatalf("applied = %d, want 0", applied)
	}
	if &merged[0] != &raw[0] {
		t.Errorf("expected to return rawBody as-is when no overrides applied")
	}
}

func TestParseOverrides_KeepsUnknownFieldsForAddMode(t *testing.T) {
	// parse 단계는 화이트리스트로 거르지 않는다 (add 모드에서 임의 필드가 필요할 수 있음).
	// 대신 update 모드에서 화이트리스트 밖 필드가 무시되는지는 별도 apply 테스트로 검증.
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
		t.Fatalf("len(overrides) = %d, want 1 (only A should remain: B/C have no fields, others have no id+title)", len(overrides))
	}
	if overrides[0].title != "A" {
		t.Errorf("overrides[0].title = %q, want A", overrides[0].title)
	}
	if v, ok := overrides[0].fields["unknown_field"]; !ok || v != "x" {
		t.Errorf("unknown_field = (%q, %v), want kept as (\"x\", true)", v, ok)
	}
	if overrides[0].fields["lev_mas_i"] != "13.0" {
		t.Errorf("lev_mas_i = %q, want 13.0", overrides[0].fields["lev_mas_i"])
	}
}

func TestApplyOverrides_UpdateModeIgnoresNonWhitelistedFields(t *testing.T) {
	// 기존 곡 매칭 성공 시엔 화이트리스트(정수)만 반영해야 한다.
	// title/artist/version 등을 실수로 override 에 넣어도 무시되어야 함.
	raw := []byte(`[{"id":"1","title":"既存曲","artist":"元アーティスト","version":"bright MEMORY","lev_mas_i":""}]`)
	overrides, err := parseMusicExOverrides([]byte(`[
		{"id":"1","title":"変更しちゃった","artist":"変わっちゃった","version":"Re:Fresh","image_url":"x.png","lev_mas_i":"14.5"}
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
	if got := extractField(t, merged, "既存曲", "lev_mas_i"); got != "14.5" {
		t.Errorf("lev_mas_i = %q, want 14.5", got)
	}
	// 화이트리스트 밖 필드는 그대로여야 한다.
	if got := extractField(t, merged, "既存曲", "artist"); got != "元アーティスト" {
		t.Errorf("artist = %q, want 元アーティスト (unchanged)", got)
	}
	if got := extractField(t, merged, "既存曲", "version"); got != "bright MEMORY" {
		t.Errorf("version = %q, want bright MEMORY (unchanged)", got)
	}
	if got := extractField(t, merged, "既存曲", "image_url"); got != "" {
		t.Errorf("image_url = %q, want empty (unknown field must not be added on update)", got)
	}
}

func TestApplyOverrides_AutoAppendNewSong(t *testing.T) {
	// 매칭 실패 + title 있으면 신곡으로 append.
	raw := []byte(`[{"id":"1","title":"既存曲","lev_mas_i":"13.0"}]`)
	overrides, err := parseMusicExOverrides([]byte(`[
		{"id":"900001","title":"熱異常","version":"Re:Fresh","lev_mas":"14","lev_mas_i":"14.6","lev_exc":"12","lev_exc_i":"12.0","image_url":"x.png"}
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
	// 새 곡이 실제로 배열에 추가되었는지 (모든 필드 유지).
	var arr []map[string]any
	if err := json.Unmarshal(merged, &arr); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(arr) != 2 {
		t.Fatalf("len(arr) = %d, want 2", len(arr))
	}
	if got := extractField(t, merged, "熱異常", "id"); got != "900001" {
		t.Errorf("id = %q, want 900001", got)
	}
	if got := extractField(t, merged, "熱異常", "version"); got != "Re:Fresh" {
		t.Errorf("version = %q, want Re:Fresh (add mode preserves all fields)", got)
	}
	if got := extractField(t, merged, "熱異常", "lev_mas_i"); got != "14.6" {
		t.Errorf("lev_mas_i = %q, want 14.6", got)
	}
	if got := extractField(t, merged, "熱異常", "lev_exc_i"); got != "12.0" {
		t.Errorf("lev_exc_i = %q, want 12.0", got)
	}
	if got := extractField(t, merged, "熱異常", "image_url"); got != "x.png" {
		t.Errorf("image_url = %q, want x.png (add mode keeps arbitrary fields)", got)
	}
	// 기존 곡은 손대지 않아야 한다.
	if got := extractField(t, merged, "既存曲", "lev_mas_i"); got != "13.0" {
		t.Errorf("既存曲 lev_mas_i = %q, want 13.0 (untouched)", got)
	}
}

func TestApplyOverrides_IDMissTitleHitUpdatesInsteadOfAppend(t *testing.T) {
	// 우리가 임의 id (900001) 로 신곡 override 를 만들었는데, upstream 이 나중에
	// 실제 id (12345) 로 같은 title 의 곡을 넣었다고 가정. 다시 apply 하면
	// id 매칭은 실패하지만 title 로 upstream row 를 잡아서 update 로 흡수해야 하고,
	// catalog 에 중복 append 되면 안 된다.
	raw := []byte(`[
		{"id":"1","title":"既存曲","lev_mas_i":"13.0"},
		{"id":"12345","title":"熱異常","version":"Re:Fresh","lev_mas":"14","lev_mas_i":""}
	]`)
	overrides, err := parseMusicExOverrides([]byte(`[
		{"id":"900001","title":"熱異常","version":"bright MEMORY","lev_mas":"14","lev_mas_i":"14.6"}
	]`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	merged, applied, err := applyMusicExOverrides(raw, overrides)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if applied != 1 {
		t.Fatalf("applied = %d, want 1 (update, not add)", applied)
	}
	var arr []map[string]any
	if err := json.Unmarshal(merged, &arr); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(arr) != 2 {
		t.Errorf("len(arr) = %d, want 2 (must NOT append duplicate)", len(arr))
	}
	// 정수는 override 로 채워짐 (update mode, upstream 이 비어있었으니 fill-only 통과).
	if got := extractField(t, merged, "熱異常", "lev_mas_i"); got != "14.6" {
		t.Errorf("lev_mas_i = %q, want 14.6", got)
	}
	// version 은 upstream 값이 유지되어야 함 (update mode 는 화이트리스트 밖 필드 무시).
	if got := extractField(t, merged, "熱異常", "version"); got != "Re:Fresh" {
		t.Errorf("version = %q, want Re:Fresh (upstream value preserved)", got)
	}
	// 원래 id 도 그대로.
	if got := extractField(t, merged, "熱異常", "id"); got != "12345" {
		t.Errorf("id = %q, want 12345 (upstream id preserved)", got)
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

func TestApplyVersionSplits_RewritesAct2ByDate(t *testing.T) {
	raw := []byte(`[
		{"id":"1","title":"旧ReFresh","version":"Re:Fresh","date_added":"20250401","lev_mas_i":"14.0"},
		{"id":"2","title":"熱異常","version":"Re:Fresh","date_added":"20260723","lev_mas_i":"14.6"},
		{"id":"3","title":"LNT","version":"Re:Fresh","date_added":"20260723","lev_lnt":"14+","lev_lnt_i":"14.7"}
	]`)
	meta := defaultMusicExOverrideMeta()
	merged, n, err := applyVersionSplitsToBody(raw, meta.VersionSplits)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if n != 2 {
		t.Fatalf("changed = %d, want 2 (Act.2 song + LNT)", n)
	}
	if got := extractField(t, merged, "旧ReFresh", "version"); got != "Re:Fresh" {
		t.Errorf("旧ReFresh version = %q, want Re:Fresh", got)
	}
	if got := extractField(t, merged, "熱異常", "version"); got != "Re:Fresh Act.2" {
		t.Errorf("熱異常 version = %q, want Re:Fresh Act.2", got)
	}
	if got := extractField(t, merged, "LNT", "version"); got != "Re:Fresh Act.2" {
		t.Errorf("LNT version = %q, want Re:Fresh Act.2", got)
	}
}

func TestParseOverridesBundle_ObjectMeta(t *testing.T) {
	songs, meta, err := parseMusicExOverridesBundle([]byte(`{
		"_meta": {
			"new_song_versions": ["Re:Fresh Act.2"],
			"version_splits": [
				{"from":"Re:Fresh","to":"Re:Fresh Act.2","since":"20260723"}
			]
		},
		"songs": [
			{"title":"X","lev_mas_i":"14.0","force":true}
		]
	}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(songs) != 1 || songs[0].title != "X" {
		t.Fatalf("songs = %+v, want one X", songs)
	}
	if len(meta.NewSongVersions) != 1 || meta.NewSongVersions[0] != "Re:Fresh Act.2" {
		t.Errorf("NewSongVersions = %v", meta.NewSongVersions)
	}
	if len(meta.VersionSplits) != 1 || meta.VersionSplits[0].Since != "20260723" {
		t.Errorf("VersionSplits = %+v", meta.VersionSplits)
	}
}
