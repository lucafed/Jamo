export default async function handler(req, res) {
  try {
    const ORS_KEY = process.env.ORS_API_KEY;

    if (!ORS_KEY) {
      return res.status(500).json({ error: "ORS_API_KEY missing" });
    }

    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const minutes = parseInt(req.query.minutes || "60", 10);
    const profile = req.query.profile || "driving-car";

    const allowedProfiles = [
      "driving-car",
      "cycling-regular",
      "foot-walking",
    ];

    if (!lat || !lon) {
      return res.status(400).json({ error: "Missing lat or lon" });
    }

    if (!allowedProfiles.includes(profile)) {
      return res.status(400).json({ error: "Profile not supported" });
    }

    const response = await fetch(
      `https://api.openrouteservice.org/v2/isochrones/${profile}`,
      {
        method: "POST",
        headers: {
          "Authorization": ORS_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          locations: [[lon, lat]],
          range: [minutes * 60],
          range_type: "time",
        }),
      }
    );

    const text = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "ORS error",
        status: response.status,
        details: text,
      });
    }

    return res.status(200).json(JSON.parse(text));
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    });
  }
}
