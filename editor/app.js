'use strict';

/* =========================================================================
   Reading Test Editor — логика приложения
   Структура: XML-панель слева, редактор справа, настройки в модальном окне.
   ========================================================================= */

// --- Константы ---
const AUTOSAVE_DEBOUNCE_MS = 1500;      // задержка автосохранения после изменений
const DEFAULT_TIME_EXCELLENT = 60;
const DEFAULT_TIME_GOOD = 90;
const TASK_APP_BASE_URL = 'https://tregubovvn.github.io/rt/index.html';
const GITVERSE_API = 'https://gitverse.ru/api/v2';
const GIST_FILENAME = 'reading_test.xml';

// Ключи localStorage
const LS = {
    ghToken: 'gh_token',
    dsToken: 'ds_token',
    gvToken: 'gv_token',
    autoSave: 'editor_autosave_enabled',
    meta: 'editor_meta_json',          // author / university / discipline / audience
    dsMode: 'editor_deepseek_mode',    // paragraphs | proposals
};

// --- Состояние ---
const state = {
    testData: { topicName: '', fragments: [] },
    meta: { author: '', university: '', discipline: '', audience: '' },
    currentFragmentIndex: 0,
    gistId: null,
    gistUrl: null,
    rawUrl: null,
    gistFilename: GIST_FILENAME,
    // Активные промпты DeepSeek (по режимам). Резервные тексты на случай,
    // если загрузка с GitHub Gist не удалась; затем перезаписываются Gist-промптами.
    dsPrompts: {
        paragraphs: 'Работай с XML-заданием ниже в режиме АБЗАЦЕВ: улучши/сгенерируй тексты фрагментов (<text> внутри <fragment>), сохраняя структуру XML, количество и содержимое вопросов неизменными.',
        proposals: 'Работай с XML-заданием ниже в режиме ПРЕДЛОЖЕНИЙ: проверь/улучши вопросы и предложения (question/options/answer) на основе текстов фрагментов, сохраняя структуру XML.',
    },
    dirty: false,               // есть несохранённые изменения
    isSaving: false,
    needsAnotherSave: false,
    skipNextAutoSave: false,
    syncTimeout: null,
    autoSaveTimeout: null,
    fileHandle: null,           // FileSystemFileHandle для автосохранения на диск
};

// Отладочный доступ к состоянию из консоли браузера (window.editorState.state)
window.editorState = { state, api: {} };

let els = {};                   // кэш ссылок на DOM-элементы

// --- Инициализация ---
document.addEventListener('DOMContentLoaded', () => {
    cacheElements();
    loadSettings();
    parseXmlToData(els.xmlEditor.value);
    renderAll();
    updateXmlOutput({ immediate: true });
    renderModeSwitch();
    initResizer();
    bindEvents();
    // Отладочный доступ к функциям (все объявления подняты — можно ссылаться)
    Object.assign(window.editorState.api, {
        publishToGist, publishToGitverse, saveToFile, askDeepSeek, setDsMode, currentDsMode,
        generateXml, parseXmlToData, loadPromptsFromGists, buildDsPrompt, PROMPT_GIST_URLS,
    });
    loadPromptsFromGists();   // подгружаем тексты промптов с GitHub Gist
});

function cacheElements() {
    const ids = [
        'topicName', 'author', 'university', 'audience', 'discipline',
        'xmlEditor', 'xmlPanel', 'resizer', 'editorContainer',
        'fragmentCard', 'fragmentNumber', 'timeExcellent', 'timeGood', 'fragmentText',
        'questionsContainer', 'fragmentTabs', 'prevBtn', 'nextBtn',
        'statusText', 'toast', 'gistLinkContainer', 'gistLinkText',
        'loadModal', 'loadGistId', 'settingsModal',
        'autoSaveToggle', 'saveInterval', 'autoSaveFolderName',
        'publishMenu', 'promptBar', 'promptText',
        'btnModeProposals', 'btnModeParagraphs', 'btnCopyPrompt',
    ];
    els = {};
    ids.forEach(id => { els[id] = document.getElementById(id); });
}

