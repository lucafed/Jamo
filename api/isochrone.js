export default async function handler(req, res) {
  try {
    const key = process.env.ORS_API_KEY;
    if (!key) {
      return res.status(500).json({ error: "ORS_API_KEY missing" });
    }

    const { lat, lon, minutes = 60, profile = "driving-car" } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({ error: "Missing lat/lon" });
    }

    const allowedProfiles = [
      "driving-car",
      "cycling-regular",
      "foot-walking",
    ];

    if (!allowedProfiles.includes(profile)) {
      return res.status(400).json({ error: "Profile not supported" });
    }

    const response = await fetch(
      `https://api.openrouteservice.org/v2/isochrones/${profile}`,
      {
        method: "POST",
        headers: {
          "Authorization": key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          locations: [[Number(lon), Number(lat)]],
          range: [Number(minutes) * 60],
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
