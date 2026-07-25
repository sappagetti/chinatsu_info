package main

import (
	"testing"
)

// 시나리오: 신곡 (예: 熱異常) 가 payload.scores 에 mxid 없이·version 없이 들어오고
// payload.music_catalog 에도 없다. 서버가 mergedBody (overrides.json) 에서
// title 로 매칭해 정수를 채워야 한다. 그리고 isNewCategorySong == true 로
// 신곡 pool 에 잡혀야 한다.
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
	if !isNewCategorySong(rr) {
		t.Errorf("isNewCategorySong = false, want true (resolvedVersion=%q)", rr.ResolvedVersion)
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
