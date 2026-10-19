const fs=require('fs');const {JSDOM}=require('jsdom');
const html=fs.readFileSync('editor/index.html','utf8');const appJs=fs.readFileSync('editor/app.js','utf8');
const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://localhost/editor/'});
const {window}=dom; const dsCalls=[];
const PART1='<readingTest><topicName>T</topicName><fragment timeExcellent="60" timeGood="90"><text>AB1</text><questions></questions></fragment></readingTest>';
const PART2='<readingTest><topicName>T</topicName><fragment timeExcellent="60" timeGood="90"><text>AB2</text><questions></questions></fragment></readingTest>\n[RE:AD-TEST-READY]';
window.fetch=async(u,o={})=>{const url=String(u);
 if(url.includes('api.github.com/gists/'))return{ok:true,json:async()=>({files:{'f.md':{filename:'f.md',raw_url:'RAW:'+url.slice(-6)}}})};
 if(url.startsWith('RAW:'))return{ok:true,text:async()=>'GIST PROMPT '+url};
 if(url.includes('api.deepseek.com')){dsCalls.push(JSON.parse(o.body));
   const isFollow=dsCalls[dsCalls.length-1].messages.some(m=>m.role==='user'&&m.content.indexOf('не готово')>=0);
   return{ok:true,json:async()=>({choices:[{message:{content:isFollow?PART2:PART1}}]})};}
 return{ok:true,json:async()=>({}),text:async()=>''};};
window.eval(appJs);window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
setTimeout(async()=>{
 const $=id=>window.document.getElementById(id);
 $('deepseekToken').value='sk-test';
 $('xmlEditor').value='<readingTest><topicName>Тема</topicName></readingTest>';
 $('btnAskDeepSeek').click();
 await new Promise(r=>setTimeout(r,300));
 console.log('DS calls:',dsCalls.length);
 dsCalls.forEach((c,i)=>console.log('call',i,'roles:',c.messages.map(m=>m.role).join(','),'| last user snippet:',(c.messages.filter(m=>m.role==='user').pop().content||'').slice(0,60).replace(/\n/g,' ')));
 await new Promise(r=>setTimeout(r,2500));
 console.log('FINAL DS calls:',dsCalls.length);
 console.log('XML final:',JSON.stringify($('xmlEditor').value.slice(0,120)));
},300);
