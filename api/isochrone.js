export default async function handler(req, res) {
  try {
    const key = process.env.ORS_API_KEY;
    if (!key) return res.status(500).json({ error: "Missing ORS_API_KEY on server" });

    const { lat, lon, profile = "driving-car", minutes = 60 } = req.query;

    if (!lat || !lon) return res.status(400).json({ error: "Missing lat/lon" });

    const url = `https://api.openrouteservice.org/v2/isochrones/${encodeURIComponent(profile)}`;

    const body = {
      locations: [[Number(lon), Number(lat)]],
      range: [Number(minutes) * 60], // secondi
      range_type: "time",
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await r.text();
    if (!r.ok) {
      return res.status(r.status).json({ error: "ORS error", status: r.status, details: text });
    }

    return res.status(200).json(JSON.parse(text));
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
