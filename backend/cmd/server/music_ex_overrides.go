// music-ex.json 미러에 덧씌울 수동 오버라이드 처리.
//
// 운영 배경:
//   - otoge-db 는 신곡 출시 직후 music-ex.json 항목은 빨리 추가하지만
//     보면정수 (lev_*_i) 는 유저 검증을 거쳐 한참 뒤에 채워진다.
//   - 그 공백 기간 동안 우리가 알아낸 정수를 즉시 반영하기 위한 통로.
//   - 기본 정책은 "fill-only": 상류가 비었을 때만 채운다. otoge-db 가 값을
//     채우면 자연스럽게 그쪽이 우선되도록.
//
// 파일 형식 (예):
//
//	[
//	  { "title": "ココリエール", "lev_mas_i": "13.0" },
//	  { "title": "星綴りのアルケミスト", "lev_exc_i": "12.4", "lev_mas_i": "14.6" },
//	  { "id": "1234", "lev_mas_i": "14.7", "force": true }
//	]
//
// 매칭 우선순위: id > title+artist > title.
// 알 수 없는 곡 / 빈 fields entry 는 조용히 스킵한다.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// 오버라이드로 채울 수 있는 필드 화이트리스트. 보면정수만.
// 추후 표시 레벨 등도 받고 싶으면 여기 추가.
var musicExOverrideAllowedFields = map[string]struct{}{
	"lev_bas_i": {},
	"lev_adv_i": {},
	"lev_exc_i": {},
	"lev_mas_i": {},
	"lev_lnt_i": {},
}

type musicExOverrideEntry struct {
	id     string
	title  string
	artist string
	force  bool
	fields map[string]string // 화이트리스트 통과한 필드만, 값은 문자열로 통일
}

// loadMusicExOverridesFile: 디스크에서 오버라이드 파일을 읽어 파싱한다.
// 파일이 없거나 비어있으면 (nil, nil). 깨진 JSON 등 진짜 에러일 때만 err 리턴.
func loadMusicExOverridesFile(path string) ([]musicExOverrideEntry, error) {
	if strings.TrimSpace(path) == "" {
		return nil, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return nil, nil
	}
	return parseMusicExOverrides(b)
}

func parseMusicExOverrides(b []byte) ([]musicExOverrideEntry, error) {
	var raw []map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, fmt.Errorf("parse overrides: %w", err)
	}
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
				if _, ok := musicExOverrideAllowedFields[k]; !ok {
					continue
				}
				s := strings.TrimSpace(musicExOverrideValueString(v))
				if s == "" {
					continue
				}
				entry.fields[k] = s
			}
		}
		// id 도 title 도 없으면 어디 붙일지 알 수 없다.
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

// applyMusicExOverrides: rawBody (music-ex.json 원본 바이트) 위에 overrides 를
// 머지한 결과 바이트를 만든다. 매칭 0 건이거나 적용 0 건이면 rawBody 를 그대로
// 돌려준다 (불필요한 재마샬 회피).
//
// applied 는 실제로 1 개 이상 필드가 갱신된 곡 수.
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
	for i, item := range arr {
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

	for _, o := range overrides {
		var matches []int
		switch {
		case o.id != "":
			matches = byID[o.id]
		case o.title != "" && o.artist != "":
			matches = byTitleArtist[o.title+"\x00"+o.artist]
			// title+artist 매칭 실패시 title 만으로 한 번 더 시도.
			if len(matches) == 0 {
				matches = byTitle[o.title]
			}
		case o.title != "":
			matches = byTitle[o.title]
		}
		if len(matches) == 0 {
			continue
		}
		for _, idx := range matches {
			row := arr[idx]
			rowChanged := false
			for k, v := range o.fields {
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

// musicExOverrideValueString: JSON unmarshal 결과(any) 를 문자열로 정규화한다.
// music-ex.json 은 보면정수를 문자열("13.0") 로 두지만, 사용자가 오버라이드를
// 숫자(13.0) 로 적어도 받아주기 위함.
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
		// 정수 값이면 정수 표기로 (id 같은 케이스).
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}
