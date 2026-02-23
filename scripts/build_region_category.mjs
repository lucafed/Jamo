import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REGION_ID = String(process.env.REGION_ID||"").trim();
const CATEGORY = String(process.env.CATEGORY||"").trim().toLowerCase();

if(!REGION_ID) throw new Error("Missing REGION_ID");

const REGIONS_CFG_PATH = path.join(__dirname,"..","configs","it","regions.json");
const cfg = JSON.parse(fs.readFileSync(REGIONS_CFG_PATH,"utf-8"));
const region = cfg.regions.find(r=>String(r.id)===REGION_ID);

const OUT = path.join(__dirname,"..","public","data","pois","regions",`${REGION_ID}-${CATEGORY}.json`);

function normName(s){
  return String(s??"")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-z0-9]+/g," ")
    .trim();
}

function hasAny(str,arr){ return arr.some(k=>str.includes(k)); }

function tagsToString(t){
  return Object.entries(t||{})
    .map(([k,v])=>`${String(k).toLowerCase()}=${String(v).toLowerCase()}`)
    .join(" ");
}

function isTouristic(p){
  const t = p.tags||{};
  const ts = tagsToString(t);
  const n = normName(p.name||"");

  const quality = t.website || t.wikipedia || t.wikidata || t.opening_hours;

  const strong =
    ts.includes("tourism=") ||
    ts.includes("historic=") ||
    ts.includes("natural=") ||
    ts.includes("leisure=");

  const wow = hasAny(n,[
    "castello","cascata","belvedere","borgo","parco",
    "abbazia","rocca","duomo","santuario"
  ]);

  return quality || strong || wow;
}

function score(p){
  const t = p.tags||{};
  const ts = tagsToString(t);
  let s=0;

  if(ts.includes("tourism=")) s+=30;
  if(ts.includes("historic=")) s+=35;
  if(ts.includes("natural=")) s+=28;
  if(ts.includes("place=")) s+=20;

  if(t.wikipedia || t.wikidata) s+=10;
  if(t.website) s+=6;

  return s;
}

async function main(){
  console.log(`[BUILD] ${REGION_ID} • ${CATEGORY}`);

  const q = `
[out:json][timeout:240];
area["ISO3166-2"="${region.iso3166_2}"]["boundary"="administrative"]->.a;
(
  node(area.a)["tourism"];
  node(area.a)["historic"];
  node(area.a)["natural"];
  node(area.a)["place"];
);
out center tags;
`;

  const data = await overpass(q,{retries:6,timeoutMs:180000});

  const raw = (data.elements||[])
    .map(toPlace)
    .filter(p=>p && p.lat!=null && p.lon!=null)
    .filter(p=>(p.name||"").trim())
    .filter(p=>isTouristic(p));

  const seen=new Set();
  const deduped=[];

  for(const p of raw){
    const key=`${normName(p.name)}|${Number(p.lat).toFixed(5)}|${Number(p.lon).toFixed(5)}`;
    if(seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  const places = deduped
    .map(p=>{
      const sc=score(p);
      return {
        id:p.id,
        name:p.name,
        lat:p.lat,
        lon:p.lon,
        type:CATEGORY,
        visibility: sc>=40?"chicca":"classica",
        score:sc
      };
    })
    .sort((a,b)=>b.score-a.score)
    .slice(0,15000);

  await writeJson(OUT,{
    region_id:`${REGION_ID}-${CATEGORY}`,
    generated_at:new Date().toISOString(),
    places
  });

  console.log(`✔ CATEGORY written (${places.length})`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
