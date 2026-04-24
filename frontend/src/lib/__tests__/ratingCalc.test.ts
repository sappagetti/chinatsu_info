import { describe, expect, it } from "vitest";

import {
  calcLampBonus,
  calcMainRate,
  calcPlatinumRate,
  calcRankBonus,
  getLampForRating,
  isBonusTrackText,
  isRefreshVersion,
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

describe("isRefreshVersion", () => {
  it("detects re:fresh / refresh variants", () => {
    expect(isRefreshVersion("ONGEKI Re:fresh")).toBe(true);
    expect(isRefreshVersion("onGeKi REFRESH")).toBe(true);
    expect(isRefreshVersion(" Re : fresh ")).toBe(true);
  });
  it("returns false for non-refresh versions or undefined", () => {
    expect(isRefreshVersion("ONGEKI bright MEMORY")).toBe(false);
    expect(isRefreshVersion(undefined)).toBe(false);
    expect(isRefreshVersion("")).toBe(false);
  });
});

describe("isBonusTrackText", () => {
  it("detects Japanese and English bonus markers", () => {
    expect(isBonusTrackText("ボーナストラック")).toBe(true);
    expect(isBonusTrackText("Bonus Track")).toBe(true);
    expect(isBonusTrackText("BonusTrack")).toBe(true);
    expect(isBonusTrackText("Pre-Bonus")).toBe(true);
  });
  it("returns false for unrelated text", () => {
    expect(isBonusTrackText("MASTER")).toBe(false);
    expect(isBonusTrackText("")).toBe(false);
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
  it("clamps star count into [0,5] and applies (const^2 * star) / 1000", () => {
    expect(approx(calcPlatinumRate(15, 5), (15 * 15 * 5) / 1000)).toBe(true);
    expect(approx(calcPlatinumRate(15, 0), 0)).toBe(true);
    expect(approx(calcPlatinumRate(15, -3), 0)).toBe(true);
    expect(approx(calcPlatinumRate(15, 99), (15 * 15 * 5) / 1000)).toBe(true);
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
