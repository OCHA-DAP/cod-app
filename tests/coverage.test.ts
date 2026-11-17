import { beforeAll, describe, expect, test } from "vitest";
import { SNAP_TOLERANCE } from "$lib/db/constants";
import {
  buildGapTable,
  checkNoOverlaps,
  hasMicroPolygons,
  mergeDetachedParts,
  mergeMicroPolygons,
  mergeSliverGaps,
} from "$lib/db/coverage";
import { buildCoverageClean, coverageCleanRows, hasAnyHole } from "$lib/db/coverageClean";
import { withDb } from "$lib/db/duckdb.svelte";
import { hasInvalidEdges, invalidEdgeIssues } from "$lib/db/invalidEdges";
import { hasNoiseFloorGap } from "$lib/db/coverage";
import { closeNotches, detectNotches } from "$lib/db/notches";
import { ready, rows, run, scalar, table } from "./helpers";

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

const geomTable = (name: string, rs: [number, string][]) => table(name, ["fid", "geom"], rs);

async function partsByFid(t: string): Promise<Record<number, number>> {
  const r = await rows<{ fid: number; n: number }>(
    `SELECT fid, ST_NumGeometries(geom) AS n FROM ${t} ORDER BY fid`,
  );
  return Object.fromEntries(r.map(({ fid, n }) => [fid, n]));
}

async function issueRows(t: string) {
  const r = await rows<{ a: number | null; b: number | null; reason: string; fixed: boolean }>(
    `SELECT unit_a AS a, unit_b AS b, reason, fixed FROM ${t} ORDER BY key`,
  );
  return r.map(({ a, b, reason, fixed }) => [a, b, reason, fixed]);
}

describe("gaps", () => {
  async function holed(width: number) {
    const lo = 1.5 - width / 2;
    const hi = 1.5 + width / 2;
    await geomTable("synth", [
      [
        1,
        `POLYGON((0 0, 3 0, 3 3, 0 3, 0 0), (${lo} ${lo}, ${hi} ${lo}, ${hi} ${hi}, ${lo} ${hi}, ${lo} ${lo}))`,
      ],
    ]);
  }

  test("has_gaps tolerates a wide hole when scoped", async () => {
    await holed(2.0);
    expect(await hasAnyHole(conn, "synth")).toBe(true);
    expect(await hasNoiseFloorGap(conn, "synth", SNAP_TOLERANCE)).toBe(false);
  });

  test.todo("check_valid_topology raises on a micro gap even when scoped (no TS counterpart)");
  test.todo("check_valid_topology tolerates a wide gap when scoped (no TS counterpart)");
  test.todo("count_gaps respects min_width (no TS counterpart)");
});

const SLIVER = SNAP_TOLERANCE / 10;
const SQUARE_A = "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))";
const SQUARE_B = "POLYGON((1 0, 2 0, 2 1, 1 1, 1 0))";
const strip = (x0: number, width: number, height = 0.5) => {
  const x1 = x0 + width;
  return `((${x0} 0, ${x1} 0, ${x1} ${height}, ${x0} ${height}, ${x0} 0))`;
};

describe("micro-polygons", () => {
  async function merge(rs: [number, string][]) {
    await geomTable("synth", rs);
    const count = await mergeMicroPolygons(conn, "synth", "out", "issues");
    expect(await hasMicroPolygons(conn, "out")).toBe(false);
    return { count, out: await partsByFid("out"), issues: await issueRows("issues") };
  }

  test("a micro part is detected", async () => {
    await geomTable("synth", [
      [1, `MULTIPOLYGON(((0 0, 1 0, 1 1, 0 1, 0 0)), ${strip(5, SLIVER)})`],
    ]);
    expect(await hasMicroPolygons(conn, "synth")).toBe(true);
  });
  test.todo("micro-polygon raises in check_valid_topology (no TS counterpart)");

  test("overlap sliver merges into the feature it overlaps", async () => {
    const r = await merge([
      [1, `MULTIPOLYGON(((0 0, 1 0, 1 1, 0 1, 0 0)), ${strip(1, SLIVER)})`],
      [2, SQUARE_B],
    ]);
    expect(r).toEqual({
      count: 1,
      out: { 1: 1, 2: 1 },
      issues: [[1, 2, "merged into neighbouring polygon", true]],
    });
  });

  test("touching fragment merges into its own large part", async () => {
    const r = await merge([[1, `MULTIPOLYGON(((0 0, 1 0, 1 1, 0 1, 0 0)), ${strip(1, SLIVER)})`]]);
    expect(r).toEqual({
      count: 1,
      out: { 1: 1 },
      issues: [[1, 1, "merged into neighbouring polygon", true]],
    });
  });

  test("isolated fragment is dropped and large part kept", async () => {
    const r = await merge([
      [1, `MULTIPOLYGON(((0 0, 1 0, 1 1, 0 1, 0 0)), ${strip(5, SLIVER)})`],
      [2, SQUARE_B],
    ]);
    expect(r).toEqual({
      count: 1,
      out: { 1: 1, 2: 1 },
      issues: [[1, null, "dropped: touches no polygon", true]],
    });
  });

  test("whole micro feature row is removed", async () => {
    const r = await merge([
      [1, SQUARE_A],
      [2, SQUARE_B],
      [3, "POLYGON" + strip(2, SLIVER)],
    ]);
    expect(r).toEqual({
      count: 1,
      out: { 1: 1, 2: 1 },
      issues: [[3, 2, "merged into neighbouring polygon", true]],
    });
  });

  test("micro-polygon keys ignore input row order", async () => {
    const a: [number, string] = [
      1,
      `MULTIPOLYGON(((0 0, 1 0, 1 1, 0 1, 0 0)), ${strip(5, SLIVER)})`,
    ];
    const b: [number, string] = [
      2,
      `MULTIPOLYGON(((2 0, 3 0, 3 1, 2 1, 2 0)), ${strip(7, SLIVER)})`,
    ];
    for (const rs of [
      [a, b],
      [b, a],
    ]) {
      await geomTable("synth", rs);
      await mergeMicroPolygons(conn, "synth", "out", "issues");
      expect(await rows("SELECT key, unit_a FROM issues ORDER BY key")).toEqual([
        { key: "micro-polygon-1", unit_a: 1 },
        { key: "micro-polygon-2", unit_a: 2 },
      ]);
    }
  });

  test("small real island is kept", async () => {
    const island = strip(5, SNAP_TOLERANCE * 10, SNAP_TOLERANCE * 10);
    const r = await merge([[1, `MULTIPOLYGON(((0 0, 1 0, 1 1, 0 1, 0 0)), ${island})`]]);
    expect(r).toEqual({ count: 0, out: { 1: 2 }, issues: [] });
  });
});

