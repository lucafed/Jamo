// api/overpass.js - Vercel Serverless
// Ritorna SOLO LUOGHI (città/paesi/borghi + natura rilevante)
// - place=city|town|village
// - natural=peak
// - waterway=waterfall
// - boundary=national_park OR leisure=nature_reserve
//
// IMPORTANT: Overpass a volte è lento. Qui:
// - timeout ragionevole
// - user-agent
// - cache header (CDN)

export default async function handler(req, res) {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const radiusKm = Math.min(1200, Math.max(10, Number(req.query.radiusKm || 150)));

    if (!isFinite(lat) || !isFinite(lon)) {
      res.status(400).send("Missing/invalid lat/lon");
      return;
    }

    const radiusM = Math.round(radiusKm * 1000);

    // Query Overpass: cerchiamo per "around" raggio metri
    // Usiamo out center; per nodes/ways relations prendiamo center.
    // (Per semplicità, privilegiamo nodes: molti place/natural hanno node)
    const query = `
      [out:json][timeout:25];
      (
        node["place"~"^(city|town|village)$"](around:${radiusM},${lat},${lon});
        node["waterway"="waterfall"](around:${radiusM},${lat},${lon});
        node["natural"="peak"](around:${radiusM},${lat},${lon});
        node["boundary"="national_park"](around:${radiusM},${lat},${lon});
        node["leisure"="nature_reserve"](around:${radiusM},${lat},${lon});
      );
      out tags;
    `;

    const overpassUrl = "https://overpass-api.de/api/interpreter";

    const r = await fetch(overpassUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "Accept": "application/json",
        "User-Agent": "Jamo/0.2 (Vercel Serverless) - contact: none",
      },
      body: "data=" + encodeURIComponent(query),
    });

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      res.status(502).send(text || `Overpass error ${r.status}`);
      return;
    }

    const data = await r.json();

    // Cache: 10 min CDN, stale-while-revalidate 1h
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    res.status(200).json(data);
  } catch (e) {
    res.status(500).send(e?.message || "Server error");
  }
}
