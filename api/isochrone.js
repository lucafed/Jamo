export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const key = process.env.ORS_API_KEY;
    if (!key) {
      res.status(500).json({ error: "ORS_API_KEY missing on server" });
      return;
    }

    const { profile, locations, range } = req.body || {};
    if (!profile || !locations || !range) {
      res.status(400).json({ error: "Missing profile/locations/range" });
      return;
    }

    const url = `https://api.openrouteservice.org/v2/isochrones/${encodeURIComponent(profile)}`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": key,
        "Content-Type": "application/json",
        "Accept": "application/geo+json"
      },
      body: JSON.stringify({
        locations,
        range,
        range_type: "time"
      })
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }

    if (!r.ok) {
      res.status(r.status).json({ error: "ORS error", status: r.status, details: data });
      return;
    }

    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: "Server error", details: String(e?.message || e) });
  }
}
