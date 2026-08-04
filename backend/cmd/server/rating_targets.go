package main

import (
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/rhythm-info/backend/internal/store"
)

const (
	newCount  = 10
	oldCount  = 50
	platCount = 50
)

type ratedRow struct {
	Name               string  `json:"name"`
	Difficulty         string  `json:"difficulty"`
	Level              string  `json:"level"`
	MusicExID          int     `json:"music_ex_id,omitempty"`
	TechnicalHighScore int     `json:"technical_high_score"`
	PlatinumHighScore  int     `json:"platinum_high_score"`
	PlatinumStar       int     `json:"platinum_star"`
	LampForRating      string  `json:"lamp_for_rating"`
	TechRate           float64 `json:"tech_rate"`
	PlatRate           float64 `json:"plat_rate"`
	ResolvedVersion    string  `json:"-"`
}

func handleRatingTargets(st *store.Store, mc *musicExCache) http.HandlerFunc {
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
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{
				"last_synced_at": nil,
				"new_top":        []ratedRow{},
				"old_top":        []ratedRow{},
				"plat_top":       []ratedRow{},
			})
			return
		}
		// 서버가 미러링·오버라이드 머지한 music-ex.json 을 payload catalog 의
		// 보조 소스로 쓴다. 신곡은 payload 안 catalog 에 mxid 가 없이 오므로
		// (bookmarklet 소스에도 아직 없음) 서버 catalog 를 title 로 매칭해야
		// 정수 (`lev_*_i`) 를 얻을 수 있다.
		rows := extractRatedRowsFromPayload(snap.Payload, mc.Snapshot())
		newPool := make([]ratedRow, 0, len(rows))
		oldPool := make([]ratedRow, 0, len(rows))
		platPool := make([]ratedRow, 0, len(rows))
		for _, rr := range rows {
			if isNewCategorySong(rr) {
				newPool = append(newPool, rr)
			} else {
				oldPool = append(oldPool, rr)
			}
			if rr.PlatinumHighScore > 0 {
				platPool = append(platPool, rr)
			}
		}
		sort.Slice(newPool, func(i, j int) bool {
			if newPool[i].TechRate != newPool[j].TechRate {
				return newPool[i].TechRate > newPool[j].TechRate
			}
			return newPool[i].TechnicalHighScore > newPool[j].TechnicalHighScore
		})
		sort.Slice(oldPool, func(i, j int) bool {
			if oldPool[i].TechRate != oldPool[j].TechRate {
				return oldPool[i].TechRate > oldPool[j].TechRate
			}
			return oldPool[i].TechnicalHighScore > oldPool[j].TechnicalHighScore
		})
		sort.Slice(platPool, func(i, j int) bool {
			if platPool[i].PlatRate != platPool[j].PlatRate {
				return platPool[i].PlatRate > platPool[j].PlatRate
			}
			return platPool[i].PlatinumStar > platPool[j].PlatinumStar
		})
		writeJSON(w, http.StatusOK, map[string]any{
			"last_synced_at": snap.CreatedAt.UTC().Format(time.RFC3339),
			"new_top":        topN(newPool, newCount),
			"old_top":        topN(oldPool, oldCount),
			"plat_top":       topN(platPool, platCount),
		})
	}
}

func topN(in []ratedRow, n int) []ratedRow {
	if len(in) <= n {
		return in
	}
	return in[:n]
}

func toInt(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	default:
		return 0
	}
}

func toBool(v any) bool {
	b, _ := v.(bool)
	return b
}

func toString(v any) string {
	s, _ := v.(string)
	return s
}

func normalizeTitle(v string) string {
	return strings.ToLower(strings.Join(strings.Fields(v), ""))
}

func calcMainRate(constVal float64, technical int) float64 {
	extra := constVal * 1000
	result := 0.0
	switch {
	case technical == 1010000:
		result = extra + 2000
	case technical >= 1007500:
		result = extra + 1750 + float64((technical-1007500)/10)
	case technical >= 1000000:
		result = extra + 1250 + float64((technical-1000000)/15)
	case technical >= 990000:
		result = extra + 750 + float64((technical-990000)/20)
	case technical >= 970000:
		result = extra + float64(technical-970000)/26.666
	default:
		result = extra - float64((970000-technical)/18)
	}
	if result < 0 {
		result = 0
	}
	return result / 1000
}

func calcRankBonus(technical int) float64 {
	if technical >= 1007500 {
		return 0.3
	}
	if technical >= 1000000 {
		return 0.2
	}
	if technical >= 990000 {
		return 0.1
	}
	return 0
}

func getLampForRating(technical int, fullBell, fullCombo, allBreak bool) string {
	if technical == 1010000 {
		if fullBell {
			return "FB/AB+"
		}
		return "AB+"
	}
	if allBreak {
		if fullBell {
			return "FB/AB"
		}
		return "AB"
	}
	if fullCombo {
		if fullBell {
			return "FB/FC"
		}
		return "FC"
	}
	if fullBell {
		return "FB"
	}
	return ""
}