function bindEvents() {
    // Верхняя панель
    on('btnPublishGist', 'click', () => { hidePublishMenu(); publishToGist(); });
    on('btnPublishGitverse', 'click', () => { hidePublishMenu(); publishToGitverse(); });
    on('btnLoadGist', 'click', showLoadModal);
    on('btnSaveFile', 'click', saveToFile);
    on('btnPublish', 'click', (e) => { e.stopPropagation(); toggleMenu(els.publishMenu, null); });
    on('btnSettings', 'click', showSettingsModal);
    on('btnCopyGistUrl', 'click', copyGistUrl);
    on('btnOpenTask', 'click', openTask);
    on('btnCopyXml', 'click', copyXml);
    on('btnApplyXml', 'click', applyXmlChanges);
    on('btnAskDeepSeek', 'click', () => askDeepSeek(currentDsMode()));
    on('btnPickAutoSaveFile', 'click', pickAutoSaveFile);

    // Панель промпта под окном XML: выбор режима и копирование активного промпта
    els.btnModeProposals.addEventListener('click', () => setDsMode('proposals'));
    els.btnModeParagraphs.addEventListener('click', () => setDsMode('paragraphs'));
    on('btnCopyPrompt', 'click', () => copyPrompt(currentDsMode()));

    // Редактор фрагмента
    els.timeExcellent.addEventListener('input', updateFragmentFromInputs);
    els.timeGood.addEventListener('input', updateFragmentFromInputs);
    els.fragmentText.addEventListener('input', updateFragmentFromInputs);
    on('prevBtn', 'click', prevFragment);
    on('nextBtn', 'click', nextFragment);
    on('btnAddFragment', 'click', addFragment);
    on('btnDeleteFragment', 'click', deleteCurrentFragment);
    on('btnAddChoiceQuestion', 'click', () => addQuestion('choice'));
    on('btnAddInputQuestion', 'click', () => addQuestion('input'));

    // XML-панель (ручное редактирование)
    els.xmlEditor.addEventListener('input', scheduleAutoSave);

    // Модальные окна
    on('btnLoadCancel', 'click', hideLoadModal);
    on('btnLoadConfirm', 'click', loadFromGist);
    els.loadModal.addEventListener('click', (e) => { if (e.target === els.loadModal) hideLoadModal(); });
    on('btnSettingsClose', 'click', hideSettingsModal);
    on('btnSettingsDone', 'click', hideSettingsModal);
    els.settingsModal.addEventListener('click', (e) => { if (e.target === els.settingsModal) hideSettingsModal(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { hideLoadModal(); hideSettingsModal(); hidePublishMenu(); }
    });

    // Поля настроек
    ['githubToken', 'deepseekToken', 'gitverseToken'].forEach(id => {
        document.getElementById(id).addEventListener('change', saveSettings);
    });
    els.autoSaveToggle.addEventListener('change', () => { saveSettings(); setStatus(autoSaveEnabled() ? 'Автосохранение включено' : 'Автосохранение выключено'); });
    els.saveInterval.addEventListener('change', saveSettings);
    ['author', 'university', 'discipline', 'audience'].forEach(id => {
        els[id].addEventListener('input', () => { readMetaFromSettingsInputs(); updateXmlOutput(); });
    });
    els.topicName.addEventListener('input', () => {
        state.testData.topicName = els.topicName.value;
        updateXmlOutput();
    });

    // Меню публикации — закрытие по клику вне кнопок и самого меню
    document.addEventListener('click', (e) => {
        if (e.target.closest('#btnPublish') || e.target.closest('.publish-menu')) return;
        hideMenus();
    });
}

function on(id, ev, fn) { document.getElementById(id).addEventListener(ev, fn); }

// ============================================================
// Настройки (токены, автосохранение, метаданные) — в localStorage
// ============================================================
function loadSettings() {
    document.getElementById('githubToken').value = localStorage.getItem(LS.ghToken) || '';
    document.getElementById('deepseekToken').value = localStorage.getItem(LS.dsToken) || '';
    document.getElementById('gitverseToken').value = localStorage.getItem(LS.gvToken) || '';
    els.autoSaveToggle.checked = localStorage.getItem(LS.autoSave) === '1';
    els.saveInterval.value = localStorage.getItem('editor_autosave_interval') || String(AUTOSAVE_DEBOUNCE_MS);
    els.autoSaveFolderName.value = localStorage.getItem('editor_autosave_filename') || '';

    try {
        const meta = JSON.parse(localStorage.getItem(LS.meta) || '{}');
        state.meta.author = meta.author || '';
        state.meta.university = meta.university || '';
        state.meta.discipline = meta.discipline || '';
        state.meta.audience = meta.audience || '';
    } catch (e) { /* повреждённые данные — используем пустые */ }

    els.author.value = state.meta.author;
    els.university.value = state.meta.university;
    els.discipline.value = state.meta.discipline;
    els.audience.value = state.meta.audience;
}

function saveSettings() {
    localStorage.setItem(LS.ghToken, document.getElementById('githubToken').value.trim());
    localStorage.setItem(LS.dsToken, document.getElementById('deepseekToken').value.trim());
    localStorage.setItem(LS.gvToken, document.getElementById('gitverseToken').value.trim());
    localStorage.setItem(LS.autoSave, els.autoSaveToggle.checked ? '1' : '0');
    localStorage.setItem('editor_autosave_interval', els.saveInterval.value);
    localStorage.setItem('editor_autosave_filename', els.autoSaveFolderName.value.trim());
    localStorage.setItem(LS.meta, JSON.stringify(state.meta));
}

function readMetaFromSettingsInputs() {
    state.meta.author = els.author.value.trim();
    state.meta.university = els.university.value.trim();
    state.meta.discipline = els.discipline.value.trim();
    state.meta.audience = els.audience.value.trim();
    saveSettings();
}

function getGithubToken() { return document.getElementById('githubToken').value.trim(); }
function getDeepseekToken() { return document.getElementById('deepseekToken').value.trim(); }
function getGitverseToken() { return document.getElementById('gitverseToken').value.trim(); }
function autoSaveEnabled() { return els.autoSaveToggle.checked; }
function autoSaveDelayMs() { return parseInt(els.saveInterval.value, 10) || AUTOSAVE_DEBOUNCE_MS; }

// Активный режим DeepSeek (proposals | paragraphs) хранится в localStorage
function currentDsMode() { return localStorage.getItem(LS.dsMode) || 'paragraphs'; }
function setDsMode(mode) {
    localStorage.setItem(LS.dsMode, mode);
    renderModeSwitch();
}

// Подсветка активного режима и показ текста промпта в панели под окном XML
function renderModeSwitch() {
    const mode = currentDsMode();
    els.btnModeProposals.classList.toggle('active', mode === 'proposals');
    els.btnModeParagraphs.classList.toggle('active', mode === 'paragraphs');
    els.btnModeProposals.setAttribute('aria-checked', String(mode === 'proposals'));
    els.btnModeParagraphs.setAttribute('aria-checked', String(mode === 'paragraphs'));
    els.promptText.textContent = state.dsPrompts[mode] || state.dsPrompts.paragraphs;
    updatePromptGistLink(mode);
}

// Ссылка на Gist с активным промптом (рядом с текстом промпта, под окном XML)
function updatePromptGistLink(mode) {
    const link = document.getElementById('promptGistLink');
    if (!link) return;
    const url = PROMPT_GIST_URLS[mode] || '';
    link.href = url;
    link.textContent = 'Открыть промпт на GitHub Gist ↗';
}

// Полное сообщение для отправки в DeepSeek: промпт из Gist + XML из панели
function buildDsMessage(mode) {
    const base = state.dsPrompts[mode] || state.dsPrompts.paragraphs;
    const xml = els.xmlEditor.value || generateXml();
    return buildDsPrompt(base) + '\n\nXML-ЗАДАНИЕ:\n' + xml;
}

// ============================================================
// XML: парсинг и генерация
// ============================================================
function parseXmlToData(xmlString) {
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlString || '<readingTest/>', 'text/xml');
        if (doc.querySelector('parsererror')) throw new Error('Invalid XML');

        state.testData.topicName = doc.querySelector('topicName')?.textContent || '';
        els.topicName.value = state.testData.topicName;

        // Метаданные автора (если присутствуют в XML — обновляем настройки)
        const meta = {
            author: doc.querySelector('author')?.textContent || '',
            university: doc.querySelector('university')?.textContent || '',
            discipline: doc.querySelector('discipline')?.textContent || '',
            audience: doc.querySelector('targetAudience')?.textContent || '',
        };
        if (meta.author || meta.university || meta.discipline || meta.audience) {
            state.meta = meta;
            els.author.value = meta.author;
            els.university.value = meta.university;
            els.discipline.value = meta.discipline;
            els.audience.value = meta.audience;
            saveSettings();
        }

        state.testData.fragments = [];
        doc.querySelectorAll('fragment').forEach(frag => {
            const f = {
                timeExcellent: parseInt(frag.getAttribute('timeExcellent')) || DEFAULT_TIME_EXCELLENT,
                timeGood: parseInt(frag.getAttribute('timeGood')) || DEFAULT_TIME_GOOD,
                text: frag.querySelector('text')?.textContent || '',
                questions: [],
            };
            frag.querySelectorAll('question').forEach(q => {
                const qData = {
                    type: q.getAttribute('type') || 'choice',
                    text: q.querySelector('text')?.textContent || '',
                    options: [],
                    answer: '',
                };
                if (qData.type === 'choice') {
                    q.querySelectorAll('option').forEach(opt => {
                        qData.options.push({
                            text: opt.textContent,
                            correct: opt.getAttribute('correct') === 'true',
                        });
                    });
                } else {
                    qData.answer = q.querySelector('answer')?.textContent || '';
                }
                f.questions.push(qData);
            });
            state.testData.fragments.push(f);
        });
        if (!state.testData.fragments.length) {
            state.testData.fragments.push(newFragment());
        }
        return true;
    } catch (e) {
        showToast('Некорректный XML', true);
        return false;
    }
}

