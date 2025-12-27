export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const key = process.env.ORS_API_KEY;
    if (!key) return res.status(500).json({ error: "Missing ORS_API_KEY env var" });

    const { profile, minutes, lat, lon, rangeType } = req.body || {};
    if (!profile || typeof minutes !== "number" || typeof lat !== "number" || typeof lon !== "number") {
      return res.status(400).json({ error: "Bad request", details: "profile, minutes, lat, lon required" });
    }

    // ORS profiles validi
    const allowed = new Set(["driving-car", "cycling-regular", "foot-walking"]);
    if (!allowed.has(profile)) {
      return res.status(400).json({ error: "Bad request", details: "Invalid profile" });
    }

    // Molte key ORS limitano range_time a 3600s (60 min)
    const seconds = Math.round(minutes * 60);
    const finalRangeType = rangeType === "distance" ? "distance" : "time";

    if (finalRangeType === "time" && seconds > 3600) {
      return res.status(400).json({
        error: "ORS limit",
        details: "time range > 3600s not allowed on this key. Use fallback for >60 min."
      });
    }

    // Se range_type=time -> seconds; se distance -> meters
    const rangeValue = finalRangeType === "time" ? seconds : Math.round(minutes);

    const url = `https://api.openrouteservice.org/v2/isochrones/${profile}`;

    const body = {
      locations: [[lon, lat]],
      range: [rangeValue],
      range_type: finalRangeType,
      attributes: ["area"]
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: key,
        "Content-Type": "application/json",
        Accept: "application/geo+json, application/json"
      },
      body: JSON.stringify(body)
    });

    const text = await r.text();
    if (!r.ok) {
      return res.status(r.status).json({ error: "ORS error", status: r.status, details: text });
    }

    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(text);
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