describe("coverage clean", () => {
  test("removes a whole micro feature instead of emptying it", async () => {
    await geomTable("synth", [
      [1, SQUARE_A],
      [2, SQUARE_B],
      [3, "POLYGON" + strip(2, SLIVER, 1)],
    ]);
    await buildCoverageClean(conn, "synth", "out", { microIssuesTable: "micro" });
    expect(await rows("SELECT fid, ST_IsEmpty(geom) AS e FROM out ORDER BY fid")).toEqual([
      { fid: 1, e: false },
      { fid: 2, e: false },
    ]);
    expect(await rows("SELECT unit_a, unit_b FROM micro")).toEqual([{ unit_a: 3, unit_b: 2 }]);
  });

  // drift: py #220
  test.fails("merges a part its snap narrows to micro width", async () => {
    await geomTable("synth", [
      [
        1,
        "POLYGON ((-127.40594181089371 50.01134009011129, -127.405941787 50.011340097, -127.40594179356547 50.011340112175425, -127.4059365680061 50.01135, -127.40593 50.01135, -127.40593 50.011329999999994, -127.40595 50.011329999999994, -127.40595 50.01133265649202, -127.40594181089371 50.01134009011129))",
      ],
      [
        2,
        "POLYGON ((-127.40594181089371 50.01134009011129, -127.4059418 50.0113401, -127.40594179356547 50.011340112175425, -127.405941787 50.011340097, -127.40594181089371 50.01134009011129))",
      ],
    ]);
    expect(await hasMicroPolygons(conn, "synth")).toBe(false);
    await buildCoverageClean(conn, "synth", "out", { microIssuesTable: "micro" });
    expect(await hasMicroPolygons(conn, "out")).toBe(false);
    expect(await rows("SELECT fid FROM out")).toEqual([{ fid: 1 }]);
    expect(await rows("SELECT key, unit_a, unit_b FROM micro")).toEqual([
      { key: "micro-polygon-1", unit_a: 2, unit_b: 1 },
    ]);
  });

  test.each(["ASC", "DESC"])("ignores input row order (%s)", async (order) => {
    await run(`CREATE OR REPLACE TABLE synth AS SELECT fid, ST_GeomFromText(wkt) AS geom FROM (VALUES
      (1, 'POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))'),
      (2, 'POLYGON((0.9 0, 2 0, 2 1, 0.9 1, 0.9 0))')) v(fid, wkt) ORDER BY fid ${order}`);
    await buildCoverageClean(conn, "synth", "out");
    expect(await rows("SELECT fid, round(ST_Area(geom), 6) AS a FROM out ORDER BY fid")).toEqual([
      { fid: 1, a: 0.9 },
      { fid: 2, a: 1.1 },
    ]);
  });
});

// Detached-part fixtures use 1e-3 deg units (~111 m), so only the ratio rule decides.
const S = 1e-3;
const rect = (x0: number, y0: number, x1: number, y1: number, scale = S) => {
  [x0, y0, x1, y1] = [x0, y0, x1, y1].map((v) => v * scale);
  return `((${x0} ${y0}, ${x1} ${y0}, ${x1} ${y1}, ${x0} ${y1}, ${x0} ${y0}))`;
};
const multi = (...rings: string[]) => `MULTIPOLYGON(${rings.join(", ")})`;
const ring = (pts: [number, number][]) =>
  "POLYGON((" + pts.map(([x, y]) => `${x * S} ${y * S}`).join(", ") + "))";

const MAIN_1 = rect(0, 0, 10, 8);
const PRE_1 = "POLYGON" + rect(0, 0, 10, 10);
const PIECE_1 = rect(0, 9, 0.05, 9.1);
const LEFT_2 = "POLYGON" + rect(-5, 0, 0, 10);