function generateXml() {
    const m = state.meta;
    let xml = '<readingTest>\n';
    xml += `<topicName>${escapeXml(state.testData.topicName || '')}</topicName>\n`;
    if (m.author) xml += `<author>${escapeXml(m.author)}</author>\n`;
    if (m.university) xml += `<university>${escapeXml(m.university)}</university>\n`;
    if (m.discipline) xml += `<discipline>${escapeXml(m.discipline)}</discipline>\n`;
    if (m.audience) xml += `<targetAudience>${escapeXml(m.audience)}</targetAudience>\n`;
    state.testData.fragments.forEach(frag => {
        xml += `<fragment timeExcellent="${frag.timeExcellent}" timeGood="${frag.timeGood}">\n`;
        xml += `<text>${escapeXml(frag.text)}</text>\n`;
        xml += `<questions>\n`;
        frag.questions.forEach(q => {
            xml += `<question type="${q.type}">\n`;
            xml += `<text>${escapeXml(q.text)}</text>\n`;
            if (q.type === 'choice') {
                xml += `<options>\n`;
                q.options.forEach(opt => {
                    const attr = opt.correct ? ' correct="true"' : '';
                    xml += `<option${attr}>${escapeXml(opt.text)}</option>\n`;
                });
                xml += `</options>\n`;
            } else {
                xml += `<answer>${escapeXml(q.answer)}</answer>\n`;
            }
            xml += `</question>\n`;
        });
        xml += `</questions>\n</fragment>\n`;
    });
    xml += '</readingTest>';
    return xml;
}

function escapeXml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function newFragment() {
    return { timeExcellent: DEFAULT_TIME_EXCELLENT, timeGood: DEFAULT_TIME_GOOD, text: '', questions: [] };
}

// ============================================================
// Синхронизация данных -> XML-панель + автосохранение
// ============================================================
function updateXmlOutput(opts = {}) {
    state.dirty = true;
    clearTimeout(state.syncTimeout);
    const sync = () => {
        // Пока пользователь редактирует XML-панель — не перезаписываем её содержимое,
        // иначе теряются несохранённые ручные правки и сбрасывается каретка.
        if (document.activeElement === els.xmlEditor && !opts.force) return;
        els.xmlEditor.value = generateXml();
    };
    if (opts.immediate || opts.force) sync();
    else state.syncTimeout = setTimeout(sync, 100);
    scheduleAutoSave();
}

function scheduleAutoSave() {
    if (!autoSaveEnabled()) return;
    if (state.skipNextAutoSave) { state.skipNextAutoSave = false; return; }
    setStatus('Автосохранение на диск…');
    clearTimeout(state.autoSaveTimeout);
    state.autoSaveTimeout = setTimeout(() => {
        state.autoSaveTimeout = null;
        autoSaveToDisk();
    }, autoSaveDelayMs());
}

// Автосохранение выполняется ТОЛЬКО на диск компьютера (в выбранный файл).
// Публикация на сервисы — только по кнопке «Публикация».
async function autoSaveToDisk() {
    const content = els.xmlEditor.value || generateXml();
    try {
        if (state.fileHandle && await ensureFilePermission(state.fileHandle)) {
            await writeFileHandle(state.fileHandle, content);
            state.dirty = false;
            setStatus('Автосохранено на диск: ' + state.fileHandle.name + ' в ' + new Date().toLocaleTimeString());
            return;
        }
        // Файл для автосохранения не выбран — обычное скачивание браузера
        downloadBlob(content, suggestedFileName(), 'Файл сохранён на диск (скачан): ');
        state.dirty = false;
    } catch (e) {
        setStatus('Ошибка автосохранения на диск: ' + e.message);
        showToast('Автосохранение: ' + e.message, true);
    }
}

