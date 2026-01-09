// scripts/lib/overpass.mjs
import fs from "node:fs/promises";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function overpass(query, {
  retries = 6,
  timeoutMs = 120000,
  backoffBaseMs = 2000,
} = {}) {

  let lastError = null;

  for (let i = 0; i <= retries; i++) {
    const endpoint = OVERPASS_ENDPOINTS[i % OVERPASS_ENDPOINTS.length];
    const wait = backoffBaseMs * Math.pow(1.5, i);

    try {
      const res = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
      }, timeoutMs);

      const text = await res.text();

      // ❗ Overpass a volte risponde HTML/XML
      if (
        text.trim().startsWith("<!DOCTYPE") ||
        text.trim().startsWith("<html") ||
        text.trim().startsWith("<?xml")
      ) {
        throw new Error(`Overpass HTML/XML response (${endpoint})`);
      }

      const json = JSON.parse(text);
      if (!json.elements) {
        throw new Error(`Overpass invalid JSON (${endpoint})`);
      }

      return json;

    } catch (err) {
      lastError = err;
      if (i < retries) {
        await sleep(wait);
        continue;
      }
    }
  }

  throw lastError;
}

export function toPlace(el) {
  const tags = el.tags || {};
  return {
    id: `${el.type}:${el.id}`,
    name: tags.name || tags["name:it"] || tags.brand || "(senza nome)",
    lat: el.lat ?? el.center?.lat,
    lon: el.lon ?? el.center?.lon,
    tags,
  };
}

export async function writeJson(filePath, obj) {
  await fs.mkdir(filePath.split("/").slice(0, -1).join("/"), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2), "utf8");
}