describe("detached parts", () => {
  // TS runs mergeDetachedParts once per overlay feature, as the clip engine does.
  async function detach(
    clipped: [number, string][],
    pre: [number, number, string][],
    original?: [number, string][],
    owners?: Record<number, number | null>,
  ) {
    await geomTable("clipped", clipped);
    await table("pre", ["fid", "overlay_fid", "geom"], pre);
    if (original) await geomTable("original", original);
    if (owners) {
      await run("ALTER TABLE original ADD COLUMN input_fid BIGINT");
      for (const [fid, owner] of Object.entries(owners)) {
        await run(`UPDATE original SET input_fid = ${owner ?? "NULL"} WHERE fid = ${fid}`);
      }
    }
    await run(`CREATE OR REPLACE TABLE overlay AS
      SELECT p.overlay_fid AS fid, ST_Union_Agg(c.geom) AS geom
      FROM clipped c JOIN pre p USING (fid) GROUP BY p.overlay_fid`);
    const overlays = (
      await rows<{ o: number }>("SELECT DISTINCT overlay_fid AS o FROM pre ORDER BY 1")
    ).map((r) => r.o);
    let count = 0;
    await run("CREATE OR REPLACE TABLE out AS SELECT * FROM clipped WHERE FALSE");
    await run("DROP TABLE IF EXISTS issues");
    for (const o of overlays) {
      await run(
        `CREATE OR REPLACE TABLE clipped_o AS SELECT c.* FROM clipped c JOIN pre p USING (fid) WHERE p.overlay_fid = ${o}`,
      );
      count += await mergeDetachedParts(conn, "clipped_o", "out_o", {
        preClipSql: `SELECT fid, geom FROM pre WHERE overlay_fid = ${o}`,
        overlaySql: `SELECT geom FROM overlay WHERE fid = ${o}`,
        overlayFid: o,
        originalTable: original ? "original" : null,
        originalOwner: owners ? "input_fid" : null,
        issuesTable: "issues_o",
      });
      await run("INSERT INTO out SELECT * FROM out_o");
      await run(
        (await scalar<boolean>(
          "SELECT count(*) > 0 FROM duckdb_tables() WHERE table_name = 'issues'",
        ))
          ? "INSERT INTO issues SELECT * FROM issues_o"
          : "CREATE TABLE issues AS SELECT * FROM issues_o",
      );
    }
    return { count, out: await partsByFid("out"), issues: await issueRows("issues") };
  }

  test("detached sliver merges into edge neighbour", async () => {
    const r = await detach(
      [
        [1, multi(MAIN_1, PIECE_1)],
        [2, LEFT_2],
      ],
      [
        [1, 1, PRE_1],
        [2, 1, LEFT_2],
      ],
      [
        [8, PRE_1],
        [9, LEFT_2],
      ],
    );
    expect(r).toEqual({
      count: 1,
      out: { 1: 1, 2: 1 },
      issues: [[1, 2, "merged into neighbouring polygon", true]],
    });
  });

  test("detached sliver without original is only reported", async () => {
    const r = await detach(
      [
        [1, multi(MAIN_1, PIECE_1)],
        [2, LEFT_2],
      ],
      [
        [1, 1, PRE_1],
        [2, 1, LEFT_2],
      ],
    );
    expect(r).toEqual({
      count: 0,
      out: { 1: 2, 2: 1 },
      issues: [[1, 2, "kept: no original layer", false]],
    });
  });

  test("detached piece drawn as an original lobe is kept", async () => {
    const lobe = ring([
      [0, 0],
      [10, 0],
      [10, 8],
      [4e-4, 8],
      [4e-4, 9],
      [0.05, 9],
      [0.05, 9.1],
      [0, 9.1],
      [0, 0],
    ]);
    const r = await detach(
      [
        [1, multi(MAIN_1, PIECE_1)],
        [2, LEFT_2],
      ],
      [
        [1, 1, PRE_1],
        [2, 1, LEFT_2],
      ],
      [
        [1, lobe],
        [2, LEFT_2],
      ],
    );
    expect(r).toEqual({
      count: 0,
      out: { 1: 2, 2: 1 },
      issues: [[1, 2, "kept: matches original shape", false]],
    });
  });

  test.each([
    [1, "kept: matches original shape"],
    [99, "merged into neighbouring polygon"],
    [null, "kept: matches original shape"],
  ])("a detached piece follows only its own original (owner %s)", async (owner, reason) => {
    const lobe = ring([
      [0, 0],
      [10, 0],
      [10, 8],
      [4e-4, 8],
      [4e-4, 9],
      [0.05, 9],
      [0.05, 9.1],
      [0, 9.1],
      [0, 0],
    ]);
    const r = await detach(
      [
        [1, multi(MAIN_1, PIECE_1)],
        [2, LEFT_2],
      ],
      [
        [1, 1, PRE_1],
        [2, 1, LEFT_2],
      ],
      [
        [1, lobe],
        [2, LEFT_2],
      ],
      { 1: owner, 2: 2 },
    );
    expect(r.issues.map((i) => i[2])).toEqual([reason]);
  });

  test("detached piece over ratio is kept and reported", async () => {
    const r = await detach(
      [
        [1, multi(MAIN_1, rect(0, 9, 1, 10))],
        [2, LEFT_2],
      ],
      [
        [1, 1, PRE_1],
        [2, 1, LEFT_2],
      ],
    );
    expect(r).toEqual({
      count: 0,
      out: { 1: 2, 2: 1 },
      issues: [[1, 2, "kept: too large to merge", false]],
    });
    const [{ w, t }] = await rows<{ w: number; t: number }>(
      "SELECT max_width_m AS w, thinness_ratio AS t FROM issues",
    );
    expect(w).toBeGreaterThan(0);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(1);
  });

  test("ratio is per original part, not per feature", async () => {
    const right = "POLYGON" + rect(21, 0, 22, 1);
    const r = await detach(
      [
        [1, multi(MAIN_1, rect(20, 0, 20.6, 1), rect(20.7, 0, 21, 1))],
        [2, right],
      ],
      [
        [1, 1, multi(rect(0, 0, 10, 10), rect(20, 0, 21, 1))],
        [2, 1, right],
      ],
    );
    expect(r).toEqual({
      count: 0,
      out: { 1: 3, 2: 1 },
      issues: [[1, 2, "kept: too large to merge", false]],
    });
  });

  test("isolated detached piece is kept unreported", async () => {
    expect(await detach([[1, multi(MAIN_1, PIECE_1)]], [[1, 1, PRE_1]])).toEqual({
      count: 0,
      out: { 1: 2 },
      issues: [],
    });
  });

  test("point contact is not a destination", async () => {
    const corner = "POLYGON" + rect(-1, 9.1, 0, 10);
    const r = await detach(
      [
        [1, multi(MAIN_1, PIECE_1)],
        [2, corner],
      ],
      [
        [1, 1, PRE_1],
        [2, 1, corner],
      ],
    );
    expect(r).toEqual({ count: 0, out: { 1: 2, 2: 1 }, issues: [] });
  });

  test("neighbour under another overlay is not a destination", async () => {
    const r = await detach(
      [
        [1, multi(MAIN_1, PIECE_1)],
        [2, LEFT_2],
      ],
      [
        [1, 1, PRE_1],
        [2, 2, LEFT_2],
      ],
    );
    expect(r).toEqual({ count: 0, out: { 1: 2, 2: 1 }, issues: [] });
  });

  test("detached pieces swap between two features", async () => {
    const p2: [number, number][] = [
      [10, 0],
      [20, 0],
      [20, 10],
      [10, 10],
      [10, 5.1],
      [5, 5.1],
      [5, 5],
      [10, 5],
    ];
    const n1: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 5],
      [5, 5],
      [5, 5.1],
      [10, 5.1],
      [10, 10],
      [0, 10],
    ];
    const pre2 = ring([...p2, p2[0]]);
    const r = await detach(
      [
        [1, multi(rect(0, 0, 10, 5), rect(9.9, 9, 10, 9.1))],
        [2, multi(rect(10, 0, 20, 10), rect(5, 5, 5.1, 5.1))],
      ],
      [
        [1, 1, PRE_1],
        [2, 1, pre2],
      ],
      [
        [1, ring([...n1, n1[0]])],
        [2, pre2],
      ],
    );
    expect(r.count).toBe(r.issues.length);
    expect(r.out).toEqual({ 1: 1, 2: 1 });
    expect(r.issues.map(([a, b]) => [a, b])).toEqual([
      [1, 2],
      [2, 1],
    ]);
    expect(
      await rows(`SELECT fid, round(ST_Area(geom) / ${S ** 2}, 6) AS a FROM out ORDER BY fid`),
    ).toEqual([
      { fid: 1, a: 50.01 },
      { fid: 2, a: 100.01 },
    ]);
  });

  test("footprint piece is kept over a larger extension piece", async () => {
    const footprint = rect(0, 0, 1, 1);
    const right = "POLYGON" + rect(20, 0, 21, 10);
    const r = await detach(
      [
        [1, multi(footprint, rect(5, 0, 20, 10))],
        [2, right],
      ],
      [
        [1, 1, "POLYGON" + rect(0, 0, 20, 10)],
        [2, 1, right],
      ],
      [
        [1, "POLYGON" + footprint],
        [2, right],
      ],
    );
    expect(r).toEqual({
      count: 0,
      out: { 1: 2, 2: 1 },
      issues: [[1, 2, "kept: too large to merge", false]],
    });
    expect(await scalar<number>("SELECT ST_Area(geom) FROM issues")).toBeCloseTo(150 * S ** 2, 12);
  });

  test("piece mostly on footprint is kept when its point hits a hole", async () => {
    const holed = `POLYGON(${rect(0, 0, 20, 10).slice(1, -1)}, ${rect(12, 4.5, 13, 5.5).slice(1, -1)})`;
    const r = await detach(
      [
        [1, multi(rect(5, 0, 20, 10), rect(0, 0, 1, 1))],
        [2, LEFT_2],
      ],
      [
        [1, 1, "POLYGON" + rect(0, 0, 20, 10)],
        [2, 1, LEFT_2],
      ],
      [
        [1, holed],
        [2, LEFT_2],
      ],
    );
    expect(r).toEqual({
      count: 1,
      out: { 1: 1, 2: 1 },
      issues: [[1, 2, "merged into neighbouring polygon", true]],
    });
  });

  test("only a too-large detached piece is a destination", async () => {
    const r = await detach(
      [
        [1, multi(rect(0, 0, 10, 5), rect(20, 0, 20.1, 0.1))],
        [2, multi(rect(40, 0, 50, 10), rect(20.1, 0, 22, 2))],
      ],
      [
        [1, 1, "POLYGON" + rect(0, 0, 30, 10)],
        [2, 1, "POLYGON" + rect(20, 0, 50, 10)],
      ],
      [
        [1, "POLYGON" + rect(0, 0, 10, 5)],
        [2, "POLYGON" + rect(40, 0, 50, 10)],
      ],
    );
    expect(r).toEqual({
      count: 1,
      out: { 1: 1, 2: 2 },
      issues: [[1, 2, "merged into neighbouring polygon", true]],
    });
  });

  test("unattached merge is cancelled and reported", async () => {
    const gap = -SNAP_TOLERANCE / 2;
    const near = `POLYGON((${-5 * S} 0, ${gap} 0, ${gap} ${10 * S}, ${-5 * S} ${10 * S}, ${-5 * S} 0))`;
    const r = await detach(
      [
        [1, multi(MAIN_1, PIECE_1)],
        [2, near],
      ],
      [
        [1, 1, PRE_1],
        [2, 1, near],
      ],
    );
    expect(r).toEqual({
      count: 0,
      out: { 1: 2, 2: 1 },
      issues: [[1, 2, "kept: merge did not attach", false]],
    });
  });

  test("genuine multipart input is left unchanged", async () => {
    const two = multi(rect(0, 0, 1, 1), rect(5, 0, 6, 1));
    expect(await detach([[1, two]], [[1, 1, two]])).toEqual({
      count: 0,
      out: { 1: 2 },
      issues: [],
    });
  });

  test("source island fused by extension is kept and reported", async () => {
    const island = rect(20.5, 0, 21, 0.5);
    const right = "POLYGON" + rect(21, 0, 22, 1);
    const r = await detach(
      [
        [1, multi(MAIN_1, island)],
        [2, right],
      ],
      [
        [1, 1, "POLYGON" + rect(0, 0, 21, 10)],
        [2, 1, right],
      ],
      [
        [1, multi(MAIN_1, island)],
        [2, right],
      ],
    );
    expect([r.count, r.out]).toEqual([0, { 1: 2, 2: 1 }]);
    expect(r.issues).toEqual([[1, 2, "kept: matches original shape", false]]);
  });

  test("extension-only sliver merges into edge neighbour", async () => {
    const r = await detach(
      [
        [1, multi(MAIN_1, PIECE_1)],
        [2, LEFT_2],
      ],
      [
        [1, 1, PRE_1],
        [2, 1, LEFT_2],
      ],
      [
        [1, "POLYGON" + MAIN_1],
        [2, LEFT_2],
      ],
    );
    expect(r).toEqual({
      count: 1,
      out: { 1: 1, 2: 1 },
      issues: [[1, 2, "merged into neighbouring polygon", true]],
    });
  });

  test("large-area detached piece under ratio merges", async () => {
    const left = "POLYGON" + rect(-5, 0, 0, 10, 1);
    const r = await detach(
      [
        [1, multi(rect(0, 0, 10, 8, 1), rect(0, 9, 0.05, 9.1, 1))],
        [2, left],
      ],
      [
        [1, 1, "POLYGON" + rect(0, 0, 10, 10, 1)],
        [2, 1, left],
      ],
      [
        [1, "POLYGON" + rect(0, 0, 10, 10, 1)],
        [2, left],
      ],
    );
    expect(r).toEqual({
      count: 1,
      out: { 1: 1, 2: 1 },
      issues: [[1, 2, "merged into neighbouring polygon", true]],
    });
  });
});

