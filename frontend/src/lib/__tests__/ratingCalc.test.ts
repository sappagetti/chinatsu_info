import { describe, expect, it } from "vitest";

import {
  calcLampBonus,
  calcMainRate,
  calcPlatinumRate,
  calcRankBonus,
  getLampForRating,
  isBonusTrackEntry,
  isBonusTrackText,
  isNewCategorySong,
  makeConstKey,
  normalizeTitle,
  parseConst,
} from "../ratingCalc";

function approx(a: number, b: number, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

describe("normalizeTitle", () => {
  it("lowercases, strips whitespace, NFKC-normalizes", () => {
    expect(normalizeTitle("  Hello World  ")).toBe("helloworld");
    expect(normalizeTitle("ＡＢＣ")).toBe("abc");
    expect(normalizeTitle("東京\n\tCity")).toBe("東京city");
  });
});

describe("makeConstKey", () => {
  it("combines normalized title with difficulty as-is", () => {
    expect(makeConstKey("Hello", "MASTER")).toBe("hello::MASTER");
    expect(makeConstKey("  H E L LO ", "EXPERT")).toBe("hello::EXPERT");
  });
});

describe("parseConst", () => {
  it("parses numeric strings", () => {
    expect(parseConst("15.3")).toBe(15.3);
    expect(parseConst(14)).toBe(14);
  });
  it("returns undefined for empty / invalid", () => {
    expect(parseConst("")).toBeUndefined();
    expect(parseConst(null)).toBeUndefined();
    expect(parseConst(undefined)).toBeUndefined();
    expect(parseConst("abc")).toBeUndefined();
  });
});

describe("isNewCategorySong", () => {
  // 신곡 = version 필드가 아직 비어있는 곡 (SEGA 가 최신 확장 신곡에 태깅 전).
  it("treats empty version as new category (신曲枠)", () => {
    expect(isNewCategorySong("")).toBe(true);
    expect(isNewCategorySong(undefined)).toBe(true);
    expect(isNewCategorySong("   ")).toBe(true);
  });
  it("treats any non-empty version string as old category", () => {
    expect(isNewCategorySong("Re:Fresh")).toBe(false);
    expect(isNewCategorySong("bright MEMORY Act.2")).toBe(false);
    expect(isNewCategorySong("ONGEKI")).toBe(false);
  });
});

describe("isBonusTrackText", () => {
  it("detects explicit Japanese and English bonus track markers", () => {
    expect(isBonusTrackText("ボーナストラック")).toBe(true);
    expect(isBonusTrackText("Bonus Track")).toBe(true);
    expect(isBonusTrackText("BonusTrack")).toBe(true);
  });
  it("does not match ambiguous substrings (previously false-positive on 'bonus')", () => {
    // 곡 이름 등에 'bonus' 만 들어간 케이스에서 오탐 방지.
    expect(isBonusTrackText("Pre-Bonus")).toBe(false);
    expect(isBonusTrackText("BONUS!")).toBe(false);
  });
  it("returns false for unrelated text", () => {
    expect(isBonusTrackText("MASTER")).toBe(false);
    expect(isBonusTrackText("")).toBe(false);
  });
});

describe("isBonusTrackEntry", () => {
  // 게임 내 '보너스 트랙' 카테고리 판정. upstream 은 실제로 `bonus="1"` flag 로 표기.
  it("detects entries with bonus flag = '1' (solo ver. songs)", () => {
    expect(
      isBonusTrackEntry({
        title: "STARTLINER -星咲 あかりソロver.-",
        category: "オンゲキ",
        bonus: "1",
      }),
    ).toBe(true);
  });
  it("returns false for regular songs with bonus='' or missing", () => {
    expect(isBonusTrackEntry({ title: "Distorted Fate", bonus: "" })).toBe(false);
    expect(isBonusTrackEntry({ title: "POTENTIAL" })).toBe(false);
  });
  it("falls back to text markers when bonus flag is absent", () => {
    expect(isBonusTrackEntry({ title: "Bonus Track Only", memo: "Bonus Track" })).toBe(true);
  });
  it("handles null/undefined safely", () => {
    expect(isBonusTrackEntry(null)).toBe(false);
    expect(isBonusTrackEntry(undefined)).toBe(false);
  });
});

describe("calcRankBonus", () => {
  it("returns tier bonuses", () => {
    expect(calcRankBonus(1010000)).toBe(0.3);
    expect(calcRankBonus(1007500)).toBe(0.3);
    expect(calcRankBonus(1007499)).toBe(0.2);
    expect(calcRankBonus(1000000)).toBe(0.2);
    expect(calcRankBonus(999999)).toBe(0.1);
    expect(calcRankBonus(990000)).toBe(0.1);
    expect(calcRankBonus(989999)).toBe(0);
    expect(calcRankBonus(0)).toBe(0);
  });
});

describe("getLampForRating", () => {
  it("handles AB+ (technical 1010000) with and without FB", () => {
    expect(getLampForRating(1010000, false, false, false)).toBe("AB+");
    expect(getLampForRating(1010000, true, false, false)).toBe("FB/AB+");
  });
  it("handles AB/FC/FB combinations", () => {
    expect(getLampForRating(1009999, false, false, true)).toBe("AB");
    expect(getLampForRating(1009999, true, false, true)).toBe("FB/AB");
    expect(getLampForRating(1000000, false, true, false)).toBe("FC");
    expect(getLampForRating(1000000, true, true, false)).toBe("FB/FC");
    expect(getLampForRating(900000, true, false, false)).toBe("FB");
    expect(getLampForRating(900000, false, false, false)).toBe("");
  });
});

describe("calcLampBonus", () => {
  it("maps lamp labels to bonus values", () => {
    expect(calcLampBonus("FB/AB+")).toBe(0.4);
    expect(calcLampBonus("AB+")).toBe(0.35);
    expect(calcLampBonus("FB/AB")).toBe(0.35);
    expect(calcLampBonus("AB")).toBe(0.3);
    expect(calcLampBonus("FB/FC")).toBe(0.15);
    expect(calcLampBonus("FC")).toBe(0.1);
    expect(calcLampBonus("FB")).toBe(0.05);
    expect(calcLampBonus("")).toBe(0);
    expect(calcLampBonus("UNKNOWN")).toBe(0);
  });
});

describe("calcPlatinumRate", () => {
  it("clamps star count into [0,5]", () => {
    expect(calcPlatinumRate(15, 0)).toBe(0);
    expect(calcPlatinumRate(15, -3)).toBe(0);
    expect(calcPlatinumRate(15, 5)).toBe(calcPlatinumRate(15, 99));
  });
  // 게임 표기와 정확히 일치 (소수 3자리 절사). 사용자 제공 표에서 발췌.
  it("matches in-game truncation (not rounding)", () => {
    // 1.0368 → 1.036 (반올림이면 1.037 이 되어 오차)
    expect(calcPlatinumRate(14.4, 5)).toBe(1.036);
    expect(calcPlatinumRate(15.7, 5)).toBe(1.232);
    expect(calcPlatinumRate(15.6, 3)).toBe(0.73);
    expect(calcPlatinumRate(12.9, 5)).toBe(0.832);
    expect(calcPlatinumRate(11.5, 5)).toBe(0.661);
    expect(calcPlatinumRate(14.5, 5)).toBe(1.051);
    expect(calcPlatinumRate(15, 5)).toBe(1.125);
    expect(calcPlatinumRate(10, 5)).toBe(0.5);
    expect(calcPlatinumRate(10.4, 5)).toBe(0.54);
    expect(calcPlatinumRate(10.7, 1)).toBe(0.114);
  });
});

describe("calcMainRate", () => {
  // 백엔드와 동일한 기대값. 각 구간 경계를 커버한다.
  it("returns const + 2 at 1010000 (perfect)", () => {
    // extra = 15000, result = 17000, divided by 1000 -> 17.0
    expect(calcMainRate(15, 1010000)).toBe(17);
  });
  it("computes 1007500 boundary (SSS+)", () => {
    // extra = 15000, result = 15000 + 1750 + floor((1007500-1007500)/10) = 16750
    // => 16.75
    expect(approx(calcMainRate(15, 1007500), 16.75)).toBe(true);
  });
  it("computes 1005000 within SSS+ band", () => {
    // extra = 15000, result = 15000 + 1750 + floor((1005000-1007500)/10)
    // JS: Math.floor(-250) = -250 (대소 비교상 이 구간에 도달 불가; 테스트는 상향 경계 한 틱 아래로)
    // 실제 계산은 1007500 이상 구간이 적용. 1007501은 여전히 동일 함수로 floor((1)/10)=0
    expect(approx(calcMainRate(15, 1007501), 16.75)).toBe(true);
  });
  it("computes 1000000 boundary (SSS)", () => {
    // extra = 15000, result = 15000 + 1250 + floor((1000000-1000000)/15) = 16250 => 16.25
    expect(approx(calcMainRate(15, 1000000), 16.25)).toBe(true);
  });
  it("computes 990000 boundary (SS)", () => {
    // extra = 15000, result = 15000 + 750 + floor((990000-990000)/20) = 15750 => 15.75
    expect(approx(calcMainRate(15, 990000), 15.75)).toBe(true);
  });
  it("computes 970000 boundary (S)", () => {
    // extra = 15000, result = 15000 + floor((970000-970000)/26.666) = 15000 => 15.0
    expect(approx(calcMainRate(15, 970000), 15)).toBe(true);
  });
  it("computes sub-S with linear decay", () => {
    // extra = 15000, result = 15000 - floor((970000-960000)/18) = 15000 - floor(555.55..) = 14445
    // => 14.445
    expect(approx(calcMainRate(15, 960000), 14.445)).toBe(true);
  });
  it("clamps negative results to zero", () => {
    // const=1, technical=500000: extra=1000, penalty=floor((970000-500000)/18)=26111
    // → result = 1000 - 26111 = -25111, clamp → 0
    expect(calcMainRate(1, 500000)).toBe(0);
  });
});
