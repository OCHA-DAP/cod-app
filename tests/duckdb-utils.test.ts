import { beforeAll, expect, test } from "vitest";
import { ready, run, scalar } from "./helpers";

beforeAll(async () => {
  await ready();
}, 60_000);

test("where on CRS geometry keeps every row", async () => {
  await run(`
    CREATE OR REPLACE TABLE crs_rows AS
    SELECT ST_SetCRS(ST_MakeLine(list_transform(
      range(2 + i % 7), lambda k: ST_Point(i + k, k)
    )), 'OGC:CRS84') AS geom
    FROM range(100000) r(i)
  `);
  await run("CHECKPOINT");
  expect(await scalar("SELECT count(*) FROM crs_rows WHERE ST_NPoints(geom) >= 6")).toBe(42856);
  await run("DROP TABLE crs_rows");
}, 120_000);
