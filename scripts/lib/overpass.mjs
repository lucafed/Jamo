// scripts/lib/overpass.mjs — robust Overpass client (v3)
import fs from "node:fs/promises";
import path from "node:path";

// Endpoints: il primo è "classico", poi mirror.
// NB: alcuni mirror (tipo lz4) a volte servono HTML (error page). Qui lo gestiamo.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isHtmlOrXml(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    t.startsWith("<!doctype") ||
    t.startsWith("<html") ||
    t.startsWith("<?xml") ||
    t.includes("<title>") // molte error page
  );
}

function shouldRetry(err) {
  const msg = String(err?.message || err);
  // timeout/abort
  if (msg.includes("AbortError") || msg.toLowerCase().includes("timeout")) return true;
  // html/xml response
  if (msg.includes("HTML/XML response")) return true;
  // http status retriable
  if (msg.includes("HTTP 429") || msg.includes("HTTP 500") || msg.includes("HTTP 502") || msg.includes("HTTP 503") || msg.includes("HTTP 504")) return true;
  // parse error può essere pagina troncata/temporanea
  if (msg.toLowerCase().includes("unexpected token") || msg.toLowerCase().includes("json")) return true;

  return false;
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

export async function overpass(
  query,
  {
    retries = 8,
    timeoutMs = 150000,
    backoffBaseMs = 1500,
  } = {}
) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];

    // exponential backoff + jitter
    const backoff = Math.round(backoffBaseMs * Math.pow(1.7, attempt));
    const jitter = Math.round(Math.random() * 600);

    try {
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "accept": "application/json,text/plain;q=0.9,*/*;q=0.8",
            "user-agent": "Jamo/overpass-client (github-actions/vercel)",
          },
          body: "data=" + encodeURIComponent(query),
        },
        timeoutMs
      );

      // status non-OK: spesso temporanei
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const e = new Error(`Overpass HTTP ${res.status} (${endpoint})`);
        e._body = body?.slice?.(0, 400) || "";
        throw e;
      }

      // prova JSON diretto se content-type è json
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("application/json")) {
        const json = await res.json();
        if (!json || !Array.isArray(json.elements)) {
          throw new Error(`Overpass invalid JSON (no elements) (${endpoint})`);
        }
        return json;
      }

      // fallback: leggi testo e parse
      const text = await res.text();
      if (isHtmlOrXml(text)) {
        throw new Error(`Overpass HTML/XML response (${endpoint})`);
      }

      const json = JSON.parse(text);
      if (!json || !Array.isArray(json.elements)) {
        throw new Error(`Overpass invalid JSON (no elements) (${endpoint})`);
      }

      return json;

    } catch (err) {
      lastError = err;

      // se non è un errore recuperabile, esci subito
      if (!shouldRetry(err)) break;

      // se ho ancora tentativi, aspetta e riprova
      if (attempt < retries) {
        await sleep(backoff + jitter);
        continue;
      }
    }
  }

  throw lastError;
}

export function toPlace(el) {
  const tags = el?.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || "(senza nome)";
  const lat = el?.lat ?? el?.center?.lat;
  const lon = el?.lon ?? el?.center?.lon;

  return {
    id: `${el.type}:${el.id}`,
    name,
    lat,
    lon,
    tags,
  };
}

export async function writeJson(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2), "utf8");
}
