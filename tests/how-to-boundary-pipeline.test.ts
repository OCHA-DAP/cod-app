import { beforeAll, expect, test } from "vitest";
import { loadFile } from "$lib/db/loader";
import { runCodeCreate } from "$lib/tools/code-create/pipeline";
import { runEdgeMatch } from "$lib/tools/edge-match/pipeline";
import { runPackage } from "$lib/tools/package/pipeline";
import { runPackagePolygons } from "$lib/tools/package-polygons/pipeline";
import { DEFAULT_TARGET_SCHEMA } from "$lib/tools/schema-map/pipeline";
import { applyCrosswalk, inferCrosswalk } from "$lib/tools/schema-map/pipeline/editor";
import { runSchemaFill } from "$lib/tools/schema-fill/pipeline";
import { runFromLoaded } from "$lib/tools/topo-clean/pipeline";
import districtUrl from "./fixtures/how-to/how_to_district_raw.parquet?url";
import neighborhoodUrl from "./fixtures/how-to/how_to_neighborhood_raw.parquet?url";
import { db, exportColumns, ready, rows, scalar, write } from "./helpers";

const SCHEMA = { codeField: "adm{n}_code", nameField: "adm{n}_name" };

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

const fetchFile = async (url: string, name: string) =>
  new File([await (await fetch(url)).blob()], name);
const load = async (file: File, prefix = "") =>
  loadFile(db().db, conn, [file], prefix ? { prefix } : undefined);
const register = async (file: File) =>
  db().db.registerFileBuffer("_export.parquet", new Uint8Array(await file.arrayBuffer()));
// The last export (`_export.parquet`) as a File, optionally filtered, for the next step's loader.
const exported = (name: string, where = "true") =>
  write(`SELECT * FROM '_export.parquet' WHERE ${where}`, name);

// Schema mapping through coding, run once; matching, fill and package branch from it.
let chain: Promise<{ mapped: string[]; issues: { kind: string; fixed: boolean }[]; coded: File }>;
function pipeline() {
  chain ??= (async () => {
    await load(await fetchFile(districtUrl, "district.parquet"));
    const crosswalk = await inferCrosswalk(conn, DEFAULT_TARGET_SCHEMA);
    const decoy = crosswalk.find((r) => r.sourceColumn === "LOCAL_REF");
    expect(decoy?.targetColumn, "fixture no longer reproduces the cardinality decoy").toBe("adm2_code1");
    decoy!.targetColumn = null;
    await applyCrosswalk(conn, crosswalk, DEFAULT_TARGET_SCHEMA);
    const mapped = await exportColumns("schema_refactor");

    await load(await exported("mapped.parquet"));
    await runFromLoaded(conn, { mode: "all", gapWidthM: 0 }, () => {});
    await exportColumns("topology_issues");
    const issues = await rows<{ kind: string; fixed: boolean }>(
      "SELECT kind, fixed FROM '_export.parquet' ORDER BY kind",
    );
    await exportColumns("clean_topology");

    await load(await exported("topo.parquet"));
    await runCodeCreate(conn, "TT", ".", "2", "replace", null);
    await exportColumns("code_create");
    return { mapped, issues, coded: await exported("coded.parquet") };
  })();
  return chain;
}

test("schema map reproduces the cardinality decoy", async () => {
  await load(await fetchFile(districtUrl, "district.parquet"));
  const by = Object.fromEntries(
    (await inferCrosswalk(conn, DEFAULT_TARGET_SCHEMA)).map((r) => [r.sourceColumn, r.targetColumn]),
  );
  expect(by).toMatchObject({
    PCODE_2: "adm2_code",
    LOCAL_REF: "adm2_code1",
    NAME_2: "adm2_name",
    NAME_1: "adm1_name",
    PCODE_1: "adm1_code",
  });
});

test("schema refactor drops the decoy column", async () => {
  const { mapped } = await pipeline();
  expect(new Set(mapped)).toEqual(
    new Set(["geometry", "adm1_name", "adm1_code", "adm2_name", "adm2_code"]),
  );
});

test("topo-clean fixes one gap and one overlap", async () => {
  const { issues } = await pipeline();
  expect(issues.map((i) => i.kind)).toEqual(["gap", "overlap"]);
  expect(issues.every((i) => i.fixed)).toBe(true);
});

test("code-create assigns nested codes", async () => {
  await register((await pipeline()).coded);
  const codes = Object.fromEntries(
    (await rows<{ n: string; c: string }>("SELECT adm2_name AS n, adm2_code AS c FROM '_export.parquet'")).map(
      (r) => [r.n, r.c],
    ),
  );
  expect(codes.Riverside).toBe("TT.02.04");
  expect(codes["North Ridge"]).toBe("TT.01.01");
  expect(
    new Set((await rows<{ c: string }>("SELECT adm1_code AS c FROM '_export.parquet'")).map((r) => r.c)),
  ).toEqual(new Set(["TT.01", "TT.02"]));
});

test("edge-match fills the neighborhood wedge", async () => {
  await register((await pipeline()).coded);
  const parent = await exported("parent.parquet", "adm2_code = 'TT.02.04'");
  const parentArea = await scalar<number>(
    "SELECT ST_Area(geometry) FROM '_export.parquet' WHERE adm2_code = 'TT.02.04'",
  );
  await runEdgeMatch(
    db().db,
    conn,
    [await fetchFile(neighborhoodUrl, "neighborhood.parquet")],
    [parent],
    () => {},
    {},
    false,
    "auto",
  );
  expect(await rows("SELECT kind FROM ge_issues")).toEqual([]);
  await exportColumns("match");
  expect(await scalar<number>("SELECT ST_Area(ST_Union_Agg(geometry)) FROM '_export.parquet'")).toBeCloseTo(
    parentArea,
    6,
  );
});

test("schema fill and package polygons derive the provinces", async () => {
  await load((await pipeline()).coded);
  await runSchemaFill(conn, SCHEMA);
  await exportColumns("schema_fill");
  await load(await exported("filled.parquet"));
  await runPackagePolygons(conn, SCHEMA);
  await exportColumns("package_polygons_level_1");
  expect(
    await rows("SELECT adm1_code, adm1_name FROM '_export.parquet' ORDER BY adm1_code"),
  ).toEqual([
    { adm1_code: "TT.01", adm1_name: "Alpha Province" },
    { adm1_code: "TT.02", adm1_name: "Beta Province" },
  ]);
});

test("package produces the full bundle", async () => {
  await load((await pipeline()).coded);
  await runPackage(conn, SCHEMA);
  await exportColumns("package_polygons_level_1");
  await exportColumns("package_polygons_level_2");
  await exportColumns("package_points");
  expect(
    (await rows<{ adm_lvl: number }>("SELECT adm_lvl FROM '_export.parquet' ORDER BY adm_lvl")).map((r) =>
      Number(r.adm_lvl),
    ),
  ).toEqual([1, 1, 2, 2, 2, 2, 2, 2, 2, 2]);
});