func calcLampBonus(lamp string) float64 {
	switch lamp {
	case "FB/AB+":
		return 0.4
	case "AB+", "FB/AB":
		return 0.35
	case "AB":
		return 0.3
	case "FB/FC":
		return 0.15
	case "FC":
		return 0.1
	case "FB":
		return 0.05
	default:
		return 0
	}
}

// calcPlatinumRate: P スコア レート.
// (const^2 × star) / 1000. 게임 표기와 동일하게 소수 4자리 이하를 truncate.
// 예: const=14.4, star=5 -> 1.0368 -> 1.036.
// 프론트 `calcPlatinumRate` (ratingCalc.ts) 와 동일 시맨틱.
func calcPlatinumRate(constVal float64, star int) float64 {
	s := star
	if s < 0 {
		s = 0
	}
	if s > 5 {
		s = 5
	}
	raw := (constVal * constVal * float64(s)) / 1000
	return math.Floor(raw*1000) / 1000
}

// isNewCategorySong: 게임의 "신곡 카테고리" (최신 확장 신곡 풀) 여부.
//
// SEGA bookmarklet score payload 는 최신 확장 신곡(예: Re:Fresh Act.2)의
// `version` 을 한동안 비운다. 이전 확장 곡은 이미 비어 있지 않은 값
// (예: "Re:Fresh") 을 가진다. 게임 내 "신곡 카테고리" 판정도 이 시점과
// 맞물리므로, score-row 의 version 이 비어있으면 신곡으로 본다.
//
// 중요: music-ex / otoge-db catalog 의 version 으로 빈 score version 을
// 채우면 안 된다. upstream 은 Act.2 신곡도 당분간 `version="Re:Fresh"` 로
// 태깅해 두기 때문에, catalog fallback 을 쓰면 신곡 pool 이 0이 된다.
// ResolvedVersion 은 score-row version 만 사용한다 (const 등은 catalog OK).
// 프론트 `isNewCategorySong` (ratingCalc.ts) 과 시맨틱을 맞춰야 한다.
func isNewCategorySong(rr ratedRow) bool {
	return strings.TrimSpace(rr.ResolvedVersion) == ""
}

// isBonusCatalogEntry: 게임 내 "보너스 트랙" 카테고리 곡 (레이팅 계산 제외 대상) 인지.
//
// 판정 우선순위:
//   1) `bonus` 필드 값이 "1"     — otoge-db upstream 이 실제로 이 방식으로 표기.
//      2026-07 조사 시점 upstream 전체 곡 중 157 곡이 bonus="1", 이들은
//      전부 "-<キャラ名>ソロver.-" 형식의 CD 특전 해금 곡.
//   2) 필드 어딘가에 "bonus" 문자열 (레거시 안전빵) — 현재 upstream 데이터에는
//      매칭되는 케이스가 없지만, 표기 변경 대비로 유지.
//
// 프론트 `isBonusTrack` (RatingSimulatorPage.tsx) 와 시맨틱을 맞출 것.
func isBonusCatalogEntry(cat map[string]any) bool {
	if cat == nil {
		return false
	}
	if v, ok := cat["bonus"].(string); ok && strings.TrimSpace(v) == "1" {
		return true
	}
	for _, v := range cat {
		if s, ok := v.(string); ok && isBonusTrackText(s) {
			return true
		}
	}
	return false
}

// isBonusTrackText: 문자열 값에 bonus 표기가 포함되었는지 (레거시).
// 현재 upstream 은 `bonus="1"` flag 를 쓰므로 실제 매칭 케이스가 없지만
// 표기 변경 대비 및 payload 안 catalog 의 문자열 필드 재활용을 위해 유지.
// (완전히 "bonus" substring 만 잡으면 필드 값이 "1 bonus 이벤트" 같은 형태에서
//  오탐 가능. 여기서는 명시적 라벨링 문자열만 인식.)
func isBonusTrackText(v string) bool {
	t := strings.ToLower(strings.TrimSpace(v))
	if t == "" {
		return false
	}
	return strings.Contains(t, "ボーナス") ||
		strings.Contains(t, "bonus track") ||
		strings.Contains(t, "bonustrack")
}

// parseFloat: JSON any 값을 float64 로 파싱.
// music-ex.json / catalog 의 `lev_*_i` 는 실제로는 문자열 ("14.6") 로 저장되므로
// 반드시 string 케이스를 함께 처리해야 한다.
func parseFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int:
		return float64(t), true
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0, false
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return 0, false
		}
		return f, true
	default:
		return 0, false
	}
}