// Выбор постоянного файла для автосохранения (File System Access API)
async function pickAutoSaveFile() {
    if (!window.showSaveFilePicker) {
        return showToast('Ваш браузер не поддерживает выбор файла для автосохранения (нужен Chrome/Edge). Используйте кнопку «Сохранить в файл».', true);
    }
    try {
        const handle = await window.showSaveFilePicker({
            suggestedName: suggestedFileName(),
            types: [{ description: 'XML', accept: { 'text/xml': ['.xml'] } }],
        });
        state.fileHandle = handle;
        els.autoSaveFolderName.value = handle.name;
        saveSettings();
        await writeFileHandle(handle, els.xmlEditor.value || generateXml());
        state.dirty = false;
        setStatus('Файл для автосохранения выбран: ' + handle.name);
        showToast('Файл выбран, автосохранение будет писать в него');
    } catch (e) {
        if (e.name !== 'AbortError') showToast('Не удалось выбрать файл: ' + e.message, true);
    }
}

async function ensureFilePermission(handle, requestWrite = true) {
    if (!handle || !handle.requestPermission) return true; // Firefox и т.п. — без API проверки
    try {
        const opts = { mode: 'readwrite' };
        let status = await handle.queryPermission(opts);
        if (status === 'granted') return true;
        if (!requestWrite) return false;
        status = await handle.requestPermission(opts);
        return status === 'granted';
    } catch (e) {
        return false;
    }
}

async function writeFileHandle(handle, content) {
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
}

function downloadBlob(content, fileName, statusPrefix = 'Файл сохранён: ') {
    const blob = new Blob([content], { type: 'text/xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(statusPrefix + fileName);
}

// ============================================================
// Рендеринг редактора фрагментов
// ============================================================
function renderAll() {
    renderFragment();
    updateGistLinkDisplay();
}

function renderFragment() {
    if (!state.testData.fragments.length) state.testData.fragments.push(newFragment());
    if (state.currentFragmentIndex >= state.testData.fragments.length) {
        state.currentFragmentIndex = state.testData.fragments.length - 1;
    }
    const frag = state.testData.fragments[state.currentFragmentIndex];

    els.fragmentNumber.textContent = state.currentFragmentIndex + 1;
    els.timeExcellent.value = frag.timeExcellent;
    els.timeGood.value = frag.timeGood;
    els.fragmentText.value = frag.text;

    renderQuestions();
    updateNavigation();
}

function renderQuestions() {
    const frag = state.testData.fragments[state.currentFragmentIndex];
    if (!frag.questions.length) {
        els.questionsContainer.innerHTML = '<div class="empty-hint">Вопросы ещё не добавлены.</div>';
        return;
    }
    els.questionsContainer.innerHTML = frag.questions
        .map((q, i) => (q.type === 'choice' ? renderChoice(q, i) : renderInput(q, i)))
        .join('');
}

function renderChoice(q, i) {
    const opts = q.options.map((o, j) => `
        <div class="option-row ${o.correct ? 'correct' : ''}">
            <div class="radio ${o.correct ? 'selected' : ''}" data-action="set-correct" data-q="${i}" data-o="${j}" title="Отметить правильным"></div>
            <input type="text" class="opt-input" value="${escAttr(o.text)}" data-action="update-option" data-q="${i}" data-o="${j}">
            <button type="button" class="btn-icon" data-action="remove-option" data-q="${i}" data-o="${j}" aria-label="Удалить вариант">&#10005;</button>
        </div>
    `).join('');

    return `
        <div class="question-block">
            <div class="question-header">
                <span><span class="badge badge-choice">Choice</span> Q${i + 1}</span>
                <button type="button" class="btn-icon" data-action="remove-question" data-q="${i}" aria-label="Удалить вопрос">&#10005;</button>
            </div>
            <textarea class="input-base question-text" rows="2" data-action="update-question" data-q="${i}" placeholder="Текст вопроса…">${escHtml(q.text)}</textarea>
            <div>${opts}</div>
            <button type="button" class="btn btn-sm btn-add-option" data-action="add-option" data-q="${i}">+ Вариант</button>
        </div>
    `;
}

function renderInput(q, i) {
    return `
        <div class="question-block">
            <div class="question-header">
                <span><span class="badge badge-input">Input</span> Q${i + 1}</span>
                <button type="button" class="btn-icon" data-action="remove-question" data-q="${i}" aria-label="Удалить вопрос">&#10005;</button>
            </div>
            <textarea class="input-base question-text" rows="2" data-action="update-question" data-q="${i}" placeholder="Текст вопроса…">${escHtml(q.text)}</textarea>
            <div class="answer-row">
                <span class="answer-label">Ответ:</span>
                <input type="text" class="input-base" value="${escAttr(q.answer)}" data-action="update-answer" data-q="${i}">
            </div>
        </div>
    `;
}

// Делегирование событий для динамически создаваемых элементов вопросов
document.addEventListener('input', (e) => {
    const t = e.target;
    const action = t.dataset.action;
    if (!action) return;
    const q = +t.dataset.q, o = +t.dataset.o;
    const questions = state.testData.fragments[state.currentFragmentIndex].questions;
    if (action === 'update-question') questions[q].text = t.value;
    else if (action === 'update-answer') questions[q].answer = t.value;
    else if (action === 'update-option') questions[q].options[o].text = t.value;
    else return;
    // force: поле принадлежит динамическому списку и перерисовывается только по явным
    // действиям (добавить/удалить), поэтому перезапись XML-панели не сбрасывает фокус
    updateXmlOutput({ force: true });
});

document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const action = t.dataset.action;
    const q = +t.dataset.q, o = +t.dataset.o;
    const frag = state.testData.fragments[state.currentFragmentIndex];

    switch (action) {
        case 'add-option':
            frag.questions[q].options.push({ text: '', correct: false });
            break;
        case 'remove-option': {
            const opts = frag.questions[q].options;
            if (opts.length <= 2) return showToast('Минимум 2 варианта', true);
            opts.splice(o, 1);
            break;
        }
        case 'set-correct':
            frag.questions[q].options.forEach((op, i) => { op.correct = i === o; });
            break;
        case 'remove-question':
            frag.questions.splice(q, 1);
            break;
        default:
            return;
    }
    renderQuestions();
    updateXmlOutput();
});

