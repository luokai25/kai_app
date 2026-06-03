// Voice — talk to KAI, he talks back. Uses Web Speech API (works on most Android WebViews
// with RECORD_AUDIO permission). Degrades gracefully if unavailable.
window.KaiSpeech = (function(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec=null, listening=false, voiceOn=false;

  function available(){ return !!SR; }
  function speakAvailable(){ return 'speechSynthesis' in window; }

  function speak(text){
    if(!voiceOn || !speakAvailable() || !text) return;
    try{
      const u=new SpeechSynthesisUtterance(text.replace(/[<>]/g,''));
      u.rate=1.02; u.pitch=1;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    }catch(e){}
  }

  function listen(onResult){
    if(!SR){ onResult(null,'Voice input is not available on this device.'); return; }
    if(listening){ rec&&rec.stop(); return; }
    rec=new SR(); rec.lang='en-US'; rec.interimResults=false; rec.maxAlternatives=1;
    listening=true;
    rec.onresult=e=>{ const t=e.results[0][0].transcript; onResult(t); };
    rec.onerror=e=>{ onResult(null,'Mic error: '+e.error); };
    rec.onend=()=>{ listening=false; };
    try{ rec.start(); }catch(e){ listening=false; onResult(null,'Could not start mic.'); }
  }

  function toggleVoiceOut(){ voiceOn=!voiceOn; return voiceOn; }
  function isVoiceOut(){ return voiceOn; }
  function isListening(){ return listening; }

  return { available, speakAvailable, speak, listen, toggleVoiceOut, isVoiceOut, isListening };
})();