func catalogConstByDifficulty(cat map[string]any, difficulty string) (float64, bool) {
	d := strings.ToUpper(strings.TrimSpace(difficulty))
	field := ""
	switch d {
	case "BASIC":
		field = "lev_bas_i"
	case "ADVANCED":
		field = "lev_adv_i"
	case "EXPERT":
		field = "lev_exc_i"
	case "MASTER":
		field = "lev_mas_i"
	case "LUNATIC":
		field = "lev_lnt_i"
	default:
		return 0, false
	}
	return parseFloat(cat[field])
}

// lookupCatalog: score row 하나에 대해 (catalog entry, matched) 를 3단으로 찾는다.
//
//  1. payload.music_catalog[mxid]  — bookmarklet 이 오게키-NET 에서 실시간 긁은 것
//  2. server music-ex.json[mxid]   — 서버 미러 (기존 곡, upstream 갱신 지연 있음)
//  3. server music-ex.json[title]  — mxid 매칭 실패시 title 로. 신곡 (payload 에
//     mxid 없이 오는 케이스) 과 우리 overrides.json 이 임의 id 로 추가한 신곡
//     entry 를 이 단계에서 잡는다.
func lookupCatalog(name string, mxid int, payloadByID map[int]map[string]any, srv *musicExSnapshot) map[string]any {
	if cat, ok := payloadByID[mxid]; ok && mxid > 0 {
		return cat
	}
	if srv != nil {
		if cat, ok := srv.ByID[mxid]; ok && mxid > 0 {
			return cat
		}
		if key := normalizeTitle(name); key != "" {
			if cat, ok := srv.ByTitle[key]; ok {
				return cat
			}
		}
	}
	return nil
}

func extractRatedRowsFromPayload(payload map[string]any, srv *musicExSnapshot) []ratedRow {
	raw, ok := payload["scores"].([]any)
	if !ok {
		return []ratedRow{}
	}
	catalogByID := map[int]map[string]any{}
	bonusByID := map[int]bool{}
	bonusTitleSet := map[string]struct{}{}
	if catalogRaw, ok := payload["music_catalog"].([]any); ok {
		for _, item := range catalogRaw {
			cat, ok := item.(map[string]any)
			if !ok {
				continue
			}
			id := toInt(cat["id"])
			if id > 0 {
				catalogByID[id] = cat
			}
			if !isBonusCatalogEntry(cat) {
				continue
			}
			if id > 0 {
				bonusByID[id] = true
			}
			title := normalizeTitle(toString(cat["title"]))
			if title != "" {
				bonusTitleSet[title] = struct{}{}
			}
		}
	}
	out := make([]ratedRow, 0, len(raw))
	for _, item := range raw {
		row, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name := toString(row["name"])
		if strings.TrimSpace(name) == "" {
			continue
		}
		musicExID := toInt(row["music_ex_id"])
		if bonusByID[musicExID] {
			continue
		}
		if _, ok := bonusTitleSet[normalizeTitle(name)]; ok {
			continue
		}
		level := toString(row["level"])
		cat := lookupCatalog(name, musicExID, catalogByID, srv)
		// 서버 catalog fallback 을 통해 새로 붙은 entry 나 payload 안에 없던
		// 곡이 bonus="1" 로 태깅되어 있으면 여기서도 제외.
		if cat != nil && isBonusCatalogEntry(cat) {
			continue
		}
		constVal := 0.0
		if c, ok := parseFloat(row["const"]); ok {
			constVal = c
		}
		if cat != nil {
			if c, ok := catalogConstByDifficulty(cat, toString(row["difficulty"])); ok {
				constVal = c
			}
		}
		if constVal <= 0 {
			continue
		}
		// version: score-row 만 사용. catalog/otoge-db 의 version 으로 빈 값을
		// 채우면 Act.2 신곡이 "Re:Fresh" 로 오염되어 구곡 pool 로 간다.
		resolvedVersion := strings.TrimSpace(toString(row["version"]))
		technical := toInt(row["technicalHighScore"])
		fullBell := toBool(row["fullBell"])
		allBreak := toBool(row["allBreak"])
		fullCombo := toBool(row["fullCombo"]) || allBreak
		lamp := getLampForRating(technical, fullBell, fullCombo, allBreak)
		techRate := calcMainRate(constVal, technical) + calcRankBonus(technical) + calcLampBonus(lamp)
		platStar := toInt(row["platinumStar"])
		out = append(out, ratedRow{
			Name:               name,
			Difficulty:         toString(row["difficulty"]),
			Level:              level,
			MusicExID:          musicExID,
			TechnicalHighScore: technical,
			PlatinumHighScore:  toInt(row["platinumHighScore"]),
			PlatinumStar:       platStar,
			LampForRating:      lamp,
			TechRate:           techRate,
			PlatRate:           calcPlatinumRate(constVal, platStar),
			ResolvedVersion:    resolvedVersion,
		})
	}
	return out
}