function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}
function escAttr(str) {
    return escHtml(str).replace(/"/g, '&quot;');
}

function updateNavigation() {
    els.prevBtn.disabled = state.currentFragmentIndex === 0;
    els.nextBtn.disabled = state.currentFragmentIndex >= state.testData.fragments.length - 1;
    els.fragmentTabs.innerHTML = state.testData.fragments.map((_, i) =>
        `<button type="button" class="nav-btn ${i === state.currentFragmentIndex ? 'active' : ''}" data-frag="${i}">${i + 1}</button>`
    ).join('');
    els.fragmentTabs.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => goToFragment(+b.dataset.frag));
    });
}

// ============================================================
// Действия редактора
// ============================================================
function updateFragmentFromInputs() {
    const frag = state.testData.fragments[state.currentFragmentIndex];
    frag.timeExcellent = parseInt(els.timeExcellent.value, 10) || DEFAULT_TIME_EXCELLENT;
    frag.timeGood = parseInt(els.timeGood.value, 10) || DEFAULT_TIME_GOOD;
    frag.text = els.fragmentText.value;
    updateXmlOutput();
}

function addFragment() {
    state.testData.fragments.push(newFragment());
    state.currentFragmentIndex = state.testData.fragments.length - 1;
    renderFragment();
    updateXmlOutput();
}

function deleteCurrentFragment() {
    if (state.testData.fragments.length <= 1) return showToast('Нельзя удалить последний фрагмент', true);
    state.testData.fragments.splice(state.currentFragmentIndex, 1);
    state.currentFragmentIndex = Math.min(state.currentFragmentIndex, state.testData.fragments.length - 1);
    renderFragment();
    updateXmlOutput();
}

function prevFragment() { if (state.currentFragmentIndex > 0) { state.currentFragmentIndex--; renderFragment(); } }
function nextFragment() { if (state.currentFragmentIndex < state.testData.fragments.length - 1) { state.currentFragmentIndex++; renderFragment(); } }
function goToFragment(i) { state.currentFragmentIndex = i; renderFragment(); }

function addQuestion(type) {
    state.testData.fragments[state.currentFragmentIndex].questions.push({
        type,
        text: '',
        options: type === 'choice' ? [{ text: '', correct: true }, { text: '', correct: false }] : [],
        answer: '',
    });
    renderQuestions();
    updateXmlOutput();
}

function applyXmlChanges() {
    if (parseXmlToData(els.xmlEditor.value)) {
        state.currentFragmentIndex = 0;
        renderFragment();
        showToast('XML применён');
    }
}

function copyXml() {
    navigator.clipboard.writeText(els.xmlEditor.value);
    showToast('Скопировано в буфер обмена');
}

// ============================================================
// Сохранение на диск (File System Access API + fallback)
// ============================================================
function suggestedFileName() {
    const base = (state.testData.topicName || 'reading_test')
        .replace(/[\\/:*?"<>|]+/g, '_')
        .trim()
        .slice(0, 80) || 'reading_test';
    return base.endsWith('.xml') ? base : base + '.xml';
}

async function saveToFile() {
    const content = els.xmlEditor.value || generateXml();
    const fileName = suggestedFileName();

    // Если файл для автосохранения уже выбран — пишем прямо в него
    if (state.fileHandle && await ensureFilePermission(state.fileHandle)) {
        try {
            await writeFileHandle(state.fileHandle, content);
            state.dirty = false;
            setStatus('Сохранено в файл: ' + state.fileHandle.name);
            showToast('Файл сохранён на диск');
            return;
        } catch (e) { /* падаем на диалог/скачивание */ }
    }

    // Диалог выбора места сохранения (Chrome/Edge)
    if (window.showSaveFilePicker) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: fileName,
                types: [{ description: 'XML', accept: { 'text/xml': ['.xml'] } }],
            });
            await writeFileHandle(handle, content);
            state.dirty = false;
            setStatus('Сохранено в файл: ' + handle.name);
            showToast('Файл сохранён на диск');
            return;
        } catch (e) {
            if (e.name === 'AbortError') return; // пользователь отменил
            // прочие ошибки — падаем на download-fallback
        }
    }

    downloadBlob(content, fileName);
    state.dirty = false;
    showToast('Файл сохранён на диск');
}

// ============================================================
// Публикация: GitHub Gist / GitVerse (только по кнопке, возвращает ссылку)
// ============================================================
function toggleMenu(menu, otherMenu) {
    const willShow = menu.classList.contains('hidden');
    if (otherMenu) otherMenu.classList.add('hidden');
    menu.classList.toggle('hidden', !willShow);
}
function hidePublishMenu() { els.publishMenu.classList.add('hidden'); }
function hideMenus() {
    els.publishMenu.classList.add('hidden');
}

// Публикация в Gist: если GIST уже привязан — обновляем его, иначе создаём новый
function publishToGist() {
    if (state.gistId) return saveToGist();
    return createNewGist();
}

function openExternal(url) { window.open(url, '_blank', 'noopener'); }

function updateGistLinkDisplay() {
    if (!state.gistUrl) {
        els.gistLinkContainer.classList.add('hidden');
        return;
    }
    els.gistLinkText.href = state.gistUrl;
    els.gistLinkText.textContent = state.gistUrl;
    els.gistLinkContainer.classList.remove('hidden');
}

async function createNewGist() {
    const token = getGithubToken();
    if (!token) return showToast('Укажите GitHub Token (⚙ Настройки)', true);

    try {
        setStatus('Создание нового GIST…');
        const res = await fetch('https://api.github.com/gists', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                description: state.testData.topicName || 'Reading Test',
                public: false,
                files: { [GIST_FILENAME]: { content: els.xmlEditor.value || generateXml() } },
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message);

        state.gistId = data.id;
        state.gistUrl = data.html_url;
        state.gistFilename = GIST_FILENAME;
        state.rawUrl = data.files[GIST_FILENAME]?.raw_url || null;
        state.lastPublishTarget = 'gist';
        state.dirty = false;

        updateGistLinkDisplay();
        showPublishedLink('GIST опубликован', buildTaskUrl());
    } catch (e) {
        setStatus('Ошибка создания GIST: ' + e.message);
        showToast('Создание не удалось: ' + e.message, true);
    }
}

// Ссылка на задание в приложении (открывается по raw-ссылке XML)
function buildTaskUrl() {
    if (!state.rawUrl) return state.gistUrl || '';
    return TASK_APP_BASE_URL + '?file=' + encodeURIComponent(state.rawUrl);
}

