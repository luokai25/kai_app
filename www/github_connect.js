// KAI's GitHub connector. User pastes a GitHub Personal Access Token (PAT)
// in settings — same model as the API key. KAI can then read/edit his own repo.
// Token kept in localStorage; never sent anywhere except api.github.com.
window.KaiGitHub = (function(){
  const API = "https://api.github.com";
  let token = null;
  let owner = null;
  let repo = null;
  let user = null;

  function load(){
    try{
      const j = JSON.parse(localStorage.getItem('kai_github')||'null');
      if(j){ token=j.token; owner=j.owner; repo=j.repo; user=j.user; }
    }catch(e){}
  }
  function save(){
    try{ localStorage.setItem('kai_github', JSON.stringify({token,owner,repo,user})); }catch(e){}
  }
  function clear(){ token=null; owner=null; repo=null; user=null; save(); }
  function isConnected(){ return !!(token && owner && repo); }
  function info(){ return {connected:isConnected(), user, owner, repo}; }

  async function _req(path, opts){
    if(!token) throw new Error('Not connected');
    const r = await fetch(API+path, {
      ...opts,
      headers:{
        'Authorization':'Bearer '+token,
        'Accept':'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',
        ...(opts?.headers||{})
      }
    });
    if(!r.ok){
      const t=await r.text();
      throw new Error('GitHub '+r.status+': '+t.slice(0,200));
    }
    return r.json();
  }

  // Connect: verify the token and stash who they are + which repo
  async function connect(t, ownerSlug, repoSlug){
    const r = await fetch(API+'/user', {headers:{'Authorization':'Bearer '+t}});
    if(!r.ok) throw new Error('Token rejected ('+r.status+')');
    const u = await r.json();
    token=t; user=u.login;
    owner = ownerSlug || u.login;
    repo = repoSlug || 'kai_app';
    // verify repo access
    await _req(`/repos/${owner}/${repo}`);
    save();
    return {user, owner, repo};
  }

  // Read a file from the repo (returns text + sha for editing)
  async function readFile(path, branch){
    const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
    const j = await _req(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${ref}`);
    const text = atob(j.content.replace(/\n/g,''));
    return {text, sha:j.sha, path:j.path};
  }

  // Write/update a file. If branch missing, defaults to main.
  async function writeFile(path, newContent, message, branch){
    let sha=null;
    try{ const cur = await readFile(path, branch); sha = cur.sha; }catch(e){}
    const body = {
      message: message || 'KAI: update '+path,
      content: btoa(unescape(encodeURIComponent(newContent))),
      branch: branch || 'main'
    };
    if(sha) body.sha = sha;
    return _req(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
      method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
  }

  // Create a new branch (off main HEAD)
  async function makeBranch(name){
    // Try 'main' first, fall back to 'master'
    let baseRef = null;
    try{ baseRef = await _req(`/repos/${owner}/${repo}/git/ref/heads/main`); }
    catch(e){ baseRef = await _req(`/repos/${owner}/${repo}/git/ref/heads/master`); }
    return _req(`/repos/${owner}/${repo}/git/refs`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ref:`refs/heads/${name}`, sha: baseRef.object.sha})
    });
  }

  // Open a Pull Request from a branch back to main
  async function openPR(branch, title, body){
    // Try main first, fall back to master
    try{
      return await _req(`/repos/${owner}/${repo}/pulls`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({title, head:branch, base:'main', body: body||''})
      });
    }catch(e){
      return _req(`/repos/${owner}/${repo}/pulls`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({title, head:branch, base:'master', body: body||''})
      });
    }
  }

  // Latest CI build status (so KAI knows when his changes built)
  async function latestRun(){
    const j = await _req(`/repos/${owner}/${repo}/actions/runs?per_page=1`);
    const r = j.workflow_runs && j.workflow_runs[0];
    return r ? {id:r.id, status:r.status, conclusion:r.conclusion, html:r.html_url} : null;
  }

  load();
  return { connect, clear, isConnected, info, readFile, writeFile, makeBranch, openPR, latestRun };
})();
