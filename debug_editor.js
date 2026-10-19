const fs=require('fs'); const {JSDOM}=require('jsdom');
const html=fs.readFileSync('editor/index.html','utf8'); const appJs=fs.readFileSync('editor/app.js','utf8');
const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://localhost/editor/'});
const {window}=dom; window.fetch=async()=>({ok:true,json:async()=>({}),text:async()=>''});
Object.defineProperty(window.navigator,'clipboard',{value:{writeText:async()=>{}},configurable:true});
window.eval(appJs); window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
setTimeout(()=>{
  const $=id=>window.document.getElementById(id);
  // add own capture+document-level probes to see ordering
  window.document.addEventListener('click',(e)=>console.log('DOC listener sees target id=', e.target.id, 'hidden before?'), true);
  $('publishMenu').addEventListener('transitionend',()=>{});
  const before = $('publishMenu').classList.contains('hidden');
  $('btnPublish').dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true}));
  const after = $('publishMenu').classList.contains('hidden');
  console.log('before hidden:', before, 'after hidden:', after);
},100);
