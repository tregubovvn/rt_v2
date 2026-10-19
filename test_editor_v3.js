const fs = require('fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('editor/index.html', 'utf8');
const appJs = fs.readFileSync('editor/app.js', 'utf8');

let pass = 0, fail = 0;
function t(name, cond) { if (cond) { pass++; console.log('PASS:', name); } else { fail++; console.log('FAIL:', name); } }

// ---- fetch mock ----
const gistContent = {
  'e837aa6949f0b20dee3925983ba2f424': 'PROMPT-PARAGRAPHS-FROM-GIST',
  '61c8a72e42d33dbdccf81d42cfda87f2': 'PROMPT-PROPOSALS-FROM-GIST',
};
const fetchLog = [];
let dsResponses = [];
const fetchMock = async (url, opts) => {
  fetchLog.push({ url: String(url), opts });
  if (String(url).includes('api.github.com/gists/')) {
    const id = String(url).split('/').pop();
    return { ok: true, status: 200, json: async () => ({ files: { 'p.md': { filename: 'p.md', raw_url: 'https://raw.gist/' + id } } }) };
  }
  if (String(url).includes('raw.gist/')) {
    const id = String(url).split('/').pop();
    return { ok: true, status: 200, text: async () => gistContent[id] || '' };
  }
  if (String(url).includes('api.deepseek.com')) {
    const r = dsResponses.shift();
    return r ? { ok: true, status: 200, json: async () => r } : { ok: false, status: 500, json: async () => ({ error: { message: 'mock err' } }) };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};

// ---- File System Access API mock ----
const writtenFiles = [];
function makeHandle(name) {
  return {
    name,
    createWritable: () => {
      let data = '';
      return { write: async (c) => { data += c; }, close: async () => { writtenFiles.push({ name, content: data }); } };
    },
  };
}
let pickerCalls = 0;

const dom = new JSDOM(html, { url: 'http://localhost/editor/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window: w } = dom;
w.fetch = fetchMock;
w.showSaveFilePicker = async () => { pickerCalls++; return makeHandle('chosen_task.xml'); };
w.confirm = (msg) => { w.__confirmMsg = msg; return w.__confirmAnswer !== false; };
w.open = () => {};
Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (txt) => { w.__clip = txt; } } });

w.eval(appJs);
w.document.dispatchEvent(new w.Event('DOMContentLoaded'));

const api = w.editorState.api;
const state = w.editorState.state;

(async () => {
  await new Promise(r => setTimeout(r, 100)); // loadPromptsFromGists async

  // 1. Промпты загружаются из Gist
  t('prompts loaded from Gist (paragraphs)', state.dsPrompts.paragraphs === 'PROMPT-PARAGRAPHS-FROM-GIST');
  t('prompts loaded from Gist (proposals)', state.dsPrompts.proposals === 'PROMPT-PROPOSALS-FROM-GIST');
  t('no hardcoded fallback prompts in source', !appJs.includes('Работай с XML-заданием ниже в режиме АБЗАЦЕВ'));

  // 2. Автосохранение БЕЗ выбранного файла ничего не скачивает
  let anchorClicks = 0;
  w.HTMLAnchorElement.prototype.click = function () { anchorClicks++; };
  if (state.autoSaveTimeout) clearTimeout(state.autoSaveTimeout);
  w.document.getElementById('autoSaveToggle').checked = true;
  api.parseXmlToData('<readingTest><topicName>T</topicName><fragment><timeExcellent>60</timeExcellent><timeGood>90</timeGood><text>abc</text></fragment></readingTest>');
  w.document.getElementById('fragmentText').value = 'changed text';
  w.document.getElementById('fragmentText').dispatchEvent(new w.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 1900));
  t('autosave without file handle does NOT download', anchorClicks === 0 && pickerCalls === 0);
  t('autosave without file handle keeps dirty', state.dirty === true);
  t('status asks to choose a file', /Сохранить в файл/.test(w.document.getElementById('statusText').textContent));

  // 3. saveToFile через showSaveFilePicker запоминаает handle и пишет в файл
  await api.saveToFile();
  await new Promise(r => setTimeout(r, 10));
  t('showSaveFilePicker used', pickerCalls === 1);
  t('file handle remembered', !!state.fileHandle && state.fileHandle.name === 'chosen_task.xml');
  t('content written to disk file', writtenFiles.some(f => f.name === 'chosen_task.xml' && f.content.includes('changed text')));
  t('dirty cleared after save', state.dirty === false);

  // 4. Теперь автосохранение пишет в тот же файл без диалога
  const pickerCallsAfter = pickerCalls;
  w.document.getElementById('fragmentText').value = 'auto saved text';
  w.document.getElementById('fragmentText').dispatchEvent(new w.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 1900));
  t('autosave writes silently to chosen file', pickerCalls === pickerCallsAfter && writtenFiles.some(f => f.content.includes('auto saved text')));
  t('autosave clears dirty', state.dirty === false);

  // 5. applyXmlChanges спрашивает про сохранение и пишет в выбранный файл
  w.__confirmAnswer = true;
  w.__confirmMsg = null;
  w.document.getElementById('xmlEditor').value = '<readingTest><topicName>Applied</topicName><fragment><timeExcellent>50</timeExcellent><timeGood>80</timeGood><text>applied xml</text></fragment></readingTest>';
  w.document.getElementById('btnApplyXml').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));
  t('apply asks about saving to file', typeof w.__confirmMsg === 'string' && /Сохранить задание в файл/.test(w.__confirmMsg));
  t('after apply+confirm saved into chosen file (no new dialog)', writtenFiles.some(f => f.content.includes('Applied')));
  t('picker not reopened for known file', pickerCalls === pickerCallsAfter);
  t('editor got applied topic', w.document.getElementById('topicName').value === 'Applied');

  // Отказ от сохранения — изменения остаются, файл не перезаписан новым содержимым
  w.__confirmAnswer = false;
  w.__confirmMsg = null;
  w.document.getElementById('xmlEditor').value = '<readingTest><topicName>Declined</topicName><fragment><timeExcellent>50</timeExcellent><timeGood>80</timeGood><text>x</text></fragment></readingTest>';
  w.document.getElementById('btnApplyXml').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));
  t('declined save keeps dirty and does not write', state.dirty === true && !writtenFiles.some(f => f.content.includes('Declined')));

  // 6. DeepSeek: блокировка интерфейса + прогресс + результат в XML
  const fullXml = '<readingTest><topicName>AI Topic</topicName><fragment><timeExcellent>60</timeExcellent><timeGood>90</timeGood><text>ai text</text></fragment></readingTest>';
  dsResponses = [{ choices: [{ message: { content: fullXml + '\n[RE:AD-TEST-READY]' } }] }];
  w.document.getElementById('deepseekToken').value = 'sk-test';
  let resolveDs;                       // подвешиваем fetch, чтобы поймать состояние «во время запроса»
  const dsGate = new Promise(r => { resolveDs = r; });
  const origFetch = w.fetch;
  w.fetch = async (u, o) => { const res = await origFetch(u, o); if (String(u).includes('api.deepseek.com')) await dsGate; return res; };
  const dsStarted = api.askDeepSeek('paragraphs');
  await new Promise(r => setTimeout(r, 5));
  t('overlay present during DeepSeek request', !!w.document.getElementById('aiOverlay'));
  t('body class ai-busy during request', w.document.body.classList.contains('ai-busy'));
  t('save button disabled while busy', w.document.getElementById('btnSaveFile').disabled === true);
  t('progress shown in status', /DeepSeek/i.test(w.document.getElementById('statusText').textContent));
  resolveDs();
  await dsStarted;
  w.fetch = origFetch;
  t('overlay removed after response', !w.document.getElementById('aiOverlay') && !w.document.body.classList.contains('ai-busy'));
  t('buttons re-enabled', w.document.getElementById('btnSaveFile').disabled === false);
  t('DeepSeek XML returned into XML panel', w.document.getElementById('xmlEditor').value.includes('AI Topic'));
  t('DeepSeek result applied to editor', w.document.getElementById('topicName').value === 'AI Topic');
  t('deepseek called with gist prompt text', fetchLog.some(f => f.url.includes('api.deepseek.com') && String(f.opts && f.opts.body).includes('PROMPT-PARAGRAPHS-FROM-GIST')));
  t('result marked dirty for autosave', state.dirty === true);

  // 7. Пустой промпт -> не блокирует, подсказка загрузить
  state.dsPrompts.paragraphs = '';
  await api.askDeepSeek('paragraphs');
  t('empty prompt does not block UI', !w.document.body.classList.contains('ai-busy'));

  // 8. Без токена — копирование + открытие чата (без блокировки)
  w.document.getElementById('deepseekToken').value = '';
  state.dsPrompts.paragraphs = 'some prompt';
  await api.askDeepSeek('paragraphs');
  t('no-token path copies payload', (w.__clip || '').includes('some prompt') && (w.__clip || '').includes('readingTest'));

  console.log('\nRESULT: pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