// Показать ссылку на задание после публикации: статус + toast + копирование в буфер
function showPublishedLink(title, link) {
    setStatus(`${title}. Ссылка скопирована в буфер обмена`);
    showToast(`${title}: ${link}`, false);
    if (link && navigator.clipboard) navigator.clipboard.writeText(link).catch(() => {});
}

async function saveToGist(opts = {}) {
    const token = getGithubToken();
    if (!state.gistId || !token) return;
    if (state.isSaving) { state.needsAnotherSave = true; return; }
    state.isSaving = true;
    state.autoSaveTimeout = null;

    setStatus('Сохранение в GIST…');
    try {
        const res = await fetch(`https://api.github.com/gists/${state.gistId}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                description: state.testData.topicName || 'Reading Test',
                files: { [state.gistFilename]: { content: els.xmlEditor.value } },
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message);

        const fd = data.files[state.gistFilename];
        if (fd && fd.raw_url) state.rawUrl = fd.raw_url;
        state.dirty = false;
        setStatus('Сохранено в GIST в ' + new Date().toLocaleTimeString());
        if (!opts.silent) showPublishedLink('Обновлено в GIST', buildTaskUrl());
    } catch (e) {
        if (String(e.message).toLowerCase().includes('blocked')) {
            setStatus('GIST занят, повторная попытка…');
            scheduleAutoSave();
        } else {
            setStatus('Ошибка сохранения: ' + e.message);
            showToast('Сохранение не удалось: ' + e.message, true);
        }
    } finally {
        state.isSaving = false;
        if (state.needsAnotherSave) {
            state.needsAnotherSave = false;
            scheduleAutoSave();
        }
    }
}

async function publishToGitverse(opts = {}) {
    const token = getGitverseToken();
    if (!token) {
        showToast('Укажите токен GitVerse в настройках (⚙)', true);
        return;
    }
    const content = els.xmlEditor.value || generateXml();
    const fileName = suggestedFileName();
    const projectName = (localStorage.getItem('gv_project') || '').trim();

    try {
        setStatus('Публикация на GitVerse…');
        const headers = { Authorization: `Token ${token}`, 'Content-Type': 'application/json' };

        // 1. Найти репозиторий для публикации
        let project = projectName;
        if (!project) {
            const resList = await fetch(`${GITVERSE_API}/user/repos?per_page=100`, { headers });
            if (!resList.ok) throw new Error(await describeHttpError(resList));
            const list = await resList.json();
            const items = Array.isArray(list) ? list : (list.items || list.data || []);
            // Приоритет: существующий репозиторий reading-tests, иначе первый доступный
            const preferred = items.find(p => /reading[-_]?tests?/i.test(p.path || p.name || '')) || items[0];
            if (!preferred) throw new Error('На GitVerse нет ни одного репозитория — создайте любой и повторите');
            project = preferred.path || preferred.full_path || preferred.name;
            localStorage.setItem('gv_project', project);
        }

        // 2. Проверка существования файла (нужен blob_id для обновления)
        let branch = 'master';
        let existingBlob = null;
        const resFile = await fetch(`${GITVERSE_API}/repos/${project}/contents/${encodeURIComponent(fileName)}`, { headers });
        if (resFile.ok) {
            const info = await resFile.json();
            existingBlob = info.blob_id || info.sha || null;
            if (info.branch) branch = info.branch;
        } else if (resFile.status !== 404) {
            // не 404 — попробуем прочитать описание ошибки; если тело недоступно — бросаем статус
            let detail = '';
            try { detail = await describeHttpError(resFile); } catch (e2) { /* ignore */ }
            throw new Error(`HTTP ${resFile.status}${detail ? ': ' + detail : ''}`);
        }

        // 3. Создать или обновить файл
        const body = {
            content: btoaUtf8(content),
            commit_message: `${existingBlob ? 'Обновление' : 'Публикация'} теста: ${state.testData.topicName || fileName}`,
            branch,
        };
        if (existingBlob) body.blob_id = existingBlob;

        const res = await fetch(`${GITVERSE_API}/repos/${project}/contents/${encodeURIComponent(fileName)}`, {
            method: existingBlob ? 'PUT' : 'POST',
            headers,
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(await describeHttpError(res));

        state.gitverseProject = project;
        state.gitverseRawUrl = `https://gitverse.ru/${project}/raw/branch/${branch}/${encodeURIComponent(fileName)}`;
        state.lastPublishTarget = 'gitverse';
        state.dirty = false;
        // Ссылка на задание: приложение RE:AD открывает XML по raw-ссылке GitVerse
        const taskLink = TASK_APP_BASE_URL + '?file=' + encodeURIComponent(state.gitverseRawUrl);
        showPublishedLink('Опубликовано на GitVerse (' + project + ')', taskLink);
    } catch (e) {
        setStatus('Ошибка публикации на GitVerse: ' + e.message);
        showToast('GitVerse: ' + e.message, true);
    }
}

function btoaUtf8(str) {
    return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}

async function describeHttpError(res) {
    if (!res || typeof res.text !== 'function') return res && res.status ? `HTTP ${res.status}` : '';
    let detail = '';
    try {
        const text = await res.text();
        try { const j = JSON.parse(text); detail = j.message || j.error || text.slice(0, 120); }
        catch (e) { detail = text.slice(0, 120); }
    } catch (e) { /* ignore */ }
    return `HTTP ${res.status}${detail ? ': ' + detail : ''}`;
}

function copyGistUrl() {
    if (!state.gistUrl) return showToast('GIST ещё не создан', true);
    navigator.clipboard.writeText(state.gistUrl);
    showToast('Ссылка на GIST скопирована');
}

async function openTask() {
    if (!state.gistId) return showToast('Сначала создайте или загрузите GIST', true);

    copyGistUrl();
    const win = window.open('about:blank', '_blank');
    try {
        if (state.autoSaveTimeout || state.dirty) {
            clearTimeout(state.autoSaveTimeout);
            state.autoSaveTimeout = null;
            await saveToGist();
        }
    } catch (e) { /* продолжаем даже при ошибке сохранения */ }

    if (!state.rawUrl) {
        if (win) win.close();
        return showToast('Raw-ссылка недоступна', true);
    }

    const taskUrl = TASK_APP_BASE_URL + '?file=' + encodeURIComponent(state.rawUrl);
    navigator.clipboard.writeText(taskUrl);
    if (win) { win.opener = null; win.location.href = taskUrl; }
    else { window.open(taskUrl, '_blank'); }
    showToast('Ссылка на задание скопирована и открыта');
}

// ============================================================
// Загрузка из Gist
// ============================================================
function extractGistId(input) {
    input = (input || '').trim();
    if (!input) return null;
    try {
        const u = new URL(input);
        const f = u.searchParams.get('file');
        if (f) input = f;
    } catch (e) { /* не URL */ }
    const m = input.match(/(?:gist\.github\.com|gist\.githubusercontent\.com)\/(?:[^/\s]+\/)?([0-9a-f]{7,})/i);
    if (m) return m[1];
    if (/^[0-9a-f]{7,}$/i.test(input)) return input;
    return null;
}

async function loadFromGist() {
    const token = getGithubToken();
    const input = els.loadGistId.value.trim();
    if (!token || !input) return showToast('Нужны GitHub Token и ссылка на GIST', true);

    const id = extractGistId(input);
    if (!id) return showToast('Не удалось определить ID GIST', true);

    try {
        setStatus('Загрузка GIST…');
        const res = await fetch(`https://api.github.com/gists/${id}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message);

        let fileName = null;
        if (data.files[GIST_FILENAME]) {
            fileName = GIST_FILENAME;
        } else {
            const names = Object.keys(data.files);
            fileName = names.find(n => n.toLowerCase().endsWith('.xml')) || names[0];
        }
        const file = data.files[fileName];
        if (!file) throw new Error('В GIST нет файлов');

        if (parseXmlToData(file.content)) {
            state.gistId = data.id;
            state.gistUrl = data.html_url || `https://gist.github.com/${id}`;
            state.gistFilename = fileName;
            state.rawUrl = file.raw_url || null;
            state.lastPublishTarget = 'gist';

            updateGistLinkDisplay();
            state.currentFragmentIndex = 0;
            state.skipNextAutoSave = true;
            renderFragment();
            updateXmlOutput({ immediate: true });
            state.dirty = false;
            hideLoadModal();
            setStatus('GIST загружен');
            showToast('GIST загружен');
        } else {
            setStatus('Готово');
        }
    } catch (e) {
        setStatus('Ошибка загрузки: ' + e.message);
        showToast('Загрузка не удалась: ' + e.message, true);
    }
}

// ============================================================
// DeepSeek: два режима — абзацы / предложения.
// Сами промпты берутся из GitHub GIST (ссылки ниже): они
// скачиваются при открытии редактора и показываются в панели
// под окном XML; именно они отправляются в DeepSeek.
// Текст берётся из окна XML, результат возвращается в окно XML.
// Без токена: копируем промпт+XML и открываем чат DeepSeek.
// ============================================================

// Ссылки на промпты в GitHub Gist (режим «Абзацы» / режим «Предложения»)
const PROMPT_GIST_URLS = {
    // «Промпт для создания заданий READ» (тексты абзацев → структура задания)
    paragraphs: 'https://gist.github.com/tregubovvn/e837aa6949f0b20dee3925983ba2f424',
    // «Промпт для проверки готового задания READ» (вопросы/предложения)
    proposals: 'https://gist.github.com/tregubovvn/61c8a72e42d33dbdccf81d42cfda87f2',
};

// Конец сообщения модели — этим блоком модель подтверждает, что задание
// готово полностью; если его нет, просим модель продолжить.
const READY_MARKER = '[RE:AD-TEST-READY]';

// Добавляем к промпту из Gist технические требования к формату ответа
function buildDsPrompt(basePrompt) {
    return (basePrompt || '').trim() + '\n\n' +
        'ТЕХНИЧЕСКИЕ ТРЕБОВАНИЯ К ОТВЕТУ:\n' +
        '1. Входные данные — XML-файл задания (приведён после этого промпта).\n' +
        '2. Ответь ТОЛЬКО полным готовым XML (<readingTest>...</readingTest>) без пояснений и без блоков markdown.\n' +
        '3. Сохрани все метаданные: topicName, author, university, discipline, targetAudience.\n' +
        '4. Последней строкой ответа добавь точный маркер: ' + READY_MARKER;
}

async function fetchGistRaw(url) {
    const m = url.match(/(?:gist\.github\.com|gist\.githubusercontent\.com)\/(?:[^/\s]+\/)?([0-9a-f]{7,})/i);
    if (!m) throw new Error('Некорректная ссылка на Gist: ' + url);
    const res = await fetch('https://api.github.com/gists/' + m[1]);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' при загрузке Gist');
    const data = await res.json();
    const files = Object.values(data.files || {});
    if (!files.length) throw new Error('В Gist нет файлов');
    // предпочитает .md/.txt, иначе первый файл
    const preferred = files.find(f => /\.(md|txt)$/i.test(f.filename)) || files[0];
    const rawRes = await fetch(preferred.raw_url);
    if (!rawRes.ok) throw new Error('HTTP ' + rawRes.status + ' при чтении файла Gist');
    return await rawRes.text();
}

