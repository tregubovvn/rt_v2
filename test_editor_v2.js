/* Интеграционный тест новой версии редактора (jsdom) */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'editor/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, 'editor/app.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name); }
}

async function main() {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/editor/', pretendToBeVisual: true });
    const { window } = dom;

    // --- mock fetch ---
    const fetchCalls = [];
    window.fetch = async (url, opts = {}) => {
        fetchCalls.push({ url, opts });
        const u = String(url);
        if (u.includes('api.deepseek.com')) {
            return { ok: true, json: async () => ({ choices: [{ message: { content: '```xml\n<readingTest><topicName>AI Тема</topicName><fragment timeExcellent="30" timeGood="45"><text>Новый абзац</text><questions><question type="input"><text>В?</text><answer>О</answer></question></questions></fragment></readingTest>\n```' } }] }) };
        }
        if (u === 'https://api.github.com/gists' && opts.method === 'POST') {
            return { ok: true, json: async () => ({ id: 'abc123', html_url: 'https://gist.github.com/u/abc123', files: { 'reading_test.xml': { raw_url: 'https://gist.githubusercontent.com/u/abc123/raw/reading_test.xml' } } }) };
        }
        if (u.includes('gitverse.ru/api/v2/user/repos')) {
            return { ok: true, json: async () => ([{ path: 'user/reading-tests' }]) };
        }
        if (u.includes('/contents/') && opts.method !== 'PUT') {
            return { ok: false, status: 404, text: async () => 'not found' };
        }
        if (u.includes('/contents/')) {
            return { ok: true, json: async () => ({}) };
        }
        return { ok: true, json: async () => ({}) };
    };
    // clipboard / open mocks
    let copiedText = '';
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (t) => { copiedText = t; } }, configurable: true });
    const openedUrls = [];
    window.open = (u) => { openedUrls.push(u); return { close() {}, location: {} }; };

    // localStorage exists in jsdom. Run script.
    window.eval(appJs);
    await new Promise(r => setTimeout(r, 50)); // DOMContentLoaded already fired? JSDOM fires it on parse; eval after load means listener won't fire — call manually:
    // Dispatch init manually since document is ready before eval
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await new Promise(r => setTimeout(r, 50));

    const doc = window.document;
    const $ = (id) => doc.getElementById(id);
    const S = window.editorState.state;

    // 1. Discipline field exists and goes to XML
    $('discipline').value = 'Программная инженерия';
    $('discipline').dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    check('discipline в XML', $('xmlEditor').value.includes('<discipline>Программная инженерия</discipline>'));

    // round-trip: applyXml parses discipline back
    $('author').value = 'Иванов И.И.';
    $('author').dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    $('btnApplyXml').click();
    check('discipline парсится из XML', S.meta.discipline === 'Программная инженерия' && S.meta.author === 'Иванов И.И.');

    // 2. Автосохранение -> на диск (download), НЕ на сервисы
    $('autoSaveToggle').checked = true;
    $('saveInterval').value = '100';
    fetchCalls.length = 0;
    // trigger change via fragment text
    $('fragmentText').value = 'Текст для автосохранения';
    $('fragmentText').dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    const apiCalls = fetchCalls.filter(c => /api\.(github|deepseek)|gitverse/.test(c.url));
    check('автосохранение не дёргает сервисы', apiCalls.length === 0);
    check('автосохранение пишет на диск (статус)', $('statusText').textContent.includes('диск'));

    // 3. Публикация Gist возвращает ссылку и копирует её
    $('githubToken').value = 'ghp_test';
    fetchCalls.length = 0; copiedText = '';
    $('btnPublish').dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
    check('меню публикации открыто', !$('publishMenu').classList.contains('hidden'));
    $('btnPublishGist').click();
    await new Promise(r => setTimeout(r, 100));
    const gistPost = fetchCalls.find(c => c.url === 'https://api.github.com/gists' && c.opts.method === 'POST');
    check('публикация создаёт gist', !!gistPost);
    check('ссылка на задание скопирована', copiedText.includes('index.html?file=') && copiedText.includes(encodeURIComponent('raw')) || copiedText.includes('?file='));
    check('меню закрыто после публикации', $('publishMenu').classList.contains('hidden'));

    // 4. DeepSeek без токена: копирует текст+промпт и открывает чат
    $('deepseekToken').value = '';
    copiedText = ''; openedUrls.length = 0;
    $('btnAskDeepSeek').dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
    await new Promise(r => setTimeout(r, 50));
    check('без токена промпт+XML скопированы', copiedText.includes('режиме АБЗАЦЕВ') && copiedText.includes('<readingTest'));
    check('без токена открыт чат deepseek', openedUrls.some(u => u.includes('chat.deepseek.com')));

    // 5. DeepSeek с токеном, режим предложений: результат XML возвращается в панель и применяется
    $('deepseekToken').value = 'sk-test';
    $('btnDsProposals').click();
    await new Promise(r => setTimeout(r, 200));
    const dsCall = fetchCalls.find(c => c.url.includes('api.deepseek.com'));
    check('deepseek вызван с промптом предложений', dsCall && dsCall.opts.body.includes('ПРЕДЛОЖЕНИЙ') && dsCall.opts.body.includes('<readingTest'));
    check('результат вернулся в XML-панель', $('xmlEditor').value.includes('AI Тема'));
    check('результат применён к редактору', S.testData.topicName === 'AI Тема' && S.testData.fragments[0].text === 'Новый абзац');

    // 6. Кнопки "Промпт" копируют промпты
    copiedText = '';
    $('btnPromptParagraphs').click();
    await new Promise(r => setTimeout(r, 50));
    check('промпт абзацев копируется', copiedText.includes('АБЗАЦЕВ'));
    copiedText = '';
    $('btnPromptProposal').click();
    await new Promise(r => setTimeout(r, 50));
    check('промпт предложений копируется', copiedText.includes('ПРЕДЛОЖЕНИЙ'));

    // 7. GitVerse публикация по кнопке
    $('gitverseToken').value = 'gv-token';
    
    fetchCalls.length = 0; copiedText = '';
    $('btnPublishGitverse').click();
    await new Promise(r => setTimeout(r, 200));
    const gvPost = fetchCalls.find(c => c.url.includes('gitverse.ru') && (c.opts.method === 'POST' || c.opts.method === 'PUT'));
    check('gitverse коммит выполнен', !!gvPost);
    check('gitverse вернул ссылку на задание', copiedText.includes('?file=') && copiedText.includes('gitverse.ru'));

    // 8. Меню DeepSeek открывается по стрелке
    $('btnAskDeepSeek').dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
    check('меню deepseek открыто', !$('deepseekMenu').classList.contains('hidden'));

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
