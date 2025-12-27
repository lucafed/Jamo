export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { geojson } = req.body || {};
    if (!geojson || !geojson.features || !geojson.features[0]) {
      return res.status(400).json({ error: "Missing geojson" });
    }

    // Prendiamo la prima isochrone feature
    const feature = geojson.features[0];
    const geom = feature.geometry;

    // Convertiamo il poligono GeoJSON in formato Overpass "poly"
    // Overpass vuole: "lat lon lat lon ..."
    function toOverpassPoly(geom) {
      // geom.type: Polygon o MultiPolygon
      let coords;
      if (geom.type === "Polygon") {
        coords = geom.coordinates[0]; // outer ring
      } else if (geom.type === "MultiPolygon") {
        coords = geom.coordinates[0][0]; // prima outer ring
      } else {
        throw new Error("Unsupported geometry type: " + geom.type);
      }

      // coords: [ [lon,lat], ... ]
      // Overpass wants: "lat lon lat lon ..."
      return coords.map(([lon, lat]) => `${lat} ${lon}`).join(" ");
    }

    const poly = toOverpassPoly(geom);

    // Cerchiamo LUOGHI (non attrazioni): city/town/village/hamlet
    const query = `
[out:json][timeout:25];
(
  node["place"~"city|town|village|hamlet"](poly:"${poly}");
  way["place"~"city|town|village|hamlet"](poly:"${poly}");
  relation["place"~"city|town|village|hamlet"](poly:"${poly}");
);
out center tags;
`;

    const overpassUrl = "https://overpass-api.de/api/interpreter";
    const overRes = await fetch(overpassUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: "data=" + encodeURIComponent(query),
    });

    const data = await overRes.json();

    // Normalizziamo risultati: nome + coordinate + tipo place
    const places = (data.elements || [])
      .map((el) => {
        const name = el.tags?.name || el.tags?.["name:it"] || null;
        const placeType = el.tags?.place || null;

        // coordinate: node => lat/lon, way/relation => center
        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;

        if (!name || typeof lat !== "number" || typeof lon !== "number") return null;

        return {
          name,
          placeType,
          lat,
          lon,
          // extra utili dopo (provincia/regione se disponibili)
          admin: el.tags?.["addr:province"] || el.tags?.["is_in:province"] || null,
          region: el.tags?.["addr:region"] || el.tags?.["is_in:region"] || null,
        };
      })
      .filter(Boolean);

    // Dedup per nome+coord (Overpass può ripetere)
    const seen = new Set();
    const unique = [];
    for (const p of places) {
      const key = `${p.name}|${p.lat.toFixed(5)}|${p.lon.toFixed(5)}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(p);
      }
    }

    return res.status(200).json({ count: unique.length, places: unique });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
