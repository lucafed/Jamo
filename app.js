const $ = (id) => document.getElementById(id);

const modeEl = $("mode");
const timeEl = $("time");
const distEl = $("dist");
const goBtn = $("goBtn");
const statusEl = $("status");
const resultsEl = $("results");

const showVisitedEl = $("showVisited");
const preferFamousEl = $("preferFamous");

const VISITED_KEY = "jamo.visited.v1";

const SPEED = { // km/h plausibili “di tratta”
  train: 95,
  bus: 65,
  plane: 700,
};

const OVERHEAD = { // minuti plausibili
  train_wait: 15,    // attesa/trasferimenti minimi
  bus_wait: 10,
  airport: 105,      // check-in + security + boarding (media)
  airport_exit: 25,  // uscita + bagagli (media)
  flight_extra: 20,  // taxi/decollo/atterraggio
};

function loadVisitedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(VISITED_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveVisitedSet(set) {
  localStorage.setItem(VISITED_KEY, JSON.stringify([...set]));
}

function formatMin(m){
  if (!isFinite(m)) return "—";
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m/60);
  const mm = Math.round(m%60);
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

function haversineKm(aLat, aLon, bLat, bLon){
  const R=6371, toRad=(d)=>d*Math.PI/180;
  const dLat=toRad(bLat-aLat), dLon=toRad(bLon-aLon);
  const lat1=toRad(aLat), lat2=toRad(bLat);
  const s=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}

function pickRadiusKm(mode, timeMin){
  // raggio candidati coerente col tempo (per non chiedere “mondo intero”)
  if (mode === "walk") return Math.min(25, 2 + timeMin/30 * 2);
  if (mode === "bike") return Math.min(120, 10 + timeMin/30 * 6);
  if (mode === "car")  return Math.min(600, 30 + timeMin/30 * 18);
  if (mode === "bus")  return Math.min(700, 40 + timeMin/30 * 16);
  if (mode === "train")return Math.min(900, 50 + timeMin/30 * 20);
  if (mode === "plane")return Math.min(1200, 200 + timeMin/30 * 60);
  return 200;
}

async function geoPos(){
  return new Promise((resolve,reject)=>{
    navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:12000,maximumAge:30000});
  });
}

async function apiDestinations(lat, lon, radiusKm){
  const r = await fetch(`/api/destinations?lat=${lat}&lon=${lon}&radiusKm=${radiusKm}`);
  if(!r.ok) throw new Error(`Destinations API ${r.status}`);
  return r.json();
}

async function apiHubs(lat, lon, radiusKm){
  const r = await fetch(`/api/hubs?lat=${lat}&lon=${lon}&radiusKm=${radiusKm}`);
  if(!r.ok) throw new Error(`Hubs API ${r.status}`);
  return r.json();
}

async function apiRoute(fromLonLat, toLonLat, profile){
  const r = await fetch(`/api/route`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ from: fromLonLat, to: toLonLat, profile })
  });
  if(!r.ok) throw new Error(`Route API ${r.status}`);
  return r.json();
}

