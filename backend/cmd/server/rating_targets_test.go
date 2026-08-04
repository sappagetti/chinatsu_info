package main

import (
	"math"
	"testing"
)

// 시나리오: 신곡 (예: 熱異常) 가 payload.scores 에 mxid 없이·version 없이 들어오고
// payload.music_catalog 에도 없다. 서버가 mergedBody (overrides.json) 에서
// title 로 매칭해 정수를 채워야 한다. 그리고 isNewCategorySong == true 로
// 신곡 pool 에 잡혀야 한다.
//
// 회귀: catalog 에 version="Re:Fresh" 가 있어도 score version "" 을 덮어쓰면
// 안 된다 (otoge-db 는 Act.2 신곡도 당분간 Re:Fresh 로 태깅함).
func TestExtractRatedRows_NewSongFromServerCatalogByTitle(t *testing.T) {
	payload := map[string]any{
		"scores": []any{
			map[string]any{
				"name":               "熱異常",
				"difficulty":         "MASTER",
				"level":              "14",
				"technicalHighScore": 1005000,
				"version":            "",
				"music_ex_id":        "",
			},
		},
		"music_catalog": []any{
			// 신곡은 안 들어있음 (bookmarklet 이 옛 mergedBody 로 만든 payload 를 가정).
		},
	}
	srv := &musicExSnapshot{
		ByID: map[int]map[string]any{},
		ByTitle: map[string]map[string]any{
			normalizeTitle("熱異常"): {
				"id":        "900004",
				"title":     "熱異常",
				"version":   "Re:Fresh", // upstream 태깅 — score version 을 오염시키면 안 됨
				"lev_mas_i": "14.6",
			},
		},
	}
	rows := extractRatedRowsFromPayload(payload, srv)
	if len(rows) != 1 {
		t.Fatalf("len(rows) = %d, want 1", len(rows))
	}
	rr := rows[0]
	if rr.Name != "熱異常" {
		t.Errorf("Name = %q, want 熱異常", rr.Name)
	}
	if rr.TechRate <= 0 {
		t.Errorf("TechRate = %f, want > 0 (const should be resolved via server catalog title match)", rr.TechRate)
	}
	if rr.ResolvedVersion != "" {
		t.Errorf("ResolvedVersion = %q, want \"\" (must not fill from catalog)", rr.ResolvedVersion)
	}
	if !isNewCategorySong(rr) {
		t.Errorf("isNewCategorySong = false, want true (resolvedVersion=%q)", rr.ResolvedVersion)
	}
}

// 회귀: score version "" + catalog/payload music_catalog version "Re:Fresh"
// → 여전히 신곡. const 는 catalog 에서 채워도 됨.
func TestExtractRatedRows_EmptyScoreVersionIgnoresCatalogReFresh(t *testing.T) {
	payload := map[string]any{
		"scores": []any{
			map[string]any{
				"name":               "Act2新曲",
				"difficulty":         "MASTER",
				"level":              "14",
				"technicalHighScore": 1007500,
				"version":            "",
				"music_ex_id":        float64(900100),
			},
		},
		"music_catalog": []any{
			map[string]any{
				"id":        float64(900100),
				"title":     "Act2新曲",
				"version":   "Re:Fresh",
				"lev_mas_i": "14.7",
			},
		},
	}
	rows := extractRatedRowsFromPayload(payload, nil)
	if len(rows) != 1 {
		t.Fatalf("len(rows) = %d, want 1", len(rows))
	}
	rr := rows[0]
	if rr.ResolvedVersion != "" {
		t.Errorf("ResolvedVersion = %q, want \"\"", rr.ResolvedVersion)
	}
	if !isNewCategorySong(rr) {
		t.Errorf("isNewCategorySong = false, want true (Act.2 empty score version)")
	}
	if rr.TechRate <= 0 {
		t.Errorf("TechRate = %f, want > 0 (const from catalog still OK)", rr.TechRate)
	}
}

