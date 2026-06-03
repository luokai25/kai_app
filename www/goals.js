// KAI Goals — OKR-style. Objectives -> key results -> daily check-ins.
window.KaiGoals = (function(){
  const KEY='kai_goals_v1';
  let store={ objectives:[] }; // {id,title,why,status,progress,keyResults:[{kr,target,current,unit}],created,updated,checkins:[]}
  try{ store=JSON.parse(localStorage.getItem(KEY)||'{"objectives":[]}'); }catch(e){}
  function save(){ try{ localStorage.setItem(KEY, JSON.stringify(store)); }catch(e){} }
  function add(title, why){
    const o={id:'o'+Date.now(),title,why:why||'',status:'active',progress:0,keyResults:[],created:Date.now(),updated:Date.now(),checkins:[]};
    store.objectives.unshift(o); save(); return o;
  }
  function addKR(objId, kr, target, unit){
    const o=store.objectives.find(x=>x.id===objId); if(!o) return null;
    o.keyResults.push({kr,target:target||1,current:0,unit:unit||'count'}); o.updated=Date.now(); save(); return o;
  }
  function updateProgress(objId, krIndex, current){
    const o=store.objectives.find(x=>x.id===objId); if(!o||!o.keyResults[krIndex]) return null;
    o.keyResults[krIndex].current=current;
    // overall progress = avg of KR ratios
    const ratios=o.keyResults.map(k=>Math.min(1,k.current/Math.max(1,k.target)));
    o.progress = ratios.length ? ratios.reduce((a,b)=>a+b,0)/ratios.length : 0;
    o.updated=Date.now(); save(); return o;
  }
  function checkin(objId, note){
    const o=store.objectives.find(x=>x.id===objId); if(!o) return null;
    o.checkins.push({t:Date.now(),note:String(note||'').slice(0,300)}); if(o.checkins.length>30) o.checkins.shift(); save(); return o;
  }
  function list(){ return store.objectives; }
  function active(){ return store.objectives.filter(o=>o.status==='active'); }
  function summary(){ return { total:store.objectives.length, active:active().length }; }
  return { add, addKR, updateProgress, checkin, list, active, summary };
})();