function normalizeElementsToPoints(osm){
  const els = osm?.elements || [];
  const out = [];
  for(const e of els){
    if(!e || !e.lat || !e.lon) continue;
    const tags = e.tags || {};
    const name = tags.name || tags["name:it"] || tags["name:en"];
    if(!name) continue;
    out.push({
      id:`${e.type}/${e.id}`,
      lat:e.lat, lon:e.lon,
      name,
      tags
    });
  }
  // dedup
  const seen=new Set();
  return out.filter(p=>{
    const k = `${p.name.toLowerCase()}|${Math.round(p.lat*100)}|${Math.round(p.lon*100)}`;
    if(seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function nearest(point, hubs){
  let best=null, bestD=Infinity;
  for(const h of hubs){
    const d = haversineKm(point.lat, point.lon, h.lat, h.lon);
    if(d < bestD){ bestD=d; best={...h, distKm:d}; }
  }
  return best;
}

function describeDestinationTags(tags){
  if(tags.place === "city") return "Città";
  if(tags.place === "town") return "Paese";
  if(tags.place === "village") return "Borgo";
  if(tags.waterway === "waterfall") return "Cascata";
  if(tags.natural === "peak") return "Montagna";
  if(tags.boundary === "national_park" || tags.leisure === "nature_reserve") return "Parco/Riserva";
  return "Luogo";
}

async function computeDoorToDoor(user, dest, mode){
  // ritorna { totalMin, breakdown: { accessMin, lineMin, egressMin, notes[] }, feasible }
  const notes = [];
  if (mode === "car" || mode === "bike" || mode === "walk") {
    const profile = mode === "car" ? "driving-car" : mode === "bike" ? "cycling-regular" : "foot-walking";
    const data = await apiRoute([user.lon,user.lat],[dest.lon,dest.lat], profile);
    const sec = data?.features?.[0]?.properties?.summary?.duration;
    if(!sec) return { feasible:false, totalMin:Infinity, breakdown:{notes:["Routing non disponibile"]} };
    return {
      feasible:true,
      totalMin: sec/60,
      breakdown:{ accessMin: sec/60, lineMin: 0, egressMin: 0, notes }
    };
  }

  // HUBS: per treno/bus cerchiamo stazioni; per aereo aeroporti
  const isPlane = mode === "plane";
  const hubRadiusUser = isPlane ? 120 : 60;      // quanto lontano cerchiamo hub
  const hubRadiusDest = isPlane ? 120 : 60;

  const hubsUserRaw = await apiHubs(user.lat, user.lon, hubRadiusUser);
  const hubsDestRaw = await apiHubs(dest.lat, dest.lon, hubRadiusDest);

  const hubsUserAll = normalizeElementsToPoints(hubsUserRaw);
  const hubsDestAll = normalizeElementsToPoints(hubsDestRaw);

  const hubsUser = hubsUserAll.filter(h => isPlane ? (h.tags.aeroway === "aerodrome" || h.tags.aeroway === "airport") : (h.tags.railway === "station" || h.tags.public_transport === "station"));
  const hubsDest = hubsDestAll.filter(h => isPlane ? (h.tags.aeroway === "aerodrome" || h.tags.aeroway === "airport") : (h.tags.railway === "station" || h.tags.public_transport === "station"));

  if (!hubsUser.length) {
    notes.push(isPlane ? "Nessun aeroporto vicino alla tua posizione." : "Nessuna stazione vicino alla tua posizione.");
    return { feasible:false, totalMin:Infinity, breakdown:{notes} };
  }
  if (!hubsDest.length) {
    notes.push(isPlane ? "Nessun aeroporto vicino alla destinazione." : "Nessuna stazione vicino alla destinazione.");
    return { feasible:false, totalMin:Infinity, breakdown:{notes} };
  }

  const hubFrom = nearest(user, hubsUser);
  const hubTo = nearest(dest, hubsDest);

  // 1) ACCESS: user -> hubFrom (routing reale in auto; se vuoi a piedi, si può cambiare)
  const accessRoute = await apiRoute([user.lon,user.lat],[hubFrom.lon,hubFrom.lat],"driving-car");
  const accessSec = accessRoute?.features?.[0]?.properties?.summary?.duration;
  const accessMin = accessSec ? accessSec/60 : hubFrom.distKm/50*60;

  // 2) EGRESS: hubTo -> dest (routing reale in auto)
  const egressRoute = await apiRoute([hubTo.lon,hubTo.lat],[dest.lon,dest.lat],"driving-car");
  const egressSec = egressRoute?.features?.[0]?.properties?.summary?.duration;
  const egressMin = egressSec ? egressSec/60 : hubTo.distKm/50*60;

  // 3) LINEHAUL: hubFrom -> hubTo (stima plausibile)
  const airKm = haversineKm(hubFrom.lat, hubFrom.lon, hubTo.lat, hubTo.lon);

  let lineMin = 0;
  if (mode === "train") lineMin = (airKm / SPEED.train) * 60 + OVERHEAD.train_wait;
  else if (mode === "bus") lineMin = (airKm / SPEED.bus) * 60 + OVERHEAD.bus_wait;
  else if (mode === "plane") lineMin = (airKm / SPEED.plane) * 60 + OVERHEAD.flight_extra + OVERHEAD.airport + OVERHEAD.airport_exit;

  // note informative “come arrivi a prenderlo”
  notes.push(isPlane ? `Aeroporto partenza: ${hubFrom.name}` : `Stazione partenza: ${hubFrom.name}`);
  notes.push(isPlane ? `Aeroporto arrivo: ${hubTo.name}` : `Stazione arrivo: ${hubTo.name}`);

  const totalMin = accessMin + lineMin + egressMin;

  return {
    feasible:true,
    totalMin,
    breakdown:{
      accessMin,
      lineMin,
      egressMin,
      hubFrom,
      hubTo,
      airKm,
      notes
    }
  };
}

function renderChoice(main, alts, timeLimitMin){
  resultsEl.innerHTML = "";

  const mk = (x) => `
    <div class="result">
      <h2>
        <span>🎯 ${escapeHtml(x.dest.name)}</span>
        <span class="pill ${x.totalMin <= timeLimitMin ? "ok" : "bad"}">${x.totalMin <= timeLimitMin ? "ok" : "troppo"}</span>
      </h2>
      <div class="meta">
        Tipo: <b>${escapeHtml(describeDestinationTags(x.dest.tags))}</b><br/>
        Tempo totale: <b>${formatMin(x.totalMin)}</b><br/>
        Breakdown: access <b>${formatMin(x.breakdown.accessMin||0)}</b> +
        tratta <b>${formatMin(x.breakdown.lineMin||0)}</b> +
        arrivo <b>${formatMin(x.breakdown.egressMin||0)}</b>
        ${x.breakdown.notes?.length ? `<div class="muted" style="margin-top:6px">${x.breakdown.notes.map(n=>`• ${escapeHtml(n)}`).join("<br/>")}</div>` : ""}
      </div>
      <div class="actions">
        <button class="smallbtn primary" data-open="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(x.dest.lat + "," + x.dest.lon)}">📍 Maps</button>
        <button class="smallbtn" data-visit="${x.dest.id}">${x.visited ? "✅ Già visitato" : "☑️ Segna visitato"}</button>
      </div>
    </div>
  `;

  resultsEl.insertAdjacentHTML("beforeend", mk(main));

  if (alts.length) {
    resultsEl.insertAdjacentHTML("beforeend", `<div class="pill">Alternative</div>`);
    for (const a of alts) resultsEl.insertAdjacentHTML("beforeend", mk(a));
  }

  resultsEl.querySelectorAll("[data-open]").forEach(b=>{
    b.onclick = ()=> window.open(b.getAttribute("data-open"), "_blank");
  });
  resultsEl.querySelectorAll("[data-visit]").forEach(b=>{
    b.onclick = ()=>{
      const set = loadVisitedSet();
      const id = b.getAttribute("data-visit");
      if(set.has(id)) set.delete(id); else set.add(id);
      saveVisitedSet(set);
      b.textContent = set.has(id) ? "✅ Già visitato" : "☑️ Segna visitato";
    };
  });
}

function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));}

goBtn.onclick = async () => {
  try {
    goBtn.disabled = true;
    statusEl.textContent = "📍 GPS…";

    const pos = await geoPos();
    const user = { lat: pos.coords.latitude, lon: pos.coords.longitude };

    const mode = modeEl.value;
    const timeLimitMin = Number(timeEl.value);
    const distMaxKm = Number(distEl.value);

    // raggio “coerente col tempo”, ma non più basso del distMax scelto
    const radiusKm = Math.max(distMaxKm, pickRadiusKm(mode, timeLimitMin));

    statusEl.textContent = "🔎 Cerco luoghi…";
    const raw = await apiDestinations(user.lat, user.lon, radiusKm);
    let dests = normalizeElementsToPoints(raw).map(d => ({
      ...d,
      distKm: haversineKm(user.lat, user.lon, d.lat, d.lon)
    }));

    // primo filtro: distanza “a volo” per non calcolare routing su troppi
    dests = dests.filter(d => d.distKm <= radiusKm).slice(0, 30);

    // escludi visitati se non vuoi mostrarli
    const visitedSet = loadVisitedSet();
    const showVisited = showVisitedEl?.checked ?? false;
    if (!showVisited) dests = dests.filter(d => !visitedSet.has(d.id));

    if (!dests.length) {
      statusEl.textContent = "⚠️ Nessun luogo trovato. Aumenta km.";
      resultsEl.innerHTML = "";
      return;
    }

    statusEl.textContent = "⏱ Calcolo tempi porta-a-porta…";

    // Calcoliamo door-to-door sui migliori N candidati (veloce)
    const scored = [];
    for (const d of dests) {
      try {
        const r = await computeDoorToDoor(user, d, mode);
        if (!r.feasible) continue;
        scored.push({
          dest: d,
          totalMin: r.totalMin,
          breakdown: r.breakdown,
          visited: visitedSet.has(d.id),
        });
      } catch {
        // se una rotta fallisce, salta candidato
      }
      // limitiamo per velocità: basta una dozzina calcolate
      if (scored.length >= 12) break;
    }

    if (!scored.length) {
      statusEl.textContent = "⚠️ Nessuna meta coerente col mezzo (mancano hub). Prova Auto o aumenta raggio.";
      resultsEl.innerHTML = "";
      return;
    }

    // filtro tempo totale <= tempo disponibile
    const ok = scored.filter(x => x.totalMin <= timeLimitMin);
    const final = (ok.length ? ok : scored).sort((a,b)=> a.totalMin - b.totalMin);

    const main = final[0];
    const alts = final.slice(1, 4);

    renderChoice(main, alts, timeLimitMin);

    statusEl.textContent = `✅ Meta scelta con tempo totale ${formatMin(main.totalMin)}.`;

  } catch (e) {
    statusEl.textContent = "❌ Errore: " + (e?.message || String(e));
  } finally {
    goBtn.disabled = false;
  }
};