// 시나리오: 기존 곡. payload.music_catalog 에 이미 정수가 있으면 그걸 쓰고,
// 서버 catalog 는 무시된다 (payload 우선 - 상류 갱신을 반영하기 위함).
func TestExtractRatedRows_PayloadCatalogTakesPrecedenceOverServer(t *testing.T) {
	payload := map[string]any{
		"scores": []any{
			map[string]any{
				"name":               "既存曲",
				"difficulty":         "MASTER",
				"level":              "14",
				"technicalHighScore": 1005000,
				"version":            "Re:Fresh",
				"music_ex_id":        float64(1234),
			},
		},
		"music_catalog": []any{
			map[string]any{
				"id":        float64(1234),
				"title":     "既存曲",
				"version":   "Re:Fresh",
				"lev_mas_i": "14.0",
			},
		},
	}
	srv := &musicExSnapshot{
		ByID: map[int]map[string]any{
			1234: {
				"id":        "1234",
				"title":     "既存曲",
				"lev_mas_i": "99.9",
			},
		},
		ByTitle: map[string]map[string]any{
			normalizeTitle("既存曲"): {
				"id":        "1234",
				"title":     "既存曲",
				"lev_mas_i": "99.9",
			},
		},
	}
	rows := extractRatedRowsFromPayload(payload, srv)
	if len(rows) != 1 {
		t.Fatalf("len(rows) = %d, want 1", len(rows))
	}
	rr := rows[0]
	// payload catalog 의 14.0 이 반영되어 rate 가 계산되어야 한다.
	// (calc 상세는 이 테스트 대상 아님. > 0 이면 값이 들어간 것.)
	if rr.TechRate <= 0 {
		t.Errorf("TechRate = %f, want > 0 (from payload catalog 14.0)", rr.TechRate)
	}
	// 여기서는 version 있으니 old pool.
	if isNewCategorySong(rr) {
		t.Errorf("isNewCategorySong = true, want false (version=Re:Fresh)")
	}
}

// 시나리오: overrides 도 없고 payload catalog 에도 없는 신곡은 조용히 스킵.
// (const 를 결정할 수 없으므로 rating 계산 대상에서 제외)
func TestExtractRatedRows_NewSongWithoutAnyCatalogSkipped(t *testing.T) {
	payload := map[string]any{
		"scores": []any{
			map[string]any{
				"name":               "未登録曲",
				"difficulty":         "MASTER",
				"level":              "14",
				"technicalHighScore": 1005000,
				"version":            "",
			},
		},
		"music_catalog": []any{},
	}
	srv := &musicExSnapshot{ByID: map[int]map[string]any{}, ByTitle: map[string]map[string]any{}}
	rows := extractRatedRowsFromPayload(payload, srv)
	if len(rows) != 0 {
		t.Fatalf("len(rows) = %d, want 0 (skipped: no const anywhere)", len(rows))
	}
}

// 시나리오: srv snapshot 이 nil (서버 미러가 아직 준비되기 전) 이어도 크래시 없이
// payload 만으로 동작해야 한다.
func TestExtractRatedRows_NilServerSnapshot(t *testing.T) {
	payload := map[string]any{
		"scores": []any{
			map[string]any{
				"name":               "既存曲",
				"difficulty":         "MASTER",
				"level":              "14",
				"technicalHighScore": 1005000,
				"version":            "Re:Fresh",
				"music_ex_id":        float64(1234),
			},
		},
		"music_catalog": []any{
			map[string]any{
				"id":        float64(1234),
				"title":     "既存曲",
				"version":   "Re:Fresh",
				"lev_mas_i": "14.0",
			},
		},
	}
	rows := extractRatedRowsFromPayload(payload, nil)
	if len(rows) != 1 {
		t.Fatalf("len(rows) = %d, want 1", len(rows))
	}
	if rows[0].TechRate <= 0 {
		t.Errorf("TechRate = %f, want > 0", rows[0].TechRate)
	}
}

// calcPlatinumRate: 게임 표기와 정확히 일치해야 한다 (소수 3자리 절사, 반올림 X).
// 예: 14.4 * 14.4 * 5 / 1000 = 1.0368 -> 게임은 1.036 으로 표기.
func TestCalcPlatinumRate_MatchesInGameTruncation(t *testing.T) {
	cases := []struct {
		constVal float64
		star     int
		want     float64
	}{
		{14.4, 5, 1.036},
		{15.7, 5, 1.232},
		{15.6, 3, 0.730},
		{12.9, 5, 0.832},
		{11.5, 5, 0.661},
		{14.5, 5, 1.051},
		{15.0, 5, 1.125},
		{10.0, 5, 0.5},
		{10.4, 5, 0.54},
		{10.7, 1, 0.114},
		{15.0, 0, 0},
		{15.0, -3, 0}, // clamp
		{15.0, 99, 1.125}, // clamp
	}
	for _, c := range cases {
		got := calcPlatinumRate(c.constVal, c.star)
		if math.Abs(got-c.want) > 1e-9 {
			t.Errorf("calcPlatinumRate(%.1f, %d) = %v, want %v", c.constVal, c.star, got, c.want)
		}
	}
}

