// music-ex.json 미러에 덧씌울 수동 오버라이드 처리.
//
// 운영 배경:
//   - otoge-db 는 신곡 출시 직후 music-ex.json 항목은 빨리 추가하지만
//     보면정수 (lev_*_i) 는 유저 검증을 거쳐 한참 뒤에 채워진다.
//   - 게다가 게임 확장 초반에는 otoge-db 자체가 곡을 아직 안 넣기도 한다.
//   - 그 공백 기간 동안 우리가 알아낸 정수·곡 자체를 즉시 반영하기 위한 통로.
//   - 정책:
//       기존 곡 update — "fill-only" 가 기본. 상류(otoge-db)가 비었을 때만
//         채운다. force:true 면 값이 있어도 덮어쓴다. 안전을 위해 update
//         모드에서는 정수 필드 (lev_*_i) 만 반영 — 곡 이름·아티스트 등
//         메타데이터를 실수로 덮어쓸 수 없다.
//       신곡 add   — id/title/artist 어느 조합으로도 매칭이 안 되면
//         자동으로 새 곡 entry 를 append. 이때는 override entry 의 모든
//         필드를 그대로 넣는다 (title / lev_bas / lev_mas / lev_mas_i /
//         image_url / version 등). upstream 이 나중에 같은 title 로
//         곡을 넣으면 id 매칭이 실패해도 title 매칭이 성공하므로 중복
//         append 되지 않고 update 모드로 전환된다.
//       version split — otoge-db 가 Act 를 세분화하기 전에도
//         date_added 기준으로 "Re:Fresh" → "Re:Fresh Act.2" 처럼 재태깅.
//         악곡 필터·북마크릿 version·신곡 판별이 같은 라벨을 공유한다.
//
// 파일 형식:
//
//	레거시 (배열만):
//	[
//	  { "title": "ココリエール", "lev_mas_i": "13.0" }
//	]
//
//	권장 (object + _meta):
//	{
//	  "_meta": {
//	    "new_song_versions": ["Re:Fresh Act.2"],
//	    "version_splits": [
//	      { "from": "Re:Fresh", "to": "Re:Fresh Act.2", "since": "20260723" }
//	    ]
//	  },
//	  "songs": [ { "title": "...", "lev_mas_i": "14.6", "force": true } ]
//	}
//
// 매칭 우선순위: id > title+artist > title (실패 시 신곡으로 append).
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// musicExOverrideUpdateFields: 기존 곡을 update 할 때 반영 허용 필드.
var musicExOverrideUpdateFields = map[string]struct{}{
	"lev_bas_i": {},
	"lev_adv_i": {},
	"lev_exc_i": {},
	"lev_mas_i": {},
	"lev_lnt_i": {},
}

// Re:Fresh Act.2 시작일 (YYYYMMDD). otoge-db 가 Act 문자열을 쪼개기 전까지
// date_added >= 이 값인 "Re:Fresh" 곡을 "Re:Fresh Act.2" 로 재태깅한다.
// Act 전환 시(~1.5–2년) defaultMusicExOverrideMeta 만 갱신하면 된다.
const defaultAct2SinceDate = "20260723"
const defaultAct2Version = "Re:Fresh Act.2"
const defaultAct2FromVersion = "Re:Fresh"

type musicExVersionSplit struct {
	From  string // 예: "Re:Fresh"
	To    string // 예: "Re:Fresh Act.2"
	Since string // YYYYMMDD inclusive
}

type musicExOverrideMeta struct {
	NewSongVersions []string
	VersionSplits   []musicExVersionSplit
}

type musicExOverrideEntry struct {
	id     string
	title  string
	artist string
	force  bool
	fields map[string]string
}

func defaultMusicExOverrideMeta() musicExOverrideMeta {
	return musicExOverrideMeta{
		NewSongVersions: []string{defaultAct2Version},
		VersionSplits: []musicExVersionSplit{
			{From: defaultAct2FromVersion, To: defaultAct2Version, Since: defaultAct2SinceDate},
		},
	}
}