const M = 1 / 111320; // one metre in degrees, near the equator

describe("notches", () => {
  async function wedge(arm: [number, number][], bLenM = 1000, far = 0.02) {
    const pts = arm.map(([x, y]) => `${x * M} ${y * M}`).join(", ");
    const end = arm[arm.length - 1][0] * M;
    const bEnd = bLenM * M;
    await geomTable("units", [
      [1, `POLYGON((-${far} 0, 0 0, ${pts}, ${end} ${far}, -${far} ${far}, -${far} 0))`],
      [2, `POLYGON((-${far} 0, 0 0, ${bEnd} 0, ${bEnd} -${far}, -${far} -${far}, -${far} 0))`],
    ]);
  }

  test.each([0.1, 5.0])("deep wedge (mouth %s m) is detected and closed", async (mouth) => {
    await wedge([[600, mouth]]);
    expect(await detectNotches(conn, "units", "notches")).toBe(1);
    expect(await rows("SELECT unit_a, unit_b FROM notches")).toEqual([{ unit_a: 1, unit_b: 2 }]);
    expect(await closeNotches(conn, "units")).toBe(1);
    expect(await detectNotches(conn, "units", "after")).toBe(0);
    expect(await hasInvalidEdges(conn, "units")).toBe(false);
  });

  test("vertex near segment midpoint is closed", async () => {
    await wedge([
      [500, 0.085],
      [1000, 0],
    ]);
    expect(await detectNotches(conn, "units", "notches")).toBe(1);
    await closeNotches(conn, "units");
    expect(await detectNotches(conn, "units", "after")).toBe(0);
    expect(await hasInvalidEdges(conn, "units")).toBe(false);
  });

  test("gap enclosed by closing the tip is filled", async () => {
    await wedge([
      [300, 30],
      [600, 0.1],
    ]);
    expect(await hasNoiseFloorGap(conn, "units", 1)).toBe(false);
    expect(await closeNotches(conn, "units")).toBe(1);
    expect(await hasNoiseFloorGap(conn, "units", 1)).toBe(false);
    expect(await hasInvalidEdges(conn, "units")).toBe(false);
  });

  test("closeNotches leaves geometry outside the window unchanged", async () => {
    await wedge([[600, 0.1]]);
    await run("CREATE OR REPLACE TABLE before AS SELECT * FROM units");
    await closeNotches(conn, "units");
    const box = "ST_MakeEnvelope(-0.003, -0.003, 0.009, 0.003)";
    expect(
      await scalar(`SELECT bool_and(ST_Equals(ST_Difference(u.geom, ${box}), ST_Difference(b.geom, ${box})))
        FROM units u JOIN before b USING (fid)`),
    ).toBe(true);
  });

  test("closeNotches keeps a vertex shared with a third unit", async () => {
    const poly = (pts: [number, number][]) =>
      "POLYGON((" + pts.map(([x, y]) => `${x * M} ${y * M}`).join(", ") + "))";
    const c: [number, number][] = [
      [-2000, 0],
      [0, 0],
      [0, 5],
      [-300, 300],
      [-300, 2000],
      [-2000, 2000],
    ];
    await geomTable("units", [
      [
        1,
        poly([
          [-300, 300],
          [0, 5],
          [600, 0.1],
          [600, 2000],
          [-300, 2000],
          [-300, 300],
        ]),
      ],
      [
        2,
        poly([
          [-2000, 0],
          [0, 0],
          [1000, 0],
          [1000, -2000],
          [-2000, -2000],
          [-2000, 0],
        ]),
      ],
      [3, poly([...c, c[0]])],
    ]);
    expect(await closeNotches(conn, "units")).toBe(1);
    expect(await hasAnyHole(conn, "units")).toBe(false);
    const overlap = await scalar<number>(
      "SELECT ST_Area(ST_Intersection(a.geom, c.geom)) FROM units a, units c WHERE a.fid = 1 AND c.fid = 3",
    );
    expect(overlap).toBeCloseTo(0, 12);
  });

  test("closeNotches keeps only polygons", async () => {
    const SPUR_A: [number, number][] = [
      [98.0083609620001, 23.47019279700004],
      [98.00708554200008, 23.47631481100018],
      [98.00494909200751, 23.47960850512211],
      [98.01165975643754, 23.47960850512211],
      [98.01165975643754, 23.466874621385763],
      [98.009052248369, 23.466874621385763],
      [98.0083609620001, 23.47019279700004],
    ];
    const SPUR_B: [number, number][] = [
      [98.00708554200008, 23.47631481100018],
      [98.00836099500003, 23.47019278400012],
      [98.0083609620001, 23.47019279700004],
      [98.00617347200011, 23.47104705700002],
      [98.00424826600016, 23.472747559000027],
      [98.00379184787815, 23.47302665583293],
      [98.00379184787815, 23.47960850512211],
      [98.00494909200751, 23.47960850512211],
      [98.00708554200008, 23.47631481100018],
    ];
    const wkt = (r: [number, number][]) =>
      "POLYGON((" + r.map(([x, y]) => `${x} ${y}`).join(", ") + "))";
    await geomTable("units", [
      [1, wkt(SPUR_A)],
      [2, wkt(SPUR_B)],
    ]);
    expect(await closeNotches(conn, "units")).toBe(1);
    const types = (
      await rows<{ t: string }>("SELECT DISTINCT ST_GeometryType(geom)::VARCHAR AS t FROM units")
    ).map((r) => r.t);
    for (const t of types) expect(["POLYGON", "MULTIPOLYGON"]).toContain(t);
  });

  async function openWedge(rise: number, notches: number) {
    await wedge([[200, rise]], 150);
    expect(await detectNotches(conn, "units", "notches")).toBe(notches);
    await closeNotches(conn, "units");
    expect(await detectNotches(conn, "units", "after")).toBe(0);
  }
  test("open wedge rising 15 m is a notch", () => openWedge(15, 1));
  test("open wedge rising 22 m is past the move limit, not a notch", () => openWedge(22, 0));

  test("wide wedge and T-junction are not notches", async () => {
    await wedge([[600, 100]]);
    expect(await detectNotches(conn, "units", "notches")).toBe(0);
    await geomTable("units", [
      [1, "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))"],
      [2, "POLYGON((1 0, 2 0, 2 1, 1 1, 1 0))"],
      [3, "POLYGON((0 1, 2 1, 2 2, 0 2, 0 1))"],
    ]);
    expect(await detectNotches(conn, "units", "notches")).toBe(0);
    expect(await closeNotches(conn, "units")).toBe(0);
  });
});

