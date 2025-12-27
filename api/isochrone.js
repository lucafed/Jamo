module.exports = async (req, res) => {
  const { lat, lon, minutes = "60", profile = "driving-car" } = req.query;

  if (!lat || !lon) return res.status(400).json({ error: "Missing lat or lon" });

  const ORS_KEY = process.env.ORS_API_KEY;
  if (!ORS_KEY) return res.status(500).json({ error: "Missing ORS_API_KEY in Vercel env vars" });

  const url = `https://api.openrouteservice.org/v2/isochrones/${profile}`;

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": ORS_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        locations: [[Number(lon), Number(lat)]],
        range: [Number(minutes) * 60]
      })
    });

    const text = await r.text(); // così vediamo SEMPRE cosa torna
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!r.ok) {
      return res.status(r.status).json({
        error: "ORS error",
        status: r.status,
        details: data
      });
    }

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: e.message });
  }
};