// loadMusicExOverridesFile: 오버라이드 파일 + meta 를 읽는다.
// 파일이 없어도 default meta 는 반환한다 (version split / 신곡 버전 기본값).
func loadMusicExOverridesFile(path string) ([]musicExOverrideEntry, musicExOverrideMeta, error) {
	meta := defaultMusicExOverrideMeta()
	if strings.TrimSpace(path) == "" {
		return nil, meta, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, meta, nil
		}
		return nil, meta, err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return nil, meta, nil
	}
	return parseMusicExOverridesBundle(b)
}

// parseMusicExOverrides: 레거시 배열 전용 파서 (테스트 호환).
func parseMusicExOverrides(b []byte) ([]musicExOverrideEntry, error) {
	songs, _, err := parseMusicExOverridesBundle(b)
	return songs, err
}

func parseMusicExOverridesBundle(b []byte) ([]musicExOverrideEntry, musicExOverrideMeta, error) {
	meta := defaultMusicExOverrideMeta()
	trimmed := bytes.TrimSpace(b)
	if len(trimmed) == 0 {
		return nil, meta, nil
	}

	if trimmed[0] == '{' {
		var obj struct {
			Meta *struct {
				NewSongVersions []string `json:"new_song_versions"`
				VersionSplits   []struct {
					From  string `json:"from"`
					To    string `json:"to"`
					Since string `json:"since"`
				} `json:"version_splits"`
			} `json:"_meta"`
			Songs []map[string]any `json:"songs"`
		}
		if err := json.Unmarshal(b, &obj); err != nil {
			return nil, meta, fmt.Errorf("parse overrides: %w", err)
		}
		if obj.Meta != nil {
			if obj.Meta.NewSongVersions != nil {
				meta.NewSongVersions = normalizeStringList(obj.Meta.NewSongVersions)
			}
			if obj.Meta.VersionSplits != nil {
				splits := make([]musicExVersionSplit, 0, len(obj.Meta.VersionSplits))
				for _, s := range obj.Meta.VersionSplits {
					from := strings.TrimSpace(s.From)
					to := strings.TrimSpace(s.To)
					since := strings.TrimSpace(s.Since)
					if from == "" || to == "" || since == "" {
						continue
					}
					splits = append(splits, musicExVersionSplit{From: from, To: to, Since: since})
				}
				meta.VersionSplits = splits
			}
		}
		songs, err := parseOverrideEntryMaps(obj.Songs)
		return songs, meta, err
	}

	var raw []map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, meta, fmt.Errorf("parse overrides: %w", err)
	}
	songs, err := parseOverrideEntryMaps(raw)
	return songs, meta, err
}

func normalizeStringList(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]struct{}{}
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

func parseOverrideEntryMaps(raw []map[string]any) ([]musicExOverrideEntry, error) {
	out := make([]musicExOverrideEntry, 0, len(raw))
	for _, e := range raw {
		entry := musicExOverrideEntry{fields: map[string]string{}}
		for k, v := range e {
			switch k {
			case "id":
				entry.id = strings.TrimSpace(musicExOverrideValueString(v))
			case "title":
				entry.title = strings.TrimSpace(musicExOverrideValueString(v))
			case "artist":
				entry.artist = strings.TrimSpace(musicExOverrideValueString(v))
			case "force":
				if bv, ok := v.(bool); ok {
					entry.force = bv
				}
			default:
				s := strings.TrimSpace(musicExOverrideValueString(v))
				if s == "" {
					continue
				}
				entry.fields[k] = s
			}
		}
		if entry.id == "" && entry.title == "" {
			continue
		}
		if len(entry.fields) == 0 {
			continue
		}
		out = append(out, entry)
	}
	return out, nil
}

