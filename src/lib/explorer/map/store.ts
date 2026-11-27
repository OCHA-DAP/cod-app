import type * as maplibregl from "maplibre-gl";
import { writable } from "svelte/store";

export const mapStore = writable<maplibregl.Map | null>(null);
export const selectedIso3 = writable<string>("");
// Global mode: no location selected and every location drawn. Picking a location leaves it.
export const allLocations = writable<boolean>(false);
selectedIso3.subscribe((iso3) => iso3 && allLocations.set(false));
export const selectedAdmin = writable<number>(1);
export const selectedSource = writable<string>("ocha");
export const labelsEnabled = writable<boolean>(true);