describe("overlaps", () => {
  const SQUARE = "POLYGON((0 0, 2 0, 2 2, 0 2, 0 0))";
  const X = 2 - SNAP_TOLERANCE / 2;
  const groups = (rs: [number, string, string][]) => table("synth", ["fid", "grp", "geom"], rs);

  test.each([
    ["partial", "POLYGON((1 0, 3 0, 3 2, 1 2, 1 0))", true],
    ["contained", "POLYGON((0.5 0.5, 1 0.5, 1 1, 0.5 1, 0.5 0.5))", true],
    ["touching", "POLYGON((2 0, 4 0, 4 2, 2 2, 2 0))", false],
    ["sub-tolerance sliver", `POLYGON((${X} 0, 4 0, 4 2, ${X} 2, ${X} 0))`, false],
  ] as const)("checkNoOverlaps: %s", async (_, other, overlaps) => {
    await groups([
      [1, "a", SQUARE],
      [2, "b", other],
    ]);
    if (overlaps) await expect(checkNoOverlaps(conn, "synth")).rejects.toThrow(/1 fid pair/);
    else await checkNoOverlaps(conn, "synth");
    expect(
      await scalar<number>("SELECT count(*) FROM duckdb_tables() WHERE table_name = 'synth_tmp1'"),
    ).toBe(0);
  });

  // GEOS calls these interiors intersecting, yet their intersection has no polygon.
  test("checkNoOverlaps ignores an empty intersection", async () => {
    await groups([
      [1, "a", "POLYGON((1.5741966 9.1399968, 1.5629185 9.1723015, 1.5825720526271088 9.1289799834375, 1.5741966 9.1399968))"],
      [2, "b", "POLYGON((1.598633 9.1078539, 1.5214677 9.1953353, 1.5741966 9.1399968, 1.598633 9.1078539))"],
    ]);
    await checkNoOverlaps(conn, "synth");
  });

  test("checkNoOverlaps ignores overlap within one group", async () => {
    const inner = "POLYGON((1 0, 3 0, 3 2, 1 2, 1 0))";
    await groups([
      [1, "a", SQUARE],
      [2, "a", inner],
    ]);
    await checkNoOverlaps(conn, "synth", { groupColumn: "grp" });
    await groups([
      [1, "a", SQUARE],
      [2, "b", inner],
    ]);
    await expect(checkNoOverlaps(conn, "synth", { groupColumn: "grp" })).rejects.toThrow(/a \/ b/);
  });
});

