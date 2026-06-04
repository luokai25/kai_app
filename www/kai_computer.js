// KAI Computer — persistent agentic workspace.
// Tasks survive between chat turns. They have plans, virtual files, terminal logs,
// and run their own ticks independent of the chat reply loop.
window.KaiComputer = (function(){
  const KEY = 'kai_tasks_v1';
  let tasks = [];
  let activeId = null;
  let tickHandle = null;
  let runHooks = {};  // {taskId: async stepFn}

  function _load(){
    try{ const j=JSON.parse(localStorage.getItem(KEY)||'{}'); tasks=j.tasks||[]; activeId=j.activeId||null; }catch(e){ tasks=[]; }
  }
  function _save(){ try{ localStorage.setItem(KEY,JSON.stringify({tasks,activeId})); }catch(e){} }
  _load();

  function newTask(title, goal){
    const t = {
      id: 't'+Date.now(),
      title: (title||'untitled').slice(0,80),
      goal: (goal||'').slice(0,2000),
      status: 'idle',         // idle | planning | running | paused | done | error
      plan: [],               // [{step, status, result, t}]
      currentStep: 0,
      files: {},              // {filename: content}
      log: [],                // [{t, type, msg}]
      created: Date.now(),
      updated: Date.now()
    };
    tasks.unshift(t);
    if(tasks.length>40) tasks.pop();
    activeId = t.id;
    _save();
    return t;
  }
  function get(id){ return tasks.find(t=>t.id===id); }
  function active(){ return activeId ? get(activeId) : null; }
  function list(){ return tasks; }
  function setActive(id){ activeId = id; _save(); }

  function appendLog(taskId, type, msg){
    const t = get(taskId); if(!t) return;
    t.log.push({t:Date.now(), type, msg:String(msg||'').slice(0,1500)});
    if(t.log.length>200) t.log.shift();
    t.updated = Date.now();
    _save();
    _emit('log', t);
  }
  function setPlan(taskId, planSteps){
    const t = get(taskId); if(!t) return;
    t.plan = planSteps.map(s=>({step:s, status:'pending', result:null, t:null}));
    t.currentStep = 0;
    t.status = 'running';
    t.updated = Date.now();
    _save();
    _emit('plan', t);
  }
  function markStep(taskId, idx, status, result){
    const t = get(taskId); if(!t || !t.plan[idx]) return;
    t.plan[idx].status = status;
    if(result !== undefined) t.plan[idx].result = String(result||'').slice(0,2000);
    t.plan[idx].t = Date.now();
    if(status === 'done' && idx === t.currentStep) t.currentStep = idx+1;
    t.updated = Date.now();
    _save();
    _emit('step', t);
  }
  function writeFile(taskId, name, content){
    const t = get(taskId); if(!t) return;
    t.files[name] = String(content||'');
    t.updated = Date.now();
    _save();
    _emit('file', t);
  }
  function readFile(taskId, name){
    const t = get(taskId); if(!t) return null;
    return t.files[name] !== undefined ? t.files[name] : null;
  }
  function listFiles(taskId){
    const t = get(taskId); if(!t) return [];
    return Object.keys(t.files);
  }
  function setStatus(taskId, status){
    const t = get(taskId); if(!t) return;
    t.status = status; t.updated = Date.now(); _save();
    _emit('status', t);
  }
  function stop(taskId){
    const t = get(taskId); if(!t) return;
    t.status = 'paused';
    delete runHooks[taskId];
    t.updated = Date.now(); _save();
    appendLog(taskId, 'system', 'Task stopped by Kai.');
    _emit('status', t);
  }
  function remove(taskId){
    tasks = tasks.filter(t=>t.id!==taskId);
    if(activeId===taskId) activeId = tasks[0]?.id||null;
    delete runHooks[taskId];
    _save();
    _emit('list');
  }

  // Event emitter for UI updates
  const listeners = [];
  function on(fn){ listeners.push(fn); }
  function _emit(kind, task){
    listeners.forEach(fn=>{ try{ fn(kind, task); }catch(e){} });
  }

  // The detached task runner. Ticks every 3s; for each running task with a runHook,
  // executes one step. This is what makes the workspace persist across chat turns.
  async function tick(){
    for(const t of tasks){
      if(t.status !== 'running') continue;
      const hook = runHooks[t.id];
      if(!hook) continue;
      if(t.currentStep >= t.plan.length){
        setStatus(t.id, 'done');
        appendLog(t.id, 'system', 'Task complete.');
        delete runHooks[t.id];
        continue;
      }
      try{
        await hook(t, t.currentStep);
      }catch(e){
        appendLog(t.id, 'error', e.message);
        setStatus(t.id, 'error');
        delete runHooks[t.id];
      }
    }
  }
  function startTicker(){
    if(tickHandle) return;
    tickHandle = setInterval(tick, 3000);
  }
  function attachRunner(taskId, stepFn){
    runHooks[taskId] = stepFn;
    setStatus(taskId, 'running');
    appendLog(taskId, 'system', 'Task started.');
    startTicker();
  }

  return { newTask, get, active, list, setActive, appendLog, setPlan, markStep,
           writeFile, readFile, listFiles, setStatus, stop, remove, on,
           attachRunner, tick, startTicker };
})();
