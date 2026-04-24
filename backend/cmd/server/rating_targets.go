package main

import (
	"net/http"
	"sort"
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

func handleRatingTargets(st *store.Store) http.HandlerFunc {
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
		rows := extractRatedRowsFromPayload(snap.Payload)
		newPool := make([]ratedRow, 0, len(rows))
		oldPool := make([]ratedRow, 0, len(rows))
		platPool := make([]ratedRow, 0, len(rows))
		for _, rr := range rows {
			if isRefreshVersion(rr) {
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

func calcPlatinumRate(constVal float64, star int) float64 {
	s := star
	if s < 0 {
		s = 0
	}
	if s > 5 {
		s = 5
	}
	return (constVal * constVal * float64(s)) / 1000
}

func isRefreshVersion(rr ratedRow) bool {
	v := strings.ToLower(strings.Join(strings.Fields(rr.ResolvedVersion), ""))
	return strings.Contains(v, "re:fresh") || strings.Contains(v, "refresh")
}

func isBonusTrackText(v string) bool {
	t := strings.ToLower(strings.TrimSpace(v))
	if t == "" {
		return false
	}
	return strings.Contains(t, "ボーナス") ||
		strings.Contains(t, "bonus track") ||
		strings.Contains(t, "bonustrack") ||
		strings.Contains(t, "bonus")
}

func parseFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int:
		return float64(t), true
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

func extractRatedRowsFromPayload(payload map[string]any) []ratedRow {
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
			isBonus := false
			for _, v := range cat {
				if isBonusTrackText(toString(v)) {
					isBonus = true
					break
				}
			}
			if !isBonus {
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
		constVal := 0.0
		if c, ok := parseFloat(row["const"]); ok {
			constVal = c
		}
		if cat, ok := catalogByID[musicExID]; ok {
			if c, ok := catalogConstByDifficulty(cat, toString(row["difficulty"])); ok {
				constVal = c
			}
		}
		if constVal <= 0 {
			continue
		}
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
			ResolvedVersion:    toString(row["version"]),
		})
	}
	return out
}