describe("withDb", () => {
  test("overlapping invalid-edge checks each see their own table", async () => {
    await geomTable("lock_clean", [
      [1, "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))"],
      [2, "POLYGON((1 0, 2 0, 2 1, 1 1, 1 0))"],
    ]);
    await geomTable("lock_bad", [
      [1, "POLYGON((0 0, 2 0, 2 1, 0 1, 0 0))"],
      [2, "POLYGON((1 0, 3 0, 3 1, 1 1, 1 0))"],
    ]);
    const check = (t: string) => withDb((_db, c) => hasInvalidEdges(c, t));
    expect(await Promise.all([check("lock_clean"), check("lock_bad")])).toEqual([false, true]);
  });
});

describe("invalid edges", () => {
  const d = (SNAP_TOLERANCE / 2).toFixed(12);

  test("a sliver between two units is not an invalid edge", async () => {
    await geomTable("units", [
      [1, `POLYGON((0 ${d}, 1 ${d}, 1 1, 0 1, 0 ${d}))`],
      [2, `POLYGON((0 0, 1 0, 1 ${d}, 0 ${d}, 0 0))`],
      [3, "POLYGON((0 -1, 1 -1, 1 0, 0 0, 0 -1))"],
    ]);
    expect(await hasInvalidEdges(conn, "units")).toBe(false);
    expect(await invalidEdgeIssues(conn, "units", "issues")).toBe(0);
  });

  test("an overlap beside a matched unit is an invalid edge", async () => {
    await geomTable("units", [
      [1, "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))"],
      [2, `POLYGON((0 -1, 1 -1, 1 ${d}, 0 ${d}, 0 -1))`],
      [3, "POLYGON((1 0, 2 0, 2 1, 1 1, 1 0))"],
    ]);
    expect(await hasInvalidEdges(conn, "units")).toBe(true);
    expect(await invalidEdgeIssues(conn, "units", "issues")).toBe(2);
    const r = await rows<{ unit_a: number; unit_b: number; len: number }>(
      "SELECT unit_a, unit_b, ST_Length(geom) AS len FROM issues ORDER BY 1, 2",
    );
    expect(r.map((x) => [x.unit_a, x.unit_b])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    // Each row holds only its own pair's edges: 1's edge shared with 3 is left out.
    expect(r[0].len).toBeCloseTo(5, 6);
    expect(r[1].len).toBeCloseTo(3, 6);
  });
});

describe("sliver gaps", () => {
  const LEFT = "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))";
  // The right unit's west edge bends 0.02 east, leaving a needle gap against LEFT.
  const RIGHT_NEEDLE = "POLYGON((1 0, 2 0, 2 1, 1 1, 1 0.8, 1.02 0.5, 1 0.2, 1 0))";

  // A unit with a 0.6 x 0.02 hole, each long side drawn with n points.
  function stripHole(n: number): string {
    const xs = Array.from({ length: n }, (_, i) => 0.2 + (0.6 * i) / (n - 1));
    const ring = [...xs.map((x) => `${x} 0.49`), ...[...xs].reverse().map((x) => `${x} 0.51`)];
    return `POLYGON((0 0, 1 0, 1 1, 0 1, 0 0), (${[...ring, ring[0]].join(", ")}))`;
  }

  test("a needle merges into its longest-border neighbour", async () => {
    await geomTable("synth", [
      [1, LEFT],
      [2, RIGHT_NEEDLE],
    ]);
    expect(await mergeSliverGaps(conn, "synth", "iss")).toBe(1);
    expect(await hasAnyHole(conn, "synth")).toBe(false);
    expect(await scalar<number>("SELECT ST_Area(geom) FROM synth WHERE fid = 2")).toBeCloseTo(1, 9);
    expect(await rows("SELECT key, kind, unit_a, fixed FROM iss")).toEqual([
      { key: "sliver-gap-1", kind: "sliver-gap", unit_a: 2, fixed: true },
    ]);
  });

  test.each([
    [2, 1],
    [121, 0],
  ])("width is compared to vertex spacing (%i points per side)", async (n, merged) => {
    await geomTable("synth", [[1, stripHole(n)]]);
    expect(await mergeSliverGaps(conn, "synth", "iss")).toBe(merged);
    expect(await hasAnyHole(conn, "synth")).toBe(!merged);
  });

  test("an enclave inside a hole is left alone", async () => {
    const island = "POLYGON((0.25 0.495, 0.75 0.495, 0.75 0.505, 0.25 0.505, 0.25 0.495))";
    await geomTable("synth", [
      [1, stripHole(2)],
      [2, island],
    ]);
    expect(await mergeSliverGaps(conn, "synth", "iss")).toBeGreaterThan(0);
    expect(await hasAnyHole(conn, "synth")).toBe(false);
    const r = await rows<{ shared: number; area: number }>(`
      SELECT ST_Area(ST_Intersection(a.geom, b.geom)) AS shared, ST_Area(b.geom) AS area
      FROM synth a, synth b WHERE a.fid = 1 AND b.fid = 2
    `);
    expect(r[0].shared).toBeCloseTo(0, 12);
    expect(r[0].area).toBeCloseTo(0.005, 12);
  });

  test("a hole inside an enclave is counted once", async () => {
    await geomTable("synth", [
      [1, "POLYGON((0 0, 10 0, 10 10, 0 10, 0 0), (2 2, 8 2, 8 8, 2 8, 2 2))"],
      [2, "POLYGON((3 3, 7 3, 7 7, 3 7, 3 3), (4 4, 6 4, 6 6, 4 6, 4 4))"],
    ]);
    await buildGapTable(conn, "gaps", "synth");
    const areas = await rows<{ a: number }>("SELECT ST_Area(geom) AS a FROM gaps ORDER BY 1");
    expect(areas.map(({ a }) => a)).toEqual([4, 20]);
  });

  test("only merged gaps are counted", async () => {
    await geomTable("synth", [
      [1, LEFT],
      [2, stripHole(2)],
    ]);
    await run("UPDATE synth SET geom = ST_Translate(geom, 5, 0) WHERE fid = 2");
    expect(await mergeSliverGaps(conn, "synth", "iss", "fid = 1")).toBe(0);
    expect(await hasAnyHole(conn, "synth")).toBe(true);
  });

  test("a compact hole is kept", async () => {
    await geomTable("synth", [
      [1, "POLYGON((0 0, 3 0, 3 3, 0 3, 0 0), (1.49 1.49, 1.51 1.49, 1.51 1.51, 1.49 1.51, 1.49 1.49))"],
    ]);
    expect(await mergeSliverGaps(conn, "synth", "iss")).toBe(0);
    expect(await scalar("SELECT count(*) FROM iss")).toBe(0);
  });

  test.each([true, false])("coverage clean merges slivers unless disabled (%s)", async (mergeSlivers) => {
    await geomTable("synth", [
      [1, LEFT],
      [2, RIGHT_NEEDLE],
    ]);
    await buildCoverageClean(conn, "synth", "out", { microIssuesTable: "iss", mergeSlivers });
    expect(await hasAnyHole(conn, "out")).toBe(!mergeSlivers);
    expect(await rows("SELECT kind FROM iss")).toEqual(mergeSlivers ? [{ kind: "sliver-gap" }] : []);
  });

  test.each([
    // A held row filling the hole leaves no gap to merge.
    [
      [
        [1, stripHole(2)],
        [2, "POLYGON((0.2 0.49, 0.8 0.49, 0.8 0.51, 0.2 0.51, 0.2 0.49))"],
      ],
      0,
      0.012,
    ],
    // A held row elsewhere still lets the needle merge into a cleaned row.
    [
      [
        [1, LEFT],
        [3, RIGHT_NEEDLE],
        [2, "POLYGON((5 5, 6 5, 6 6, 5 6, 5 5))"],
      ],
      1,
      1,
    ],
  ] as [[number, string][], number, number][])(
    "coverage clean rows counts held rows as filled",
    async (rs, slivers, heldArea) => {
      await geomTable("synth", rs);
      await coverageCleanRows(conn, "synth", "fid != 2", "iss");
      expect(await scalar("SELECT count(*) FROM iss WHERE kind = 'sliver-gap'")).toBe(slivers);
      expect(await scalar<number>("SELECT ST_Area(geom) FROM synth WHERE fid = 2")).toBeCloseTo(heldArea, 9);
    },
  );
});
