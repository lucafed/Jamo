export default async function handler(req, res) {
  try {
    const { lat, lon, vibe = "any", radiusKm = "25" } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({ error: "Missing lat/lon" });
    }

    const R = Math.max(1, Math.min(50, Number(radiusKm))) * 1000; // metri (1–50 km)

    // Mappa vibe -> OpenTripMap kinds
    const kindsMap = {
      natura: "natural,geological_formations,water",
      borghi: "historic,architecture,urban_environment",
      cultura: "museums,interesting_places,cultural",
      relax: "gardens_and_parks,view_points,beaches",
      cibo: "foods",
      party: "nightclubs",
      any: ""
    };

    const kinds = kindsMap[vibe] ?? "";

    const API_KEY = process.env.OPENTRIPMAP_KEY;
    if (!API_KEY) {
      return res.status(500).json({ error: "Missing OPENTRIPMAP_KEY in Vercel env" });
    }

    // 1) Trova posti intorno a te
    const base = "https://api.opentripmap.com/0.1/en/places";
    const listUrl =
      `${base}/radius?radius=${R}` +
      `&lon=${encodeURIComponent(lon)}&lat=${encodeURIComponent(lat)}` +
      (kinds ? `&kinds=${encodeURIComponent(kinds)}` : "") +
      `&rate=2&format=json&limit=25&apikey=${API_KEY}`;

    const listResp = await fetch(listUrl);
    if (!listResp.ok) {
      const t = await listResp.text();
      return res.status(502).json({ error: "OpenTripMap radius failed", detail: t });
    }
    const places = await listResp.json();

    // 2) Prendi dettagli per i primi 8 (nome + coords + wikipedia/descrizione se c'è)
    const top = places.slice(0, 8);

    const details = [];
    for (const p of top) {
      if (!p.xid) continue;
      const dUrl = `${base}/xid/${p.xid}?apikey=${API_KEY}`;
      const dResp = await fetch(dUrl);
      if (!dResp.ok) continue;
      const d = await dResp.json();

      details.push({
        xid: p.xid,
        name: d.name || p.name || "Meta",
        lat: d.point?.lat ?? p.point?.lat,
        lon: d.point?.lon ?? p.point?.lon,
        kinds: d.kinds || "",
        wikipedia: d.wikipedia || "",
        url: d.url || "",
        preview: d.preview?.source || "",
        dist: p.dist ?? null
      });
    }

    return res.status(200).json({
      ok: true,
      count: details.length,
      results: details
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e) });
  }
}
