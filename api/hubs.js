const OVERPASS = "https://overpass-api.de/api/interpreter";

export default async function handler(req, res) {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const radiusKm = Math.min(200, Math.max(2, Number(req.query.radiusKm || 40)));
    const radiusM = Math.round(radiusKm * 1000);

    if (!isFinite(lat) || !isFinite(lon)) {
      return res.status(400).json({ error: "Invalid lat/lon" });
    }

    // Stazioni + aeroporti (query piccola)
    const query = `
[out:json][timeout:20];
(
  node(around:${radiusM},${lat},${lon})["railway"="station"];
  node(around:${radiusM},${lat},${lon})["public_transport"="station"];
  node(around:${radiusM},${lat},${lon})["aeroway"="aerodrome"];
  node(around:${radiusM},${lat},${lon})["aeroway"="airport"];
);
out tags;
`;

    const r = await fetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: "data=" + encodeURIComponent(query)
    });

    const txt = await r.text();
    if (!r.ok) return res.status(502).json({ error: "Overpass error", details: txt });

    const data = JSON.parse(txt);

    // Cache lunga: hub non cambiano spesso
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
