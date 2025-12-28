// api/geocode.js
export default async function handler(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Missing q" });

    const url =
      "https://nominatim.openstreetmap.org/search?" +
      new URLSearchParams({
        q,
        format: "json",
        limit: "1",
        addressdetails: "0",
      }).toString();

    const r = await fetch(url, {
      headers: {
        // Nominatim richiede un User-Agent valido
        "User-Agent": "Jamo/1.0 (jamo-seven.vercel.app)",
        "Accept-Language": "it",
      },
    });

    if (!r.ok) {
      const txt = await r.text();
      return res.status(502).json({ error: "Geocode upstream error", details: txt });
    }

    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(404).json({ error: "Not found" });
    }

    const item = data[0];
    return res.status(200).json({
      lat: Number(item.lat),
      lon: Number(item.lon),
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
