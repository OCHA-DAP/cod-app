"""WHO GIS Centre for Health admin 1-2 boundaries from its ArcGIS map service, as served."""

from cod_data.catalog.explorer.arcgis import write_layer

SERVICE = (
    "https://extranet.who.int/map/rest/services/GISC/WHO_ADMIN_BOUNDARIES/MapServer"
)

if __name__ == "__main__":
    for level in (1, 2):
        write_layer(f"who_adm{level}", f"{SERVICE}/{level}")
