export default async function handler(req, res) {
  try {
    const { lat, lon, minutes = 60 } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({ error: "Missing lat or lon" });
    }

    const response = await fetch(
      "https://api.openrouteservice.org/v2/isochrones/driving-car",
      {
        method: "POST",
        headers: {
          "Authorization": process.env.ORS_API_KEY,
          "Content-Type": "application/json",
          "Accept": "application/geo+json"
        },
        body: JSON.stringify({
          locations: [[Number(lon), Number(lat)]],
          range: [Number(minutes) * 60]
        })
      }
    );

    const data = await response.json();
    res.status(200).json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
