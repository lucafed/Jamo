// scripts/lib/overpass.mjs
import fs from "node:fs/promises";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Query Overpass con retry + rotazione endpoint (anti 504).
 */
export async function overpass(query, {
  retries = 6,
  timeoutMs = 120000,
  backoffBaseMs = 1500,
} = {}) {
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    const wait = backoffBaseMs * Math.pow(1.6, attempt);

    try {
      const res = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
      }, timeoutMs);

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        // 429 / 504 tipici: ritenta
        const retryable = [429, 502, 503, 504].includes(res.status);
        const msg = `Overpass HTTP ${res.status} @ ${endpoint} :: ${txt.slice(0, 200)}`;
        if (!retryable) throw new Error(msg);
        throw new Error(msg);
      }

      const json = await res.json();
      return json;
    } catch (e) {
      lastErr = e;
      // ritenta
      if (attempt < retries) {
        await sleep(wait);
        continue;
      }
    }
  }

  throw lastErr ?? new Error("Overpass error");
}

export function toPlace(el) {
  const tags = el.tags || {};
  const name =
    tags.name ||
    tags["name:it"] ||
    tags.brand ||
    tags.operator ||
    tags.ref ||
    null;

  return {
    id: `${el.type}:${el.id}`,
    name: name || "(senza nome)",
    lat: el.lat ?? el.center?.lat,
    lon: el.lon ?? el.center?.lon,
    tags,
  };
}

export async function writeJson(filePath, obj) {
  await fs.mkdir(filePath.split("/").slice(0, -1).join("/"), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2), "utf8");
}
