const fs = require('fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('editor/index.html', 'utf8');
const appJs = fs.readFileSync('editor/app.js', 'utf8');

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/editor/' });
const { window } = dom;
const calls = [];
let clip = '';
Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async t => { clip = t; } }, configurable: true });
window.open = (u) => { calls.push({ u: 'OPEN ' + u }); return { close(){}, location:{} }; };

// мок GitHub gist API для загрузки промптов + DeepSeek API
const GIST_MD = '# Тестовый промпт из Gist\nДелай задания.';
window.fetch = async (u, o = {}) => {
  const url = String(u);
  calls.push({ u: url, m: o.method || 'GET', body: o.body });
  if (url.includes('api.github.com/gists/e837aa6949f0b20dee3925983ba2f424')) {
    return { ok: true, json: async () => ({ files: { 'gistfile1.md': { filename: 'gistfile1.md', raw_url: 'https://gist.githubusercontent.com/raw/md' } } }) };
  }
  if (url.includes('api.github.com/gists/61c8a72e42d33dbdccf81d42cfda87f2')) {
    return { ok: true, json: async () => ({ files: { 'p.md': { filename: 'p.md', raw_url: 'https://gist.githubusercontent.com/raw/pmd' } } }) };
  }
  if (url === 'https://gist.githubusercontent.com/raw/md') return { ok: true, text: async () => GIST_MD };
  if (url === 'https://gist.githubusercontent.com/raw/pmd') return { ok: true, text: async () => '# Промпт предложений' };
  if (url.includes('api.deepseek.com/chat/completions')) {
    const body = JSON.parse(o.body);
    // имитируем НЕполный ответ в первом запросе (без маркера и без закрытия), полный — во втором
    const isFollowUp = body.messages.some(m => m.role === 'user' && m.content.includes('Задание ещё не готово'));
    // неполный ответ: закрытие </readingTest> есть, но финального блока (маркера) нет
    const content = isFollowUp
      ? '<readingTest><topicName>T</topicName><fragment timeExcellent="60" timeGood="90"><text>Абзац два.</text><questions></questions></fragment></readingTest>\n[RE:AD-TEST-READY]'
      : '<readingTest><topicName>T</topicName><fragment timeExcellent="60" timeGood="90"><text>Абзац один.</text><questions></questions></fragment></readingTest>';
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  }
  return { ok: true, json: async () => ({}), text: async () => '' };
};

window.eval(appJs);
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

setTimeout(async () => {
  const $ = id => window.document.getElementById(id);
  let fails = 0;
  const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ': ' + name); if (!cond) fails++; };

  await new Promise(r => setTimeout(r, 100));

  // 1. Промпты загружены с Gist и показаны под окном XML
  check('prompt text loaded from Gist into prompt panel', $('promptText').textContent.includes('Тестовый промпт из Gist'));
  check('status shows prompts loaded', $('statusText').textContent.includes('промпты загружены'));

  // 2. Переключение режима показывает другой промпт + ссылка на Gist
  $('btnModeProposals').click();
  check('mode switch changes prompt', $('promptText').textContent.includes('Промпт предложений'));
  check('prompt gist link set', $('promptGistLink').href.includes('61c8a72e42d33dbdccf81d42cfda87f2'));
  $('btnModeParagraphs').click();
  check('paragraphs gist link set', $('promptGistLink').href.includes('e837aa6949f0b20dee3925983ba2f424'));

  // 3. Без токена: копируется промпт+XML и открывается чат
  $('deepseekToken').value = '';
  $('xmlEditor').value = '<readingTest><topicName>Тема</topicName></readingTest>';
  $('btnAskDeepSeek').click();
  await new Promise(r => setTimeout(r, 50));
  check('no-token copies gist prompt + xml', clip.includes('Тестовый промпт из Gist') && clip.includes('<readingTest>') && clip.includes('[RE:AD-TEST-READY]'));
  check('no-token opens chat.deepseek.com', calls.some(c => c.u === 'OPEN https://chat.deepseek.com/'));

  // 4. С токеном: отправка промпта из Gist + XML; допрос до полного XML; результат в окно XML
  $('deepseekToken').value = 'sk-test';
  calls.length = 0;
  $('btnAskDeepSeek').click();
  await new Promise(r => setTimeout(r, 1500));
  const dsCalls = calls.filter(c => c.u.includes('api.deepseek.com'));
  check('deepseek called twice (continuation logic)', dsCalls.length === 2);
  const firstBody = JSON.parse(dsCalls[0].body);
  check('sent message contains gist prompt', firstBody.messages[0].content.includes('Тестовый промпт из Gist'));
  check('sent message contains technical reqs + marker', firstBody.messages[0].content.includes('[RE:AD-TEST-READY]'));
  check('sent message contains XML from panel', firstBody.messages[0].content.includes('Тема'));
  if (dsCalls.length > 1) {
    const secondBody = JSON.parse(dsCalls[1].body);
    check('continuation request asks to finish', secondBody.messages.some(m => m.content.includes('Задание ещё не готово')));
  } else {
    console.log('SKIP: continuation request (single-response mode)');
  }
  check('result XML placed back into XML window', $('xmlEditor').value.includes('Абзац два') && $('xmlEditor').value.includes('</readingTest>'));
  check('final status ok', $('statusText').textContent.includes('ответ получен'));

  // 5. copyPrompt копирует активный (gist) промпт
  clip = '';
  $('btnCopyPrompt').click();
  await new Promise(r => setTimeout(r, 50));
  check('copyPrompt copies active gist prompt', clip.includes('Тестовый промпт из Gist'));

  console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILURES');
  process.exit(fails === 0 ? 0 : 1);
}, 150);
