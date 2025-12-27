export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const key = process.env.ORS_API_KEY;
    if (!key) return res.status(500).json({ error: "Missing ORS_API_KEY env var" });

    const { from, to, profile } = req.body || {};
    if (!from || !to || !Array.isArray(from) || !Array.isArray(to)) {
      return res.status(400).json({ error: "from/to must be [lon,lat]" });
    }

    // profile: driving-car | cycling-regular | foot-walking
    const p = profile || "driving-car";

    const url = `https://api.openrouteservice.org/v2/directions/${encodeURIComponent(p)}/geojson`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": key,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ coordinates: [from, to] })
    });

    const txt = await r.text();
    if (!r.ok) return res.status(502).json({ error: "ORS error", details: txt });

    const data = JSON.parse(txt);

    // Cache breve (routing varia poco)
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=1200");
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