// applyMusicExOverrides: rawBody 위에 song overrides 를 머지한다.
func applyMusicExOverrides(rawBody []byte, overrides []musicExOverrideEntry) (merged []byte, applied int, err error) {
	if len(overrides) == 0 {
		return rawBody, 0, nil
	}
	var arr []map[string]any
	if err := json.Unmarshal(rawBody, &arr); err != nil {
		return nil, 0, fmt.Errorf("parse music-ex: %w", err)
	}

	byID := map[string][]int{}
	byTitleArtist := map[string][]int{}
	byTitle := map[string][]int{}
	indexRow := func(i int) {
		item := arr[i]
		id := strings.TrimSpace(musicExOverrideValueString(item["id"]))
		title := strings.TrimSpace(musicExOverrideValueString(item["title"]))
		artist := strings.TrimSpace(musicExOverrideValueString(item["artist"]))
		if id != "" {
			byID[id] = append(byID[id], i)
		}
		if title != "" {
			byTitle[title] = append(byTitle[title], i)
			if artist != "" {
				byTitleArtist[title+"\x00"+artist] = append(byTitleArtist[title+"\x00"+artist], i)
			}
		}
	}
	for i := range arr {
		indexRow(i)
	}

	for _, o := range overrides {
		matches := lookupOverrideMatches(o, byID, byTitleArtist, byTitle)

		if len(matches) == 0 {
			if o.title == "" {
				continue
			}
			row := map[string]any{}
			if o.id != "" {
				row["id"] = o.id
			}
			row["title"] = o.title
			if o.artist != "" {
				row["artist"] = o.artist
			}
			for k, v := range o.fields {
				row[k] = v
			}
			arr = append(arr, row)
			indexRow(len(arr) - 1)
			applied++
			continue
		}

		for _, idx := range matches {
			row := arr[idx]
			rowChanged := false
			for k, v := range o.fields {
				if _, ok := musicExOverrideUpdateFields[k]; !ok {
					continue
				}
				existing := strings.TrimSpace(musicExOverrideValueString(row[k]))
				if existing != "" && !o.force {
					continue
				}
				row[k] = v
				rowChanged = true
			}
			if rowChanged {
				applied++
			}
		}
	}
	if applied == 0 {
		return rawBody, 0, nil
	}
	out, err := json.Marshal(arr)
	if err != nil {
		return nil, 0, fmt.Errorf("marshal merged music-ex: %w", err)
	}
	return out, applied, nil
}

// applyVersionSplitsToBody: date_added 기준으로 version 라벨을 재태깅한다.
// 변경이 없으면 rawBody 를 그대로 반환한다.
func applyVersionSplitsToBody(rawBody []byte, splits []musicExVersionSplit) (merged []byte, changed int, err error) {
	if len(splits) == 0 || len(rawBody) == 0 {
		return rawBody, 0, nil
	}
	var arr []map[string]any
	if err := json.Unmarshal(rawBody, &arr); err != nil {
		return nil, 0, fmt.Errorf("parse music-ex for version split: %w", err)
	}
	for _, row := range arr {
		ver := strings.TrimSpace(musicExOverrideValueString(row["version"]))
		date := strings.TrimSpace(musicExOverrideValueString(row["date_added"]))
		if ver == "" || date == "" {
			continue
		}
		for _, sp := range splits {
			if ver == sp.From && date >= sp.Since {
				row["version"] = sp.To
				changed++
				break
			}
		}
	}
	if changed == 0 {
		return rawBody, 0, nil
	}
	out, err := json.Marshal(arr)
	if err != nil {
		return nil, 0, fmt.Errorf("marshal version-split music-ex: %w", err)
	}
	return out, changed, nil
}

func lookupOverrideMatches(o musicExOverrideEntry, byID, byTitleArtist, byTitle map[string][]int) []int {
	if o.id != "" {
		if m := byID[o.id]; len(m) > 0 {
			return m
		}
		if o.title != "" && o.artist != "" {
			if m := byTitleArtist[o.title+"\x00"+o.artist]; len(m) > 0 {
				return m
			}
		}
		if o.title != "" {
			if m := byTitle[o.title]; len(m) > 0 {
				return m
			}
		}
		return nil
	}
	if o.title != "" && o.artist != "" {
		if m := byTitleArtist[o.title+"\x00"+o.artist]; len(m) > 0 {
			return m
		}
	}
	if o.title != "" {
		return byTitle[o.title]
	}
	return nil
}

func musicExOverrideValueString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}
