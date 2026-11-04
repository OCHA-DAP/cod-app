import { beforeAll, describe, expect, test } from "vitest";
import {
  assignNewCodes,
  buildCode,
  checkLevelCount,
  detectCodeFormat,
  detectUndelimitedFormat,
  hasDelimiter,
  lastComponent,
  nextAvailableInteger,
  parentPrefix,
  parseCode,
  parseMinWidth,
  resolveCodeFormat,
  rewriteChildCode,
  widthFor,
  type CodeFormat,
} from "$lib/db/code";
import { ready, rows, table } from "./helpers";

const MIN_WIDTH = 3;
const FMT: CodeFormat = { rootCode: "AFG", delimiter: ".", minWidth: MIN_WIDTH };
const UNDELIMITED: CodeFormat = { rootCode: "BH", delimiter: "", minWidth: [2, 2, 4] };

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

async function codesById(): Promise<Map<number, string>> {
  const r = await rows<{ k: number; c: string }>("SELECT id_col AS k, code_col AS c FROM t");
  return new Map(r.map(({ k, c }) => [k, c]));
}

async function codesBySort(): Promise<Map<number, string>> {
  const r = await rows<{ k: number; c: string }>("SELECT sort_col AS k, code_col AS c FROM t");
  return new Map(r.map(({ k, c }) => [k, c]));
}

describe("pure functions", () => {
  test("resolveCodeFormat validates", () => {
    expect(() => resolveCodeFormat("", ".", 3)).toThrow(/non-empty/);
    expect(() => resolveCodeFormat("AFG", "::", 3)).toThrow(/single character/);
    expect(() => resolveCodeFormat("AFG", ".", 0)).toThrow(/positive/);
    expect(resolveCodeFormat("AFG", ".", 3)).toEqual(FMT);
  });

  test("parse/build round trip", () => {
    const code = "AFG.001.002";
    const parts = parseCode(code, FMT);
    expect(parts).toEqual(["AFG", "001", "002"]);
    expect(buildCode(parts, FMT)).toBe(code);
    expect(parentPrefix(code, FMT)).toBe("AFG.001");
    expect(lastComponent(code, FMT)).toBe("002");
  });

  test("parentPrefix throws on root only", () => {
    expect(() => parentPrefix("AFG", FMT)).toThrow(/no parent/);
  });

  test("nextAvailableInteger ignores nested and non-numeric", () => {
    const existing = ["AFG.001", "AFG.002", "AFG.002.001", "AFG.xx", "AFH.999"];
    expect(nextAvailableInteger(existing, "AFG", FMT)).toBe(MIN_WIDTH);
  });

  test("nextAvailableInteger on empty starts at one", () => {
    expect(nextAvailableInteger([], "AFG", FMT)).toBe(1);
  });

  test("rewriteChildCode keeps tail, reattaches prefix", () => {
    expect(rewriteChildCode("AFG.001.002", "AFG.005", FMT)).toBe("AFG.005.002");
  });

  test.each<[string | number, unknown]>([
    [3, 3],
    ["3", 3],
    ["2,2,4", [2, 2, 4]],
    ["AUTO", "auto"],
  ])("parseMinWidth(%j)", (value, expected) => {
    expect(parseMinWidth(value)).toEqual(expected);
  });

  test.each(["0", "2,x", ""])("parseMinWidth rejects %j", (value) => {
    expect(() => parseMinWidth(value)).toThrow(/min width/);
  });

  test("width per level and level-count check", () => {
    const fmt: CodeFormat = { rootCode: "AFG", delimiter: ".", minWidth: [2, 4] };
    expect([widthFor(fmt, 1), widthFor(fmt, 2)]).toEqual([2, 4]);
    expect(widthFor({ rootCode: "AFG", delimiter: ".", minWidth: "auto" }, 1)).toBeNull();
    expect(() => checkLevelCount(fmt, 3)).toThrow(/2 widths/);
  });

  test("parseCode without delimiter splits by width", () => {
    expect(parseCode("BH51030366", UNDELIMITED)).toEqual(["BH", "51", "03", "0366"]);
    expect(parentPrefix("BH51030366", UNDELIMITED)).toBe("BH5103");
    expect(rewriteChildCode("BH5103", "BH52", UNDELIMITED)).toBe("BH5203");
    expect(() => parseCode("BH510", UNDELIMITED)).toThrow(/split by width/);
  });

  test("nextAvailableInteger without delimiter", () => {
    expect(nextAvailableInteger(["BH5101", "BH5107", "BH5201"], "BH51", UNDELIMITED)).toBe(8);
  });
});

