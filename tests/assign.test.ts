import { beforeAll, expect, test } from "vitest";
import { assignOne } from "$lib/db/assignOne";
import { carryOverlayColumns } from "$lib/db/carryColumns";
import { computeAssignment } from "$lib/tools/edge-match/pipeline/assign";
import { ready, rows, run, scalar } from "./helpers";

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

// Two disjoint overlays, far enough apart that an input spans the empty gap between them.
async function overlays() {
  await run(`CREATE OR REPLACE TABLE overlay_layer_01 AS SELECT * FROM (VALUES
    (1, ST_GeomFromText('POLYGON((0 0, 3 0, 3 3, 0 3, 0 0))')),
    (2, ST_GeomFromText('POLYGON((10 0, 13 0, 13 3, 10 3, 10 0))'))) v(fid, geom)`);
  await run(
    "CREATE OR REPLACE TABLE overlay_layer_attr AS SELECT * FROM (VALUES (1, 'P1'), (2, 'P2')) v(fid, pcode)",
  );
}

// (fid, wkt, ...attrs) rows into input_layer_01 (fid, geom) + input_layer_attr (fid, ...attrs).
async function inputs(attrs: string[], values: (string | number)[][]) {
  const lit = (v: string | number) => (typeof v === "number" ? String(v) : `'${v}'`);
  const body = values.map((r) => `(${r.map(lit).join(", ")})`).join(", ");
  await run(
    `CREATE OR REPLACE TABLE _in AS SELECT * FROM (VALUES ${body}) v(fid, wkt${attrs.map((a) => ", " + a).join("")})`,
  );
  await run(
    "CREATE OR REPLACE TABLE input_layer_01 AS SELECT fid, ST_GeomFromText(wkt) AS geom FROM _in",
  );
  await run("CREATE OR REPLACE TABLE input_layer_attr AS SELECT * EXCLUDE (wkt) FROM _in");
}

const SMALL_IN_P1 = "POLYGON((0.5 0.5, 1 0.5, 1 1, 0.5 1, 0.5 0.5))";

async function assignment() {
  const r = await rows<{ i: number; o: number; m: string | null; s: boolean | null }>(
    "SELECT input_fid AS i, overlay_fid AS o, assignment_method AS m, spatial_agrees AS s FROM ge_assignment ORDER BY 1",
  );
  return Object.fromEntries(r.map(({ i, o, m, s }) => [i, [o, m, s]]));
}

test("assign_many default schema has no code-join outcome", async () => {
  await overlays();
  await inputs(["source_file"], [[1, SMALL_IN_P1, "fileA"]]);
  await computeAssignment(conn, {}, false, "many");
  expect(await assignment()).toEqual({ 1: [1, null, null] });
});

test("assign_many: code wins on disagreement, falls back to spatial when unmatched or unrelated", async () => {
  await overlays();
  await inputs(
    ["pcode", "source_file"],
    [
      [1, SMALL_IN_P1, "P1", "fileA"],
      // mostly overlaps P1 but touches P2 too, and code says P2, so code wins
      [2, "POLYGON((1 0, 10.5 0, 10.5 1, 1 1, 1 0))", "P2", "fileA"],
      // no parent has this code
      [3, "POLYGON((1.5 1.5, 2 1.5, 2 2, 1.5 2, 1.5 1.5))", "ZZZ", "fileA"],
      // code says P2, but this child doesn't overlap P2
      [4, "POLYGON((1.5 0.2, 2 0.2, 2 0.6, 1.5 0.6, 1.5 0.2))", "P2", "fileA"],
    ],
  );
  await computeAssignment(conn, { matchColumn: "pcode" }, false, "many");
  expect(await assignment()).toEqual({
    1: [1, "code", true],
    2: [2, "code", false],
    3: [1, "spatial_fallback", null],
    4: [1, "spatial_fallback", null],
  });
  expect(await scalar<number>("SELECT count(*) FROM ge_unassigned")).toBe(0);
});

test.todo("assign_many carry_columns (TS carries only under assign-one)");
test.todo("input_bbox_extent combines input rows (no TS counterpart)");
test.todo("input_bbox_extent is None when empty (no TS counterpart)");
test.todo("prepare_overlay_tiles input_bbox filters distant parts (no TS counterpart)");

test("assign_one carry columns populate overlay attributes", async () => {
  await overlays();
  await inputs(["source_file"], [[10, SMALL_IN_P1, "fileA"]]);
  const { overlayFid } = await assignOne(conn);
  expect(await rows("SELECT input_fid, overlay_fid FROM cl_assign")).toEqual([
    { input_fid: 10, overlay_fid: 1 },
  ]);
  await carryOverlayColumns(conn, ["pcode"], overlayFid!, ["fid", "source_file"]);
  expect(await rows("SELECT fid, pcode FROM input_layer_attr")).toEqual([{ fid: 10, pcode: "P1" }]);
});

test.todo(
  "carry column reserved by the assign table throws (TS carries onto attributes, not cl_assign)",
);

test("carry column already on the input layer throws", async () => {
  await overlays();
  await inputs(["pcode"], [[1, SMALL_IN_P1, "X"]]);
  const { overlayFid } = await assignOne(conn);
  await expect(carryOverlayColumns(conn, ["pcode"], overlayFid!, ["fid", "pcode"])).rejects.toThrow(
    /already exist on the input layer/,
  );
});

test("assign_one: code join precedence and fallback, per file", async () => {
  await overlays();
  // fileA: both children mostly overlap P1 but code agrees on P2, which both also overlap
  await inputs(
    ["pcode", "source_file"],
    [
      [10, "POLYGON((1 0, 10.5 0, 10.5 1, 1 1, 1 0))", "P2", "fileA"],
      [11, "POLYGON((1 1, 10.5 1, 10.5 2, 1 2, 1 1))", "P2", "fileA"],
    ],
  );
  expect(await assignOne(conn, { matchColumn: "pcode" })).toMatchObject({
    overlayFid: 2,
    assignmentMethod: "code",
    spatialAgrees: false,
  });
  // fileB: no code match at all, falls back to its spatial winner
  await inputs(
    ["pcode", "source_file"],
    [[20, "POLYGON((1.5 0.2, 2 0.2, 2 0.6, 1.5 0.6, 1.5 0.2))", "ZZZZ", "fileB"]],
  );
  expect(await assignOne(conn, { matchColumn: "pcode" })).toMatchObject({
    overlayFid: 1,
    assignmentMethod: "spatial_fallback",
    spatialAgrees: null,
  });
});

test.todo("resolve_column_selection default/include/exclude/collision (no TS counterpart)");
test.todo("fill_unmatched_overlays appends a zero-input overlay (no TS counterpart)");

test.todo(
  "carried column excluded by input_columns doesn't collide (TS has no input-column narrowing; callers pass every column)",
);