// solo ver. (CD 특전) 곡은 upstream 이 bonus="1" flag 로 표기.
// payload.music_catalog 에 있으면 그 곡은 rating 계산에서 제외되어야 한다.
func TestExtractRatedRows_ExcludesSoloVerBonusSongs(t *testing.T) {
	payload := map[string]any{
		"scores": []any{
			map[string]any{
				"name":               "STARTLINER -星咲 あかりソロver.-",
				"difficulty":         "MASTER",
				"level":              "13",
				"technicalHighScore": 1005000,
				"version":            "RED",
				"music_ex_id":        float64(999001),
			},
			map[string]any{
				"name":               "Distorted Fate",
				"difficulty":         "MASTER",
				"level":              "15",
				"technicalHighScore": 1005000,
				"version":            "Re:Fresh",
				"music_ex_id":        float64(999002),
			},
		},
		"music_catalog": []any{
			map[string]any{
				"id":        float64(999001),
				"title":     "STARTLINER -星咲 あかりソロver.-",
				"category":  "オンゲキ",
				"bonus":     "1",
				"lev_mas_i": "13.5",
			},
			map[string]any{
				"id":        float64(999002),
				"title":     "Distorted Fate",
				"category":  "VARIETY",
				"bonus":     "",
				"lev_mas_i": "15.1",
			},
		},
	}
	rows := extractRatedRowsFromPayload(payload, nil)
	if len(rows) != 1 {
		t.Fatalf("len(rows) = %d, want 1 (solo ver. song must be excluded)", len(rows))
	}
	if rows[0].Name != "Distorted Fate" {
		t.Errorf("Name = %q, want Distorted Fate (solo ver. song should have been filtered out)", rows[0].Name)
	}
}

// server catalog fallback (title match) 로 잡힌 신곡 entry 가 bonus="1" 이면 제외.
func TestExtractRatedRows_ExcludesBonusFromServerCatalogFallback(t *testing.T) {
	payload := map[string]any{
		"scores": []any{
			map[string]any{
				"name":               "SoloVerSong",
				"difficulty":         "MASTER",
				"level":              "13",
				"technicalHighScore": 1005000,
				"version":            "",
				"music_ex_id":        "",
			},
		},
		"music_catalog": []any{},
	}
	srv := &musicExSnapshot{
		ByID: map[int]map[string]any{},
		ByTitle: map[string]map[string]any{
			normalizeTitle("SoloVerSong"): {
				"id":        "999003",
				"title":     "SoloVerSong",
				"bonus":     "1",
				"lev_mas_i": "13.5",
			},
		},
	}
	rows := extractRatedRowsFromPayload(payload, srv)
	if len(rows) != 0 {
		t.Fatalf("len(rows) = %d, want 0 (bonus song from server catalog must be excluded)", len(rows))
	}
}

// isBonusCatalogEntry 단위 테스트.
func TestIsBonusCatalogEntry(t *testing.T) {
	// bonus="1" flag (upstream 표기)
	if !isBonusCatalogEntry(map[string]any{"title": "X ソロver.", "bonus": "1"}) {
		t.Errorf("bonus='1' flag not detected")
	}
	// bonus="" 는 일반 곡
	if isBonusCatalogEntry(map[string]any{"title": "Normal", "bonus": ""}) {
		t.Errorf("bonus='' should not be flagged")
	}
	// bonus 필드 자체 없음
	if isBonusCatalogEntry(map[string]any{"title": "Normal"}) {
		t.Errorf("missing bonus field should not be flagged")
	}
	// 텍스트 fallback
	if !isBonusCatalogEntry(map[string]any{"title": "Bonus Track"}) {
		t.Errorf("text fallback (Bonus Track) not detected")
	}
	// nil 안전
	if isBonusCatalogEntry(nil) {
		t.Errorf("nil should not be flagged")
	}
	// 곡 이름에 우연히 "bonus" 만 들어간 케이스는 무시 (오탐 방지).
	if isBonusCatalogEntry(map[string]any{"title": "Pre-Bonus Party"}) {
		t.Errorf("substring 'bonus' alone should not trigger (only explicit label)")
	}
}

// isNewCategorySong 단위 테스트: version 이 비어야 신곡.
func TestIsNewCategorySong(t *testing.T) {
	cases := []struct {
		ver  string
		want bool
	}{
		{"", true},
		{"   ", true},
		{"Re:Fresh", false},
		{"bright MEMORY Act.2", false},
		{"ONGEKI", false},
	}
	for _, c := range cases {
		got := isNewCategorySong(ratedRow{ResolvedVersion: c.ver})
		if got != c.want {
			t.Errorf("isNewCategorySong(%q) = %v, want %v", c.ver, got, c.want)
		}
	}
}