describe("assignNewCodes", () => {
  const cols = ["id_col", "parent_code", "sort_col", "code_col"];
  const types = { code_col: "VARCHAR" };

  test("ranks gappy, non-numeric, duplicated source", async () => {
    await table(
      "t",
      cols,
      [
        [1, "AFG", "zz", null],
        [2, "AFG", "5", null],
        [3, "AFG", "5", null],
        [4, "AFG", "aa", null],
      ],
      types,
    );
    await assignNewCodes(conn, "t", {
      idColumn: "id_col",
      parentColumn: "parent_code",
      sortColumns: ["sort_col"],
      codeColumn: "code_col",
      fmt: FMT,
      level: 1,
    });
    const codes = [...(await codesById()).values()].sort();
    expect(codes).toEqual(["AFG.001", "AFG.002", "AFG.003", "AFG.004"]);
  });

  test("overflow past 999 doesn't re-pad the first 999", async () => {
    const total = 1200;
    await table(
      "t",
      cols,
      Array.from({ length: total }, (_, i) => [i + 1, "BRA", i + 1, null]),
      types,
    );
    await assignNewCodes(conn, "t", {
      idColumn: "id_col",
      parentColumn: "parent_code",
      sortColumns: ["sort_col"],
      codeColumn: "code_col",
      fmt: { rootCode: "BRA", delimiter: ".", minWidth: MIN_WIDTH },
      level: 1,
    });
    const byRank = await codesBySort();
    expect(byRank.get(1)).toBe("BRA.001");
    expect(byRank.get(999)).toBe("BRA.999");
    expect(byRank.get(1000)).toBe("BRA.1000");
    for (let i = 1; i < 1000; i++) expect(byRank.get(i)!.split(".").pop()).toHaveLength(MIN_WIDTH);
  });

  test("continues from existing codes", async () => {
    await table(
      "t",
      cols,
      [
        [1, "AFG", 1, null],
        [2, "AFG", 2, null],
      ],
      types,
    );
    await assignNewCodes(conn, "t", {
      idColumn: "id_col",
      parentColumn: "parent_code",
      sortColumns: ["sort_col"],
      codeColumn: "code_col",
      fmt: FMT,
      level: 1,
      existingCodes: ["AFG.001", "AFG.005"],
    });
    const byRank = await codesBySort();
    expect(byRank.get(1)).toBe("AFG.006");
    expect(byRank.get(2)).toBe("AFG.007");
  });

  test("auto width fits the widest tail and retained codes", async () => {
    await table(
      "t",
      ["id_col", "parent_code", "code_col"],
      [...Array.from({ length: 12 }, (_, i) => [i, "AFG.01", null]), [12, "AFG.02", null]],
      types,
    );
    await assignNewCodes(conn, "t", {
      idColumn: "id_col",
      parentColumn: "parent_code",
      sortColumns: ["id_col"],
      codeColumn: "code_col",
      fmt: { rootCode: "AFG", delimiter: ".", minWidth: "auto" },
      level: 2,
      existingCodes: ["AFG.02.001"],
    });
    const codes = await codesById();
    expect(codes.get(0)).toBe("AFG.01.001");
    expect(codes.get(11)).toBe("AFG.01.012");
    expect(codes.get(12)).toBe("AFG.02.002");
  });

  test("numbers below placeholders without a delimiter", async () => {
    await table(
      "t",
      ["id_col", "parent_code", "code_col"],
      [
        [1, "BH51", null],
        [2, "BH51", null],
      ],
      types,
    );
    await assignNewCodes(conn, "t", {
      idColumn: "id_col",
      parentColumn: "parent_code",
      sortColumns: ["id_col"],
      codeColumn: "code_col",
      fmt: UNDELIMITED,
      level: 1,
      existingCodes: ["BH5101", "BH5102", "BH5104", "BH5193", "BH5198", "BH5199"],
    });
    const codes = await codesById();
    expect([codes.get(1), codes.get(2)]).toEqual(["BH5105", "BH5106"]);
  });
});

describe("format detection", () => {
  async function codes(values: string[]) {
    await table(
      "t",
      ["code"],
      values.map((v) => [v]),
    );
  }

  test("infers delimiter, root and mode width", async () => {
    await codes(["AFG.001", "AFG.002", "AFG.003", "AFG.1000"]);
    const fmt = await detectCodeFormat(conn, "t", "code");
    expect(fmt.rootCode).toBe("AFG");
    expect(fmt.delimiter).toBe(".");
    expect(fmt.minWidth).toBe(MIN_WIDTH);
  });

  test("throws on mixed roots", async () => {
    await codes(["AFG.001", "PAK.001"]);
    await expect(detectCodeFormat(conn, "t", "code")).rejects.toThrow(/constant root/);
  });

  test("throws when no delimiter is present", async () => {
    await codes(["AFG", "AFG"]);
    await expect(detectCodeFormat(conn, "t", "code")).rejects.toThrow(/single recurring delimiter/);
  });

  test("a disputed-territory root is opaque", async () => {
    await codes(["XKO.001", "XKO.002"]);
    expect((await detectCodeFormat(conn, "t", "code")).rootCode).toBe("XKO");
  });

  test("per-level widths", async () => {
    await codes(["AFG.01.001", "AFG.01.002", "AFG.02.001"]);
    expect((await detectCodeFormat(conn, "t", "code")).minWidth).toEqual([2, 3]);
  });

  test("undelimited per-level widths", async () => {
    await table(
      "t",
      ["c1", "c2", "c3"],
      [
        ["BH51", "BH5103", "BH51030366"],
        ["BH52", "BH5201", "BH52010101"],
      ],
    );
    expect(await hasDelimiter(conn, "t", "c3")).toBe(false);
    const fmt = await detectUndelimitedFormat(
      conn,
      "t",
      new Map([
        [1, "c1"],
        [2, "c2"],
        [3, "c3"],
      ]),
    );
    expect(fmt).toEqual(UNDELIMITED);
  });
});
