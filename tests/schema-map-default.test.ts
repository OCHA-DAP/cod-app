import { beforeAll, expect, test } from "vitest";
import { applyCrosswalk, inferCrosswalk } from "$lib/tools/schema-map/pipeline/editor";
import { exportColumns, layer, ready, rows } from "./helpers";

const SCHEMA = { nameField: "adm{n}_name", codeField: "adm{n}_pcode" };
// GRID3-style hierarchy (name/code pairs, two levels) plus GIS noise columns.
const STRUCTURAL = `SELECT ST_GeomFromText(printf('POLYGON((%d 0, %d 0, %d 1, %d 1, %d 0))', i, i + 1, i + 1, i, i)) AS geom,
    province, prov_uid, zonesante, zs_uid, OBJECTID, Shape_Length, Shape_Area
  FROM (VALUES
    (0, 'Province One', 'PU1', 'Zone Alpha', 'PU1ZU1', '1', '1.5', '2.5'),
    (1, 'Province One', 'PU1', 'Zone Beta', 'PU1ZU2', '2', '1.5', '2.5'),
    (2, 'Province Two', 'PU2', 'Zone Gamma', 'PU2ZU3', '3', '1.5', '2.5'),
    (3, 'Province Two', 'PU2', 'Zone Delta', 'PU2ZU4', '4', '1.5', '2.5')
  ) AS v(i, province, prov_uid, zonesante, zs_uid, OBJECTID, Shape_Length, Shape_Area)`;

let conn: Awaited<ReturnType<typeof ready>>;
beforeAll(async () => {
  conn = await ready();
}, 60_000);

test("end to end: crosswalk and mapped output", async () => {
  await layer(STRUCTURAL);
  const crosswalk = await inferCrosswalk(conn, SCHEMA);
  const by = Object.fromEntries(crosswalk.map((r) => [r.sourceColumn, r]));
  expect(by.province).toMatchObject({ targetColumn: "adm1_name", note: "" });
  expect(by.prov_uid).toMatchObject({ targetColumn: "adm1_pcode", note: "" });
  expect(by.zonesante.targetColumn).toBe("adm2_name");
  expect(by.zs_uid.targetColumn).toBe("adm2_pcode");
  const exported = (
    await rows<{ source_column: string }>("SELECT source_column FROM sm_crosswalk")
  ).map((r) => r.source_column);
  expect(exported).not.toContain("OBJECTID");
  expect(exported).not.toContain("Shape_Length");

  await applyCrosswalk(conn, crosswalk, SCHEMA);
  expect(new Set(await exportColumns("schema_refactor"))).toEqual(
    new Set(["adm1_name", "adm1_pcode", "adm2_name", "adm2_pcode", "geometry"]),
  );
  expect(await rows("SELECT adm2_name FROM sr_result_attr ORDER BY adm2_pcode")).toEqual(
    ["Zone Alpha", "Zone Beta", "Zone Gamma", "Zone Delta"].map((adm2_name) => ({ adm2_name })),
  );
});

test.todo("default output paths (file output, no TS counterpart)");
test.todo("overwrite is required for both outputs (file output, no TS counterpart)");
test.todo("each step runs standalone (no TS counterpart)");
test.todo("map-only writes only a BOM-prefixed crosswalk (file output, no TS counterpart)");
test.todo("CSV input writes only the mapped layer (file output, no TS counterpart)");
test.todo("invalid mode argument combinations raise (CLI modes, no TS counterpart)");