// Загрузка обоих промптов из Gist; при сетевой ошибке оставляем резервные тексты
async function loadPromptsFromGists() {
    setStatus('Загрузка промптов с GitHub Gist…');
    let loaded = 0, failed = 0;
    for (const mode of ['paragraphs', 'proposals']) {
        try {
            const text = await fetchGistRaw(PROMPT_GIST_URLS[mode]);
            if (text.trim()) { state.dsPrompts[mode] = text.trim(); loaded++; }
        } catch (e) {
            console.warn('Не удалось загрузить промпт (' + mode + '):', e);
            failed++;
        }
    }
    renderModeSwitch();
    if (loaded === 2) setStatus('Готово: промпты загружены с Gist');
    else if (loaded === 1) setStatus('Готово: один промпт загружен с Gist, второй — резервный');
    else if (failed) setStatus('Готово (промпты с Gist не загрузились — используются резервные тексты)');
}

function extractXmlFromText(text) {
    if (!text) return '';
    // убираем markdown-обёртки ```xml ... ```
    const fenced = text.match(/```(?:xml)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf('<readingTest');
    const end = candidate.lastIndexOf('</readingTest>');
    if (start !== -1 && end !== -1) return candidate.slice(start, end + '</readingTest>'.length).trim();
    return candidate.trim();
}

// Отправка одного сообщения в DeepSeek; возвращает текст ответа модели.
async function deepseekChat(token, messages) {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'deepseek-chat', messages, stream: false }),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* не-JSON ответ */ }
    if (!res.ok) {
        throw new Error((data && (data.error?.message || data.message)) || 'HTTP ' + res.status);
    }
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) throw new Error('Некорректный ответ модели');
    return reply;
}

async function askDeepSeek(mode) {
    mode = mode || currentDsMode();
    localStorage.setItem(LS.dsMode, mode);
    renderModeSwitch();

    const token = getDeepseekToken();
    const xml = els.xmlEditor.value || generateXml();
    if (!xml.trim()) return showToast('XML пуст', true);

    // Без токена: копировать промпт+XML в буфер и открыть чат DeepSeek
    if (!token) {
        const payload = buildDsMessage(mode);
        try { await navigator.clipboard.writeText(payload); } catch (e) { /* не критично */ }
        showToast('Промпт и XML скопированы — вставьте их в чат DeepSeek (открыт в новом окне)');
        openExternal('https://chat.deepseek.com/');
        return;
    }

    setStatus('DeepSeek (' + (mode === 'proposals' ? 'режим предложений' : 'режим абзацев') + ')…');
    showToast('Думаю…');
    try {
        const messages = [{ role: 'user', content: buildDsMessage(mode) }];
        let fullReply = '';
        // Модель могла не закончить задание за один ответ (нет финального блока) —
        // просим продолжить, максимум 3 дополнительных запроса.
        for (let i = 0; i < 4; i++) {
            const reply = await deepseekChat(token, messages);
            fullReply += (i > 0 ? '\n' : '') + reply;
            messages.push({ role: 'assistant', content: reply });
            if (fullReply.includes(READY_MARKER)) break;
            const hasOpen = (fullReply.match(/<readingTest>/g) || []).length;
            const hasClose = (fullReply.match(/<\/readingTest>/g) || []).length;
            if (hasOpen > 0 && hasOpen === hasClose && extractXmlFromText(fullReply).includes('</fragment>')) {
                break; // XML выглядит завершённым, даже если модель забыла маркер
            }
            if (i === 3) break;
            setStatus('DeepSeek: задание неполное — прошу модель продолжить…');
            messages.push({ role: 'user', content: 'Задание ещё не готово (нет финального XML и маркера ' + READY_MARKER + '). Продолжи и выдай ПОЛНЫЙ готовый XML целиком, без пояснений.' });
        }

        const resultXml = extractXmlFromText(fullReply);
        if (!resultXml || !resultXml.includes('<readingTest')) {
            throw new Error('В ответе модели нет XML-задания');
        }
        els.xmlEditor.value = resultXml;
        // Результат сразу применяем к редактору (и он же сохранится на диск при автосохранении)
        if (parseXmlToData(resultXml)) {
            state.currentFragmentIndex = 0;
            renderFragment();
            updateXmlOutput({ immediate: true, force: true });
            showToast('Ответ DeepSeek применён к XML и редактору');
        } else {
            showToast('Ответ получен, но XML некорректен — проверьте панель XML', true);
        }
        setStatus('DeepSeek: ответ получен');
    } catch (e) {
        console.error(e);
        setStatus('DeepSeek: ошибка');
        showToast('DeepSeek: ' + e.message, true);
    }
}

// Кнопка «📋 Промпт» — копирует активный промпт (из Gist) в буфер обмена
async function copyPrompt(mode) {
    try {
        await navigator.clipboard.writeText(state.dsPrompts[mode] || '');
        showToast('Промпт скопирован в буфер обмена');
    } catch (e) {
        showToast('Не удалось скопировать промпт', true);
    }
}

// ============================================================
// UI-хелперы
// ============================================================
function showToast(msg, isErr = false) {
    const t = els.toast;
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' error' : '');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

function setStatus(text) {
    els.statusText.textContent = text;
}

function showLoadModal() { els.loadModal.classList.add('show'); els.loadGistId.focus(); }
function hideLoadModal() { els.loadModal.classList.remove('show'); }
function showSettingsModal() { els.settingsModal.classList.add('show'); }
function hideSettingsModal() { els.settingsModal.classList.remove('show'); saveSettings(); }

// ============================================================
// Resizer для XML-панели (тянем за правую границу — меняем ширину)
// ============================================================
function initResizer() {
    const resizer = els.resizer;
    const panel = els.xmlPanel;
    let startX = 0, startW = 0;

    const doDrag = (e) => {
        const x = e.clientX ?? (e.touches && e.touches[0].clientX) ?? x;
        const w = Math.max(220, Math.min(window.innerWidth * 0.7, startW + (x - startX)));
        panel.style.width = w + 'px';
    };
    const stopDrag = () => {
        document.removeEventListener('mousemove', doDrag);
        document.removeEventListener('mouseup', stopDrag);
        document.removeEventListener('touchmove', doDrag);
        document.removeEventListener('touchend', stopDrag);
        resizer.classList.remove('active');
    };
    const start = (e) => {
        startX = e.clientX ?? (e.touches && e.touches[0].clientX) ?? 0;
        startW = panel.getBoundingClientRect().width;
        resizer.classList.add('active');
        document.addEventListener('mousemove', doDrag);
        document.addEventListener('mouseup', stopDrag);
        document.addEventListener('touchmove', doDrag);
        document.addEventListener('touchend', stopDrag);
        e.preventDefault();
    };
    resizer.addEventListener('mousedown', start);
    resizer.addEventListener('touchstart', start, { passive: false });
}
