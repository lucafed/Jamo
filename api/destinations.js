const OVERPASS = "https://overpass-api.de/api/interpreter";

export default async function handler(req, res) {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const radiusKm = Math.min(1200, Math.max(5, Number(req.query.radiusKm || 150)));
    const radiusM = Math.round(radiusKm * 1000);

    if (!isFinite(lat) || !isFinite(lon)) {
      return res.status(400).json({ error: "Invalid lat/lon" });
    }

    // SOLO "luoghi": città/borghi + natura rilevante
    // Limite risultati per velocità (qt + limit implicito in out)
    const query = `
[out:json][timeout:25];
(
  node(around:${radiusM},${lat},${lon})["place"~"^(city|town|village)$"];
  node(around:${radiusM},${lat},${lon})["waterway"="waterfall"];
  node(around:${radiusM},${lat},${lon})["natural"="peak"];
  node(around:${radiusM},${lat},${lon})["boundary"="national_park"];
  node(around:${radiusM},${lat},${lon})["leisure"="nature_reserve"];
);
out tags qt 250;
`;

    const r = await fetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: "data=" + encodeURIComponent(query)
    });

    const txt = await r.text();
    if (!r.ok) return res.status(502).json({ error: "Overpass error", details: txt });

    const data = JSON.parse(txt);

    // Cache 10 min (abbastanza, ma reattivo)
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
