// KAI background — wakes up periodically to think/check/notify.
// Two modes:
//   (1) FOREGROUND TICK: while the app is open, setInterval runs every N minutes.
//   (2) BACKGROUND (via Cordova local-notification plugin): scheduled notifications
//       that wake KAI's worker even when the app is closed.
window.KaiBackground = (function(){
  let intervalMs = 15*60*1000; // default: every 15 min
  let timer = null;
  let running = false;
  let onTick = null;

  function notifyPermission(){
    return new Promise(resolve=>{
      if(!('Notification' in window)) return resolve('unsupported');
      if(Notification.permission==='granted') return resolve('granted');
      Notification.requestPermission().then(p=>resolve(p));
    });
  }
  async function notify(title, body, data){
    // Prefer Cordova local notifications if available (works when app is closed)
    try{
      if(window.cordova && window.cordova.plugins && window.cordova.plugins.notification){
        window.cordova.plugins.notification.local.schedule({
          title: title||'KAI',
          text: body||'',
          smallIcon: 'res://icon',
          data: data||{}
        });
        return true;
      }
    }catch(e){}
    // Fall back to Web Notification (only works when browser/webview alive)
    if('Notification' in window && Notification.permission==='granted'){
      try{ new Notification(title||'KAI',{body:body||''}); return true; }catch(e){}
    }
    return false;
  }

  async function tick(){
    if(running || !onTick) return;
    running=true;
    try{ await onTick(); }catch(e){ console.warn('tick err',e); }
    finally{ running=false; }
  }
  function start(intervalMinutes, handler){
    if(intervalMinutes) intervalMs = intervalMinutes*60*1000;
    onTick = handler;
    if(timer) clearInterval(timer);
    timer = setInterval(tick, intervalMs);
    try{ localStorage.setItem('kai_bg_on','1'); }catch(e){}
    return true;
  }
  function stop(){
    if(timer){ clearInterval(timer); timer=null; }
    try{ localStorage.setItem('kai_bg_on','0'); }catch(e){}
  }
  function status(){ return { on: !!timer, intervalMs }; }
  function setInterval_(min){ intervalMs = Math.max(5,min)*60*1000; if(timer){ clearInterval(timer); timer=setInterval(tick,intervalMs); } }

  return { notifyPermission, notify, start, stop, status, setInterval: setInterval_, tick };
})();
