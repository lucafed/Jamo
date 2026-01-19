#!/usr/bin/env node
/**
 * Jamo — generate_events_sources.mjs (v1.0)
 * - Input: events_sources.json
 * - Output: events_sources.generated.json
 * - Replace: {TODAY} -> YYYY-MM-DD (today)
 */
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const IN_PATH = path.join(ROOT, "events_sources.json");
const OUT_PATH = path.join(ROOT, "events_sources.generated.json");

function todayYYYYMMDD() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function deepReplaceToday(obj, token, value) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return obj.split(token).join(value);
  if (Array.isArray(obj)) return obj.map((x) => deepReplaceToday(x, token, value));
  if (typeof obj === "object") {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = deepReplaceToday(obj[k], token, value);
    return out;
  }
  return obj;
}

function main() {
  if (!fs.existsSync(IN_PATH)) {
    console.error(`Missing ${IN_PATH}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(IN_PATH, "utf8"));
  const t = todayYYYYMMDD();
  const gen = deepReplaceToday(raw, "{TODAY}", t);

  fs.writeFileSync(OUT_PATH, JSON.stringify(gen, null, 2), "utf8");
  console.log(`✅ Wrote ${OUT_PATH} (TODAY=${t})`);
}

main();
