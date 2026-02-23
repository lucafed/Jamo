import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REGION_ID = String(process.env.REGION_ID || "").trim();
if (!REGION_ID) throw new Error("Missing env REGION_ID (e.g. it-veneto)");

const REGIONS_CFG_PATH = path.join(__dirname, "..", "configs", "it", "regions.json");
const cfg = JSON.parse(fs.readFileSync(REGIONS_CFG_PATH, "utf-8"));
const region = (cfg.regions || []).find(r => String(r.id) === REGION_ID);
if (!region) throw new Error(`Region not found in configs: ${REGION_ID}`);

const OUT = path.join(__dirname, "..", "public", "data", "pois", "regions", `${REGION_ID}.json`);

function normName(s){
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-z0-9]+/g," ")
    .trim();
}

function hasAny(str, arr){ return arr.some(k => str.includes(k)); }

function tagsToString(t){
  return Object.entries(t||{})
    .map(([k,v]) => `${String(k).toLowerCase()}=${String(v).toLowerCase()}`)
    .join(" ");
}

function isClearlyIrrelevant(p){
  const ts = tagsToString(p.tags);
  const n = normName(p.name||"");

  if (hasAny(ts, ["highway=","railway=","public_transport=","route=","junction="])) return true;
  if (hasAny(ts, ["amenity=parking","amenity=fuel","amenity=charging_station"])) return true;
  if (hasAny(ts, ["landuse=industrial","building=industrial","building=warehouse","building=office"])) return true;
  if (hasAny(ts, ["power=","telecom=","pipeline=","place=locality"])) return true;
  if (hasAny(n, ["parcheggio","stazione","svincolo","impianto","tratto","km "])) return true;

  return false;
}

function isTouristicVisitabile(p){
  const t = p.tags||{};
  const ts = tagsToString(t);
  const n = normName(p.name||"");

  const quality =
    t.website || t["contact:website"] ||
    t.wikipedia || t.wikidata ||
    t.opening_hours;

  const touristStrong =
    ts.includes("tourism=") ||
    ts.includes("historic=") ||
    ts.includes("natural=waterfall") ||
    ts.includes("natural=cave_entrance") ||
    ts.includes("natural=peak") ||
    ts.includes("tourism=viewpoint") ||
    ts.includes("boundary=national_park") ||
    ts.includes("leisure=nature_reserve");

  const wowName = hasAny(n, [
    "castello","rocca","forte","abbazia","duomo","santuario",
    "parco","riserva","cascata","belvedere","borgo"
  ]);

  return quality || touristStrong || wowName;
}

function overpassAreaSelectorByISO(iso){
  return `area["ISO3166-2"="${iso}"]["boundary"="administrative"]->.a;`;
}

function buildCoreQuery(iso){
  return `
[out:json][timeout:260];
${overpassAreaSelectorByISO(iso)}
(
  node(area.a)["place"~"city|town|village|hamlet"];
  node(area.a)["tourism"];
  way(area.a)["tourism"];
  relation(area.a)["tourism"];
  node(area.a)["historic"];
  way(area.a)["historic"];
  relation(area.a)["historic"];
  node(area.a)["natural"~"waterfall|cave_entrance|peak|gorge"];
  node(area.a)["tourism"="viewpoint"];
  relation(area.a)["boundary"="national_park"];
);
out center tags;
`;
}

function scoreCore(p){
  const t = p.tags||{};
  const ts = tagsToString(t);
  const n = normName(p.name||"");
  let s = 0;

  if (ts.includes("place=city")) s+=25;
  if (ts.includes("place=town")) s+=20;
  if (ts.includes("place=village")) s+=16;
  if (ts.includes("place=hamlet")) s+=12;

  if (ts.includes("historic=")) s+=20;
  if (ts.includes("tourism=viewpoint")) s+=22;
  if (ts.includes("natural=waterfall")) s+=25;
  if (ts.includes("natural=peak")) s+=18;

  if (t.wikipedia || t.wikidata) s+=8;
  if (t.website) s+=5;

  if (hasAny(n,["castello","rocca","abbazia","cascata","belvedere"])) s+=10;

  return s;
}

async function main(){
  console.log(`[BUILD] CORE ${REGION_ID}`);

  let data = await overpass(buildCoreQuery(region.iso3166_2), { retries:6, timeoutMs:200000 });

  const raw = (data.elements||[])
    .map(toPlace)
    .filter(p=>p && p.lat!=null && p.lon!=null)
    .filter(p=>(p.name||"").trim())
    .filter(p=>!isClearlyIrrelevant(p))
    .filter(p=>isTouristicVisitabile(p));

  const seen = new Set();
  const deduped = [];

  for(const p of raw){
    const key = `${normName(p.name)}|${Number(p.lat).toFixed(5)}|${Number(p.lon).toFixed(5)}`;
    if(seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  const places = deduped
    .map(p=>{
      const score = scoreCore(p);
      return {
        id:p.id,
        name:p.name,
        lat:p.lat,
        lon:p.lon,
        type:"core",
        visibility: score>=30?"chicca":"classica",
        score
      };
    })
    .sort((a,b)=>b.score-a.score)
    .slice(0,25000);

  await writeJson(OUT,{
    region_id:REGION_ID,
    generated_at:new Date().toISOString(),
    places
  });

  console.log(`✔ CORE written (${places.length})`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
