// KAI Vault — structured knowledge graph.
// Entities (people, projects, things) + Facts (statements about them) + Relationships.
// Stored in localStorage; survives across sessions. Replaces flat self-notes with real structure.
window.KaiVault = (function(){
  const KEY = 'kai_vault_v1';
  let G = { entities:{}, facts:[], relations:[] };

  function _load(){ try{ G = JSON.parse(localStorage.getItem(KEY) || '{"entities":{},"facts":[],"relations":[]}'); }catch(e){ G={entities:{},facts:[],relations:[]}; } }
  function _save(){ try{ localStorage.setItem(KEY, JSON.stringify(G)); }catch(e){} }
  _load();

  function upsertEntity(name, type, attrs){
    if(!name) return null;
    const id = name.toLowerCase().trim();
    if(!G.entities[id]) G.entities[id] = { id, name, type: type||'thing', attrs:{}, created:Date.now() };
    if(type) G.entities[id].type = type;
    if(attrs) Object.assign(G.entities[id].attrs, attrs);
    G.entities[id].updated = Date.now();
    _save(); return G.entities[id];
  }
  function addFact(subject, predicate, object, confidence){
    if(!subject || !predicate) return null;
    G.facts.push({s:subject.toLowerCase().trim(), p:predicate, o:object||'', conf:confidence||0.8, t:Date.now()});
    if(G.facts.length>500) G.facts.shift();
    _save(); return G.facts[G.facts.length-1];
  }
  function addRelation(from, type, to){
    if(!from || !to) return null;
    G.relations.push({from:from.toLowerCase().trim(), type:type||'related', to:to.toLowerCase().trim(), t:Date.now()});
    if(G.relations.length>500) G.relations.shift();
    _save(); return G.relations[G.relations.length-1];
  }

  function getEntity(name){ return G.entities[name?.toLowerCase()?.trim()] || null; }
  function aboutEntity(name){
    const id = name?.toLowerCase()?.trim();
    if(!id) return null;
    return {
      entity: G.entities[id] || null,
      facts: G.facts.filter(f=>f.s===id),
      relations: G.relations.filter(r=>r.from===id || r.to===id)
    };
  }
  function recall(query){
    const q = (query||'').toLowerCase();
    const matched = {entities:[],facts:[]};
    for(const id in G.entities){
      const e = G.entities[id];
      if(id.includes(q) || (e.name||'').toLowerCase().includes(q)) matched.entities.push(e);
    }
    G.facts.forEach(f=>{
      if(f.s.includes(q) || f.p.includes(q) || (f.o||'').toLowerCase().includes(q)) matched.facts.push(f);
    });
    return matched;
  }
  function summary(){
    return { entities:Object.keys(G.entities).length, facts:G.facts.length, relations:G.relations.length };
  }
  function exportVault(){ return JSON.parse(JSON.stringify(G)); }
  function clear(){ G={entities:{},facts:[],relations:[]}; _save(); }

  return { upsertEntity, addFact, addRelation, getEntity, aboutEntity, recall, summary, exportVault, clear };
})();
