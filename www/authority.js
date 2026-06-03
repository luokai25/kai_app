// KAI Authority — risky tool calls require approval before execution.
window.KaiAuthority = (function(){
  const RISKY = new Set(['github_propose_fix','open_app','dial','run_code']);
  const KEY='kai_auto_approve_v1';
  let autoApprove = {};
  try{ autoApprove = JSON.parse(localStorage.getItem(KEY)||'{}'); }catch(e){}
  function setAuto(tool, val){ autoApprove[tool]=val; try{localStorage.setItem(KEY,JSON.stringify(autoApprove));}catch(e){} }
  function isRisky(t){ return RISKY.has(t); }
  function needsApproval(t){ return RISKY.has(t) && !autoApprove[t]; }
  function autoApproved(t){ return !!autoApprove[t]; }
  function listAutoApproved(){ return Object.keys(autoApprove).filter(k=>autoApprove[k]); }
  // Approval flow: returns a promise that resolves true/false based on user tap
  function requestApproval(tool, args){
    return new Promise(resolve=>{
      // Create a modal inline in the chat
      const id='auth_'+Date.now();
      const el=document.createElement('div');
      el.className='msg kai';
      el.style.background='#3a2a1a';
      el.innerHTML='<div class="who" style="color:#ffd96b">KAI wants to use a tool</div>'
        +'<b>'+tool+'</b><br><span style="font-size:12px;color:#bbb">'+(JSON.stringify(args).slice(0,200))+'</span><br><br>'
        +'<button id="ap_'+id+'" class="tm-btn" style="margin-right:6px">Approve</button>'
        +'<button id="dn_'+id+'" class="tm-btn">Deny</button>'
        +'<label style="font-size:11px;color:#888;display:block;margin-top:8px"><input type="checkbox" id="ax_'+id+'"> Always allow '+tool+'</label>';
      const chat=document.getElementById('chat');
      if(chat){ chat.appendChild(el); chat.scrollTop=chat.scrollHeight; }
      document.getElementById('ap_'+id).onclick=()=>{
        if(document.getElementById('ax_'+id).checked) setAuto(tool,true);
        el.style.opacity='0.6'; el.innerHTML+='<br><i>approved</i>'; resolve(true);
      };
      document.getElementById('dn_'+id).onclick=()=>{ el.style.opacity='0.6'; el.innerHTML+='<br><i>denied</i>'; resolve(false); };
    });
  }
  return { isRisky, needsApproval, requestApproval, setAuto, autoApproved, listAutoApproved };
})();
