/* Prefer unused products, then rotate types and brands within the user's filters. */
function chooseGiftRotation(rows, history = [], current = []) {
  const counts = new Map(), types = new Map(), brands = new Map();
  const recent = new Set(history.slice(-1).flat()), old = new Set(current);
  const byKey = new Map(rows.map(g => [g.key, g]));
  for (const batch of history) for (const key of batch) {
    counts.set(key, (counts.get(key)||0)+1);
    const g = byKey.get(key); if (!g) continue;
    types.set(g.productType,(types.get(g.productType)||0)+1);
    brands.set(g.brand,(brands.get(g.brand)||0)+1);
  }
  const result = [], used = new Set();
  const noise = new Map(rows.map(g=>[g.key,Math.random()]));
  const score = g => [old.has(g.key)?1:0, recent.has(g.key)?1:0, counts.get(g.key)||0,
    result.some(p=>p.brand===g.brand)?1:0, types.get(g.productType)||0, brands.get(g.brand)||0,noise.get(g.key)];
  while(result.length<4) {
    const candidates=rows.filter(g=>!used.has(g.productType));
    candidates.sort((a,b)=>{const x=score(a),y=score(b);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;});
    if(!candidates.length)break;
    result.push(candidates[0]);used.add(candidates[0].productType);
  }
  return result;
}
if(typeof module!=='undefined')module.exports={chooseGiftRotation};
