// api/geocode.js — v2.0 (adds region_id for Italy)
// Uses Nominatim (OpenStreetMap) reverse data inside the search response
export default async function handler(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ ok: false, error: "Missing q" });

    const url =
      "https://nominatim.openstreetmap.org/search?" +
      new URLSearchParams({
        q,
        format: "jsonv2",
        addressdetails: "1",
        limit: "1",
        countrycodes: "it,sm,va,fr,ch,at,si,hr,de",
      }).toString();

    const r = await fetch(url, {
      headers: {
        "accept-language": "it",
        "user-agent": "Jamo/1.0 (contact: none)",
      },
    });

    if (!r.ok) {
      return res.status(500).json({ ok: false, error: `Nominatim HTTP ${r.status}` });
    }

    const arr = await r.json();
    const hit = Array.isArray(arr) ? arr[0] : null;
    if (!hit) return res.status(404).json({ ok: false, error: "Nessun risultato" });

    const lat = Number(hit.lat);
    const lon = Number(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(500).json({ ok: false, error: "Coordinate non valide" });
    }

    const addr = hit.address || {};
    const country_code = String(addr.country_code || "").toUpperCase();

    // For Italy: region name comes as addr.state (usually)
    const regionNameRaw =
      country_code === "IT"
        ? (addr.state || addr.region || addr.county || "")
        : "";

    // normalize -> slug for region id
    const slugify = (s) =>
      String(s || "")
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/'/g, "-")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

    // map the few tricky italian region spellings (Nominatim variants)
    const mapIT = (s) => {
      const k = slugify(s);
      const m = {
        "valle-daosta": "valle-d-aosta",
        "val-d-aosta": "valle-d-aosta",
        "trentino-alto-adige-sudtirol": "trentino-alto-adige",
        "trentino-alto-adige-sudtirol-": "trentino-alto-adige",
        "friuli-venezia-giulia": "friuli-venezia-giulia",
        "emilia-romagna": "emilia-romagna",
      };
      return m[k] || k;
    };

    const region_slug = country_code === "IT" ? mapIT(regionNameRaw) : "";
    const region_id = region_slug ? `it-${region_slug}` : "";

    return res.status(200).json({
      ok: true,
      result: {
        label: hit.display_name || q,
        lat,
        lon,
        country_code: country_code || "",
        region_name: regionNameRaw || "",
        region_id,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
