/* Imported KOL catalog. Selection is checked again by the server before AI. */
(() => {
  const el=id=>document.getElementById(id);
  let catalog=[],picked=[];
  const norm=s=>s.normalize('NFD').replace(/\p{M}/gu,'').replace(/[đĐ]/g,'d').toLowerCase();
  const filtered=()=>catalog.filter(g=>{
    const recipient={nam:'boyfriend',nu:'girlfriend','cả hai':'all'}[el('ttGender').value];
    const segment=el('ttTier').value.replace('kol_','');
    return (recipient==='all'||g.recipient==='unisex'||g.recipient===recipient)&&
      (segment==='all'||g.segment===segment)&&
      (el('ttKolBrand').value==='all'||g.brand===el('ttKolBrand').value)&&
      (el('ttKolType').value==='all'||g.productType===el('ttKolType').value)&&
      norm(el('ttKolSearch').value).split(/\s+/).every(t=>norm(g.label+' '+g.type).includes(t));
  });
  const status=text=>{el('ttKolStatus').textContent=text;};
  function render(message){
    const rows=filtered(), box=el('ttKolProducts');box.replaceChildren();
    const types=new Set(picked.map(g=>g.productType));
    for(const g of rows){
      const row=document.createElement('div');row.style.cssText='padding:9px 0;border-bottom:1px solid var(--line)';
      const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=picked.some(p=>p.key===g.key);
      check.disabled=!check.checked&&(picked.length===4||types.has(g.productType));
      check.onchange=()=>{picked=check.checked?[...picked,g]:picked.filter(p=>p.key!==g.key);render();};
      label.append(check,document.createTextNode(' '+g.icon+' '+g.label+' · '+g.productType));
      const link=document.createElement('a');link.href=g.sourceUrl;link.target='_blank';link.rel='noopener noreferrer';link.textContent=' Nguồn hãng ↗';link.style.fontSize='11px';
      row.append(label,link);box.append(row);
    }
    const chosen=el('ttKolSelected');chosen.replaceChildren();
    for(const g of picked){const line=document.createElement('div');line.textContent=g.label+' ';const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','Bỏ '+g.label);remove.onclick=()=>{picked=picked.filter(p=>p.key!==g.key);render();};line.append(remove);chosen.append(line);}
    el('ttKolMix').disabled=new Set(rows.map(g=>g.productType)).size<4;
    status(message||`${picked.length}/4 món · ${rows.length} sản phẩm phù hợp. ${el('ttKolMix').disabled?'Bộ lọc còn dưới 4 loại; hãy nới bộ lọc để mix.':'Ví/ví thẻ cùng loại; đồng hồ/smartwatch cùng loại.'}`);
  }
  function change(){const allowed=new Set(filtered().map(g=>g.key));const before=picked.length;picked=picked.filter(g=>allowed.has(g.key));render(before!==picked.length?'Đã bỏ món không còn hợp bộ lọc. Chọn hoặc mix lại để đủ 4 món.':undefined);}
  ['ttGender','ttTier','ttKolBrand','ttKolType'].forEach(id=>el(id).addEventListener('change',change));
  el('ttKolSearch').addEventListener('input',change);
  el('ttKolMix').onclick=()=>{
    const rows=filtered(), groups=new Map();for(const g of rows)groups.set(g.productType,[...(groups.get(g.productType)||[]),g]);
    if(groups.size<4){render('Cần ít nhất 4 loại phù hợp; tool không tự nới bộ lọc.');return;}
    const old=new Set(picked.map(g=>g.key));let next=[];
    for(let attempt=0;attempt<15;attempt++){
      const entries=[...groups.values()];for(let i=entries.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[entries[i],entries[j]]=[entries[j],entries[i]];}
      next=entries.slice(0,4).map(a=>a[Math.floor(Math.random()*a.length)]);
      if(next.some(g=>!old.has(g.key)))break;
    }
    if(next.every(g=>old.has(g.key)))for(let i=0;i<next.length;i++){
      const types=new Set(next.filter((_,j)=>i!==j).map(g=>g.productType));const alternative=rows.find(g=>!old.has(g.key)&&!types.has(g.productType));if(alternative){next[i]=alternative;break;}
    }
    picked=next;render();
  };
  window.ttKolSelection=()=>{if(picked.length!==4)throw new Error('Chọn hoặc mix đủ 4 món từ catalog KOL.');return picked.map(g=>g.key);};
  fetch('/catalog/kol-gifts.json?v=2026.09.10-kol-gift-catalog').then(r=>{if(!r.ok)throw new Error('Không tải được catalog KOL.');return r.json();}).then(data=>{
    catalog=data.gifts;
    for(const [id,field] of [['ttKolBrand','brand'],['ttKolType','productType']])for(const value of [...new Set(catalog.map(g=>g[field]))].sort()){const option=document.createElement('option');option.value=value;option.textContent=value;el(id).append(option);}
    render();
  }).catch(e=>status(e.message));
})();
