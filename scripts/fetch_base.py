"""Fetch Tokyo-wide basemap layers from OpenStreetMap (Overpass)."""
import sys

from overpass import query

# south, west, north, east — Tokyo 23 wards + Tama with a little margin
BBOX = (35.50, 139.24, 35.84, 139.94)
B = "%.4f,%.4f,%.4f,%.4f" % BBOX
HEAD = "[out:json][timeout:600][maxsize:1073741824];"

QUERIES = {
    "rail": f"""{HEAD}
way["railway"~"^(rail|subway|light_rail|monorail|narrow_gauge|tram)$"]["service"!~"."]({B});
out tags geom;""",
    "stations": f"""{HEAD}
(nwr["railway"~"^(station|halt)$"]({B});
 nwr["public_transport"="station"]({B}););
out tags center;""",
    "roads_major": f"""{HEAD}
way["highway"~"^(motorway|trunk|primary|secondary|motorway_link|trunk_link|primary_link)$"]({B});
out tags geom;""",
    "roads_tertiary": f"""{HEAD}
way["highway"~"^(tertiary|secondary_link|tertiary_link)$"]({B});
out tags geom;""",
    "water": f"""{HEAD}
(way["natural"="water"]({B});
 relation["natural"="water"]({B});
 way["waterway"="riverbank"]({B});
 relation["waterway"="riverbank"]({B});
 way["landuse"="reservoir"]({B}););
out geom({B});""",
    "waterways": f"""{HEAD}
way["waterway"~"^(river|canal)$"]({B});
out tags geom;""",
    "coastline": f"""{HEAD}
way["natural"="coastline"](35.30,139.50,35.90,140.20);
out geom;""",
    "green": f"""{HEAD}
(way["leisure"~"^(park|garden)$"]({B});
 relation["leisure"~"^(park|garden)$"]({B});
 way["landuse"~"^(forest|cemetery|grass|recreation_ground)$"]({B});
 relation["landuse"~"^(forest|cemetery)$"]({B});
 way["natural"="wood"]({B});
 relation["natural"="wood"]({B}););
out geom({B});""",
    "admin": f"""{HEAD}
relation["boundary"="administrative"]["admin_level"~"^(4|7)$"]({B});
out geom({B});""",
    "places": f"""{HEAD}
node["place"~"^(city|town|suburb|quarter|neighbourhood)$"]({B});
out;""",
}

# context for the city-wide view (zoom <= 12): neighbouring prefectures, lines only
WIDE = (35.30, 139.00, 36.00, 140.25)
WB = "%.4f,%.4f,%.4f,%.4f" % WIDE
QUERIES.update({
    "wide_rail": f"""{HEAD}
way["railway"~"^(rail|subway|light_rail|monorail)$"]["service"!~"."]({WB});
out tags geom;""",
    "wide_roads": f"""{HEAD}
way["highway"~"^(motorway|trunk)$"]({WB});
out tags geom;""",
    "wide_coast": f"""{HEAD}
way["natural"="coastline"]({WB});
out geom;""",
    "wide_water": f"""{HEAD}
(way["natural"="water"]["water"~"^(lake|reservoir|river)$"]({WB});
 relation["natural"="water"]["water"~"^(lake|reservoir|river)$"]({WB}););
out geom;""",
    "wide_admin": f"""{HEAD}
relation["boundary"="administrative"]["admin_level"="4"]({WB});
out geom({WB});""",
    "wide_places": f"""{HEAD}
node["place"~"^(city|town)$"]({WB});
out;""",
    "wide_stations": f"""{HEAD}
node["railway"="station"]({WB});
out;""",
})

if __name__ == "__main__":
    names = sys.argv[1:] or list(QUERIES)
    for n in names:
        query(QUERIES[n], name=n)
