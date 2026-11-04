import { expect, test } from "vitest";
import { canonicalOrder, siblingName } from "$lib/db/adminColumns";

test("orders deepest level first, names before codes", () => {
  const columns = [
    "extra",
    "adm1_code",
    "adm3_name1",
    "adm2_code",
    "adm1_name",
    "adm3_code",
    "adm2_name1",
    "adm2_name",
    "adm3_name",
  ];
  expect(canonicalOrder(columns, "adm{n}_name", "adm{n}_code")).toEqual({
    ordered: [
      "adm3_name",
      "adm3_name1",
      "adm3_code",
      "adm2_name",
      "adm2_name1",
      "adm2_code",
      "adm1_name",
      "adm1_code",
      "extra",
    ],
    sortColumn: "adm3_code",
  });
});

test("other level columns sit between names and codes", () => {
  const columns = ["adm1_pcode", "adm1_ref_name1", "adm1_name", "adm0_pcode", "lang"];
  expect(canonicalOrder(columns, "adm{n}_name", "adm{n}_pcode")).toEqual({
    ordered: ["adm1_name", "adm1_ref_name1", "adm1_pcode", "adm0_pcode", "lang"],
    sortColumn: "adm1_pcode",
  });
});

test("template with a trailing level number", () => {
  const columns = ["GID_1", "GID_21", "NAME_2_1", "GID_2", "NAME_21", "NAME_2", "NAME_1"];
  expect(canonicalOrder(columns, "NAME_{n}", "GID_{n}")).toEqual({
    ordered: ["NAME_21", "GID_21", "NAME_2", "NAME_2_1", "GID_2", "NAME_1", "GID_1"],
    sortColumn: "GID_21",
  });
});

test.each([
  ["adm2_name", "adm2_name1"],
  ["GID_2", "GID_2_1"],
  ["pcode2", "pcode2_1"],
])("siblingName(%s) separates after a digit", (column, expected) => {
  expect(siblingName(column, 1)).toBe(expected);
});

test("sorts by the deepest level that has a code", () => {
  const { sortColumn } = canonicalOrder(
    ["adm3_name", "adm2_name", "adm2_code"],
    "adm{n}_name",
    "adm{n}_code",
  );
  expect(sortColumn).toBe("adm2_code");
});

test("no matching columns keeps input order", () => {
  const columns = ["b", "a", "c"];
  expect(canonicalOrder(columns, "adm{n}_name", "adm{n}_code")).toEqual({
    ordered: columns,
    sortColumn: null,
  });
});

test("prefix match needs a known level", () => {
  const { ordered } = canonicalOrder(
    ["adm10x", "adm1_name", "adm1_code", "adm1_area"],
    "adm{n}_name",
    "adm{n}_code",
  );
  expect(ordered).toEqual(["adm1_name", "adm1_area", "adm1_code", "adm10x"]);
});

test.todo(
  "output_renames maps templates and siblings (no TS counterpart: py #83 output templates)",
);
test.todo("output_renames rejects collision (no TS counterpart: py #83 output templates)");
