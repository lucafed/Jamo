export default async function handler(req, res) {
  const { lat, lon, minutes = 60, profile = "driving-car" } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: "Missing lat or lon" });
  }

  const ORS_KEY = process.env.ORS_API_KEY;

  const url = `https://api.openrouteservice.org/v2/isochrones/${profile}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": ORS_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        locations: [[parseFloat(lon), parseFloat(lat)]],
        range: [parseInt(minutes) * 60]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "ORS error",
        details: data
      });
    }

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: "Server error", details: err.message });
  }
}
