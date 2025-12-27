export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const ORS_API_KEY = process.env.ORS_API_KEY;
    if (!ORS_API_KEY) {
      return res.status(500).json({ error: "Missing ORS_API_KEY env var" });
    }

    const { lat, lon, profile, minutes } = req.body || {};
    if (
      typeof lat !== "number" ||
      typeof lon !== "number" ||
      !profile ||
      typeof minutes !== "number"
    ) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    // ORS expects seconds for isochrones range
    const rangeSeconds = Math.max(60, Math.round(minutes * 60));

    const url = `https://api.openrouteservice.org/v2/isochrones/${encodeURIComponent(
      profile
    )}`;

    const orsRes = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: ORS_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/geo+json",
      },
      body: JSON.stringify({
        locations: [[lon, lat]],
        range: [rangeSeconds],
        // migliora la qualità della forma
        smoothing: 0.9,
        attributes: ["area"],
      }),
    });

    const text = await orsRes.text();
    if (!orsRes.ok) {
      return res.status(orsRes.status).json({
        error: "ORS error",
        status: orsRes.status,
        details: text,
      });
    }

    // text è GeoJSON
    return res.status(200).send(text);
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
