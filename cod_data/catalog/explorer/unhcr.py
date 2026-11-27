"""UNHCR admin 1-2 boundaries from its ArcGIS feature services."""

from cod_data.catalog.explorer.arcgis import write_layer

LAYER = "https://gis.unhcr.org/arcgis/rest/services/core_v2/wrl_polbnd_adm{level}_a_unhcr/FeatureServer/0"
WHERE = "gis_status=14"

if __name__ == "__main__":
    for level in (1, 2):
        write_layer(f"unhcr_adm{level}", LAYER.format(level=level), WHERE)
