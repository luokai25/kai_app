// KAI Skill System — Claude-style skills. 9,786 SKILL.md files indexed.
// When Kai asks for help, KAI can search skills, load the relevant one,
// and follow its instructions to do the task.
window.KaiSkills = (function(){
  let DB=null;

  function init(db){ DB=db; }
  function ready(){ return !!DB; }

  function _esc(s){ return String(s||"").replace(/'/g,"''"); }

  // Search skills by query — returns best matches with name + description
  function search(query, limit){
    if(!DB) return [];
    const qs = (query||"").toLowerCase().split(/\s+/).filter(w=>w.length>2).slice(0,5);
    if(!qs.length) return [];
    const like = qs.map(w=>`(name LIKE '%${_esc(w)}%' OR description LIKE '%${_esc(w)}%' OR tags LIKE '%${_esc(w)}%')`).join(" AND ");
    try{
      const r = DB.exec(`SELECT name, description, category, tags FROM skill WHERE ${like} LIMIT ${limit||5}`);
      if(!r[0]) return [];
      return r[0].values.map(v=>({name:v[0], description:v[1], category:v[2], tags:v[3]}));
    }catch(e){ return []; }
  }

  // Load a specific skill's full body to follow
  function load(name){
    if(!DB) return null;
    try{
      const r = DB.exec(`SELECT name, description, category, tags, body FROM skill WHERE name='${_esc(name)}' LIMIT 1`);
      if(!r[0]) return null;
      const v = r[0].values[0];
      return {name:v[0], description:v[1], category:v[2], tags:v[3], body:v[4]};
    }catch(e){ return null; }
  }

  // List categories with counts
  function categories(){
    if(!DB) return [];
    try{
      const r = DB.exec("SELECT category, COUNT(*) FROM skill GROUP BY category ORDER BY 2 DESC");
      return r[0] ? r[0].values.map(v=>({category:v[0], count:v[1]})) : [];
    }catch(e){ return []; }
  }

  function stats(){
    if(!DB) return {total:0};
    try{
      const r = DB.exec("SELECT COUNT(*) FROM skill");
      return {total: r[0]?r[0].values[0][0]:0};
    }catch(e){ return {total:0}; }
  }

  return { init, ready, search, load, categories, stats };
})();
