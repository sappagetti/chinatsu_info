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
//
// 파일 형식 (예):
//
//	[
//	  // 기존 곡 정수만 채우기 (fill-only)
//	  { "title": "ココリエール", "lev_mas_i": "13.0" },
//	  { "title": "星綴りのアルケミスト", "lev_exc_i": "12.4", "lev_mas_i": "14.6" },
//	  { "id": "1234", "lev_mas_i": "14.7", "force": true },
//
//	  // 신곡 통째로 추가 (매칭 실패시 자동 add)
//	  {
//	    "id": "900001", "title": "熱異常",
//	    "version": "Re:Fresh",
//	    "lev_mas": "14", "lev_mas_i": "14.6",
//	    "lev_exc": "12", "lev_exc_i": "12.0"
//	  }
//	]
//
// 매칭 우선순위: id > title+artist > title (실패 시 신곡으로 append).
// 알 수 없는 곡 (title 없음) 이거나 빈 fields 는 조용히 스킵한다.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// musicExOverrideUpdateFields: 기존 곡을 update 할 때 반영 허용 필드.
// 좁게 (정수만) 유지해 실수로 title/artist/level 을 뒤엎는 사고를 막는다.
// 신곡 add 모드에서는 이 화이트리스트를 무시하고 override 의 모든 필드를 그대로 쓴다.
var musicExOverrideUpdateFields = map[string]struct{}{
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
	// fields: override 에 적힌 모든 (알려진 top-level 4개 제외) 필드.
	// 값은 문자열로 통일. 신곡 add 모드에서 그대로 반영되고, 기존 곡 update
	// 모드에서는 musicExOverrideUpdateFields 화이트리스트로 필터된다.
	fields map[string]string
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
				// 여기서는 화이트리스트로 거르지 않는다. add 모드용으로 모두 담아두고
				// apply 시 매칭 결과에 따라 update 화이트리스트를 적용한다.
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
			// 자동 add: title 이 있어야만 안전하게 신곡 entry 를 만든다.
			// id 만 있고 title 없는 override 는 어디로 붙일지 모호하므로 스킵.
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
			// add 모드에서는 화이트리스트 없이 모두 반영.
			for k, v := range o.fields {
				row[k] = v
			}
			arr = append(arr, row)
			// 다음 override 가 같은 title 로 들어오면 update 로 잡히도록 index 갱신.
			indexRow(len(arr) - 1)
			applied++
			continue
		}

		// 매칭 성공 → 기존 곡 update. 화이트리스트(정수만) 통과 필드만 갱신.
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

// lookupOverrideMatches: 하나의 override entry 에 매칭되는 arr 인덱스 목록을
// id > title+artist > title 순으로 찾는다.
//
// 특히 id 매칭이 실패한 경우, override 에 title 이 함께 있으면 title 매칭도
// 시도한다. 이유:
//   - 신곡 add 로 우리가 임의 id (예: 900001) 를 부여한 override entry 는
//     upstream 이 나중에 실제 id 로 곡을 넣더라도 id 매칭이 계속 실패한다.
//   - 그때 title 로 upstream row 를 잡을 수 있어야 catalog 에 중복 append 되지 않고
//     update 모드로 흡수된다.
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
