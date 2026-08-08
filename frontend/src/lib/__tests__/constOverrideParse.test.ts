import { describe, expect, it } from "vitest";
import { parseConstOverridePaste } from "../constOverrideParse";

describe("parseConstOverridePaste", () => {
  it("parses tab-separated rows and merges difficulties per title", () => {
    const text = `
それはもうらぶちゅ	MASTER	13	13.5
それはもうらぶちゅ	EXPERT	11	11.0
Cthugha	MASTER	14	14.2
Cthugha	EXPERT	12	12.6
`.trim();
    const songs = parseConstOverridePaste(text);
    expect(songs).toHaveLength(2);
    const a = songs.find((s) => s.title === "それはもうらぶちゅ");
    expect(a?.lev_mas_i).toBe("13.5");
    expect(a?.lev_exc_i).toBe("11.0");
    const b = songs.find((s) => s.title === "Cthugha");
    expect(b?.lev_mas_i).toBe("14.2");
    expect(b?.lev_exc_i).toBe("12.6");
  });

  it("skips header-like first line", () => {
    const text = `曲名	難易度	レベル	定数
アルメリアの鳥籠	MASTER	13+	13.7`;
    const songs = parseConstOverridePaste(text);
    expect(songs).toHaveLength(1);
    expect(songs[0]?.lev_mas_i).toBe("13.7");
  });

  it("sets force when requested", () => {
    const songs = parseConstOverridePaste("X\tMASTER\t14\t14.1", true);
    expect(songs[0]?.force).toBe(true);
  });
});
