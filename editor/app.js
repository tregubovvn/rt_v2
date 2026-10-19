'use strict';

/* =========================================================================
   Reading Test Editor — логика приложения
   Структура: XML-панель слева, редактор справа, настройки в модальном окне.
   ========================================================================= */

// --- Константы ---
const AUTOSAVE_DEBOUNCE_MS = 1500;      // задержка автосохранения после изменений
const DEFAULT_TIME_EXCELLENT = 60;
const DEFAULT_TIME_GOOD = 90;
const TASK_APP_BASE_URL = 'https://tregubovvn.github.io/rt_v2/index.html';
const GITVERSE_API = 'https://gitverse.ru/api/v2';
const GIST_FILENAME = 'reading_test.xml';

// Ключи localStorage
const LS = {
    ghToken: 'gh_token',
    dsToken: 'ds_token',
    gvToken: 'gv_token',
    autoSave: 'editor_autosave_enabled',
    meta: 'editor_meta_json',          // author / university / discipline / audience (шаблон)
    dsMode: 'editor_deepseek_mode',    // paragraphs | proposals
    promptEdits: 'editor_ds_prompt_edits',   // отредактированные пользователем промпты
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
    // Активные промпты DeepSeek (по режимам). Тексты загружаются ТОЛЬКО
    // из GitHub Gist (см. PROMPT_GIST_URLS); до загрузки — пустые строки.
    dsPrompts: { paragraphs: '', proposals: '' },
    dirty: false,               // есть несохранённые изменения в задании
    isSaving: false,
    needsAnotherSave: false,
    syncTimeout: null,
    autoSaveTimeout: null,
    fileHandle: null,           // FileSystemFileHandle выбранного файла на диске
    aiBusy: false,              // идёт запрос к DeepSeek (интерфейс заблокирован)
};

// Флаг «изменение идёт из XML-панели» — XML-поле само является источником данных,
// его input НЕ должен вызывать пересинхронизацию редактор -> XML (рекурсия).
let applyingXmlToEditor = false;

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
        openTask, copyTaskUrl, showMetaModal, hideMetaModal, reloadActivePromptFromGist, savePromptEdit,
    });
    loadPromptsFromGists();   // подгружаем тексты промптов с GitHub Gist
});

function cacheElements() {
    const ids = [
        'topicName', 'author', 'university', 'audience', 'discipline',
        'xmlEditor', 'xmlPanel', 'resizer', 'editorContainer',
        'fragmentCard', 'fragmentNumber', 'timeExcellent', 'timeGood', 'fragmentText',
        'questionsContainer', 'fragmentTabs', 'prevBtn', 'nextBtn',
        'statusText', 'toast', 'gistLinkContainer', 'publishedTaskLink',
        'loadModal', 'loadGistId', 'settingsModal', 'metaModal',
        'publishMenu', 'promptBar', 'promptText', 'publishCheckNote',
        'reviewPanel', 'reviewBody', 'reviewSummary', 'btnToggleReview',
        'btnModeProposals', 'btnModeParagraphs', 'btnCopyPrompt', 'btnReloadPrompt',
    ];
    els = {};
    ids.forEach(id => { els[id] = document.getElementById(id); });
    // Элементы вне стандартного списка (переключатель автосохранения в верхней панели)
    els.autoSaveToggle = document.getElementById('autoSaveToggle');
}

function bindEvents() {
    // Верхняя панель
    on('btnPublishGist', 'click', () => { hidePublishMenu(); publishToGist(); });
    on('btnPublishGitverse', 'click', () => { hidePublishMenu(); publishToGitverse(); });
    on('btnLoadGist', 'click', showLoadModal);
    on('btnSaveFile', 'click', saveToFile);
    on('btnPublish', 'click', (e) => { e.stopPropagation(); toggleMenu(els.publishMenu, null); });
    on('btnSettings', 'click', showSettingsModal);
    on('btnCopyXml', 'click', copyXml);
    on('btnApplyXml', 'click', applyXmlChanges);
    on('btnAskDeepSeek', 'click', () => askDeepSeek(currentDsMode()));

    // Ссылка на задание — в строке темы (над навигацией по фрагментам)
    on('btnCopyTaskUrl', 'click', copyTaskUrl);
    on('btnOpenTaskTop', 'click', openTask);

    // Правая панель обзора вопросов (быстрое пролистывание всех заданий)
    els.btnToggleReview.addEventListener('click', toggleReviewPanel);
    on('btnReviewClose', 'click', hideReviewPanel);

    // Метаданные данного теста — отдельное окно (кнопка в строке темы)
    on('btnMeta', 'click', showMetaModal);
    on('btnMetaClose', 'click', hideMetaModal);
    on('btnMetaDone', 'click', hideMetaModal);
    els.metaModal.addEventListener('click', (e) => { if (e.target === els.metaModal) hideMetaModal(); });

    // Панель промпта под окном XML: выбор режима, копирование/редактирование промпта
    els.btnModeProposals.addEventListener('click', () => setDsMode('proposals'));
    els.btnModeParagraphs.addEventListener('click', () => setDsMode('paragraphs'));
    on('btnCopyPrompt', 'click', () => copyPrompt(currentDsMode()));
    on('btnReloadPrompt', 'click', reloadActivePromptFromGist);
    els.promptText.addEventListener('input', savePromptEdit);

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

    // XML-панель (ручное редактирование): изменения идут из XML — автосохраняем
    // на диск, но НЕ пересинхронизируем редактор -> XML (иначе рекурсия и потеря фокуса).
    els.xmlEditor.addEventListener('input', () => {
        if (applyingXmlToEditor) return;
        // Изменения в XML-окне: обновляем данные для проверки публикации и обзора.
        // Парсим «тихо»: при некорректном XML редактор не перерисовываем, а поле
        // ввода остаётся как есть (о пользователе уже предупреждает кнопка «Применить ▶»).
        // Без toast: при живом наборе текста некорректный XML — норма
        silentParseXml(els.xmlEditor.value);
        updatePublishReadiness();
        if (!els.reviewPanel.classList.contains('hidden')) renderReviewPanel();
        state.dirty = true;
        scheduleAutoSave();
    });

    // Модальные окна
    on('btnLoadCancel', 'click', hideLoadModal);
    on('btnLoadConfirm', 'click', loadFromGist);
    els.loadModal.addEventListener('click', (e) => { if (e.target === els.loadModal) hideLoadModal(); });
    on('btnSettingsClose', 'click', hideSettingsModal);
    on('btnSettingsDone', 'click', hideSettingsModal);
    els.settingsModal.addEventListener('click', (e) => { if (e.target === els.settingsModal) hideSettingsModal(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { hideLoadModal(); hideSettingsModal(); hideMetaModal(); hidePublishMenu(); }
    });

    // Поля настроек (токены) + переключатель автосохранения в верхней панели
    ['githubToken', 'deepseekToken', 'gitverseToken'].forEach(id => {
        document.getElementById(id).addEventListener('change', saveSettings);
    });
    els.autoSaveToggle.addEventListener('change', () => {
        saveSettings();
        setStatus(autoSaveEnabled() ? 'Автосохранение на диск включено' : 'Автосохранение выключено');
    });

    // Поля метаданных теста (окно «Метаданные теста»)
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
function autoSaveDelayMs() { return AUTOSAVE_DEBOUNCE_MS; }

// Активный режим DeepSeek (proposals | paragraphs) хранится в localStorage
function currentDsMode() { return localStorage.getItem(LS.dsMode) || 'paragraphs'; }
function setDsMode(mode) {
    localStorage.setItem(LS.dsMode, mode);
    renderModeSwitch();
}

// Подсветка активного режима и показ (редактируемого) текста промпта под окном XML
function renderModeSwitch() {
    const mode = currentDsMode();
    els.btnModeProposals.classList.toggle('active', mode === 'proposals');
    els.btnModeParagraphs.classList.toggle('active', mode === 'paragraphs');
    els.btnModeProposals.setAttribute('aria-checked', String(mode === 'proposals'));
    els.btnModeParagraphs.setAttribute('aria-checked', String(mode === 'paragraphs'));
    // Не трогаем поле, пока пользователь его редактирует (фокус в textarea)
    if (document.activeElement !== els.promptText) {
        els.promptText.value = state.dsPrompts[mode] || state.dsPrompts.paragraphs;
    }
    updatePromptGistLink(mode);
}

// Сохранение отредактированного пользователем промпта (для активного режима)
function savePromptEdit() {
    const mode = currentDsMode();
    state.dsPrompts[mode] = els.promptText.value;
    try {
        const edits = JSON.parse(localStorage.getItem(LS.promptEdits) || '{}');
        edits[mode] = els.promptText.value;
        localStorage.setItem(LS.promptEdits, JSON.stringify(edits));
    } catch (e) { /* повреждённые данные — пропускаем */ }
}

// Кнопка «↻ Gist» — перезагрузить активный промпт с GitHub Gist (отменяет правки)
async function reloadActivePromptFromGist() {
    const mode = currentDsMode();
    try {
        setStatus('Загрузка промпта с Gist…');
        const text = await fetchGistRaw(PROMPT_GIST_URLS[mode]);
        if (!text.trim()) throw new Error('Пустой файл промпта');
        state.dsPrompts[mode] = text.trim();
        const edits = JSON.parse(localStorage.getItem(LS.promptEdits) || '{}');
        delete edits[mode];
        localStorage.setItem(LS.promptEdits, JSON.stringify(edits));
        els.promptText.value = state.dsPrompts[mode];
        setStatus('Промпт загружен с Gist');
        showToast('Промпт обновлён из Gist (правки отменены)');
    } catch (e) {
        setStatus('Не удалось загрузить промпт: ' + e.message);
        showToast('Загрузка промпта не удалась: ' + e.message, true);
    }
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
// «Тихий» парсинг XML в состояние (без toast и без перерисовки редактора) —
// используется при живом редактировании XML-панели, чтобы проверка публикации
// и панель обзора видели актуальные данные.
function silentParseXml(xmlString) {
    applyingXmlToEditor = true;
    try {
        return parseXmlToDataQuiet(xmlString);
    } finally {
        applyingXmlToEditor = false;
    }
}

function parseXmlToData(xmlString) {
    const ok = parseXmlToDataQuiet(xmlString);
    if (!ok) showToast('Некорректный XML', true);
    return ok;
}

function parseXmlToDataQuiet(xmlString) {
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
        return false;   // сообщение показывает вызвавший (parseXmlToData) или «тихий» режим
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
// Синхронизация данных -> XML-панель + автосохранение на диск.
// Автосохранение срабатывает ТОЛЬКО при изменениях в задании
// (редактор фрагментов / применение XML / ответ DeepSeek) — см. markTaskChanged().
// ============================================================
function updateXmlOutput(opts = {}) {
    clearTimeout(state.syncTimeout);
    const sync = () => {
        // Пока пользователь редактирует XML-панель — не перезаписываем её содержимое,
        // иначе теряются несохранённые ручные правки и сбрасывается каретка.
        if (document.activeElement === els.xmlEditor && !opts.force) return;
        els.xmlEditor.value = generateXml();
    };
    if (opts.immediate || opts.force) sync();
    else state.syncTimeout = setTimeout(sync, 100);

    // Индикатор готовности к публикации + панель обзора (если открыта)
    updatePublishReadiness();
    if (!els.reviewPanel.classList.contains('hidden')) renderReviewPanel();

    // Изменение В ЗАДАНИИ: помечаем как несохранённое и запускаем автосохранение
    if (!opts.silent) markTaskChanged();
}

// Единственная точка «в задании есть изменения»: dirty + автосохранение/предложение сохранить
function markTaskChanged() {
    state.dirty = true;
    scheduleAutoSave();
}

function scheduleAutoSave() {
    if (!autoSaveEnabled()) {
        // Автосохранение выключено — предлагаем сохранить файл вручную
        showSaveHint(true);
        return;
    }
    if (!state.fileHandle) {
        // Файл на диске ещё не выбран — НЕ скачиваем молча новые файлы
        // (это выглядело как «загрузка файла»). Просим выбрать файл один раз.
        showSaveHint(true);
        setStatus('Автосохранение: нажмите «💾 Сохранить в файл» и выберите файл на диске — изменения будут записываться в него автоматически');
        return;
    }
    setStatus('Автосохранение на диск…');
    clearTimeout(state.autoSaveTimeout);
    state.autoSaveTimeout = setTimeout(() => {
        state.autoSaveTimeout = null;
        autoSaveToDisk();
    }, autoSaveDelayMs());
}

// Подсветка кнопки «Сохранить в файл» + статусное предложение сохранить
function showSaveHint(show) {
    const btn = document.getElementById('btnSaveFile');
    if (btn) btn.classList.toggle('save-hint', !!show && state.dirty);
    if (show && !autoSaveEnabled() && state.dirty) {
        setStatus('Задание изменено — нажмите «💾 Сохранить в файл», чтобы записать его на диск');
    }
}

// Автосохранение выполняется ТОЛЬКО в выбранный файл на диске (File System Access API).
// Публикация на сервисы — только по кнопке «Публикация».
async function autoSaveToDisk() {
    const content = els.xmlEditor.value || generateXml();
    try {
        if (state.fileHandle && await ensureFilePermission(state.fileHandle)) {
            await writeFileHandle(state.fileHandle, content);
            state.dirty = false;
            showSaveHint(false);
            setStatus('Автосохранено на диск: ' + state.fileHandle.name + ' в ' + new Date().toLocaleTimeString());
            return;
        }
        // Доступ к файлу потерян (например, после перезагрузки страницы) —
        // просим выбрать файл заново, ничего без спроса не скачиваем.
        state.fileHandle = null;
        showSaveHint(true);
        setStatus('Автосохранение приостановлено: выберите файл через «💾 Сохранить в файл»');
    } catch (e) {
        setStatus('Ошибка автосохранения на диск: ' + e.message);
        showToast('Автосохранение: ' + e.message, true);
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
    updatePublishReadiness();
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

// «Применить ▶»: XML -> редактор. После применения спрашиваем, в какой файл
// на диске сохранить задание (через стандартный диалог сохранения), и дальше
// работаем с этим файлом (в т.ч. автосохранение пишет в него).
function applyXmlChanges() {
    applyingXmlToEditor = true;
    let applied = false;
    try {
        applied = parseXmlToData(els.xmlEditor.value);
    } finally {
        applyingXmlToEditor = false;
    }
    if (!applied) return;
    state.currentFragmentIndex = 0;
    renderFragment();
    // Информация из XML применена — изменения есть, предлагаем сохранить
    markTaskChanged();
    showToast('XML применён к редактору');
    confirmSaveAfterApply();
}

// Диалог «Сохранить применённое XML-задание в файл?» со стандартным выбором файла.
// Важно: window.confirm блокирует поток, поэтому showSaveFilePicker вызываем
// асинхронно (Promise + setTimeout) — иначе браузер отклоняет диалог как
// не инициированный пользователем.
function confirmSaveAfterApply() {
    Promise.resolve().then(() => {
        const ok = window.confirm('Информация из XML применена.\n\nСохранить задание в файл на диске?');
        if (!ok) {
            setStatus('Задание изменено, но не сохранено — нажмите «💾 Сохранить в файл», когда будете готовы');
            return;
        }
        setTimeout(() => saveToFile(), 0);   // покажет диалог выбора файла (или запишет в уже выбранный)
    });
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

    // Если файл на диске уже выбран — пишем прямо в него (стандартный механизм
    // File System Access API, без повторных диалогов)
    if (state.fileHandle && await ensureFilePermission(state.fileHandle)) {
        try {
            await writeFileHandle(state.fileHandle, content);
            state.dirty = false;
            showSaveHint(false);
            setStatus('Сохранено в файл: ' + state.fileHandle.name);
            showToast('Файл сохранён на диск');
            return;
        } catch (e) { /* падаем на диалог выбора файла */ }
    }

    // Диалог выбора места сохранения (Chrome/Edge). Файл запоминается —
    // дальше автосохранение пишет в него без вопросов.
    if (window.showSaveFilePicker) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: fileName,
                types: [{ description: 'XML', accept: { 'text/xml': ['.xml'] } }],
            });
            await writeFileHandle(handle, content);
            state.fileHandle = handle;
            state.dirty = false;
            showSaveHint(false);
            setStatus('Сохранено в файл: ' + handle.name + (autoSaveEnabled() ? ' (автосохранение в него включено)' : ''));
            showToast('Файл выбран и сохранён — дальнейшие изменения пишутся в него');
            return;
        } catch (e) {
            if (e.name === 'AbortError') return; // пользователь отменил
            // прочие ошибки — падаем на download-fallback
        }
    }

    // Браузер без File System Access API (Firefox/Safari) — стандартное скачивание
    downloadBlob(content, fileName);
    state.dirty = false;
    showSaveHint(false);
    showToast('Файл сохранён на диск (скачан)');
}

// ============================================================
// Проверка готовности задания + панель «Обзор» (правая)
// ============================================================

/**
 * Индекс проблем с правильными ответами по всем фрагментам:
 *  - вопросы типа choice без отмеченного правильного варианта;
 *  - вопросы типа input с пустым полем ответа.
 */
function findAnswerIssues() {
    const issues = [];
    state.testData.fragments.forEach((frag, fi) => {
        frag.questions.forEach((q, qi) => {
            if (q.type === 'choice') {
                if (!q.options.some(o => o.correct)) {
                    issues.push({ fragment: fi, question: qi, reason: 'не выбран правильный вариант' });
                }
            } else if (!(q.answer || '').trim()) {
                issues.push({ fragment: fi, question: qi, reason: 'пустой ответ' });
            }
        });
    });
    return issues;
}

function isPublishReady() {
    return findAnswerIssues().length === 0;
}

// Обновление индикатора готовности рядом с кнопкой «Публикация»
function updatePublishReadiness() {
    const note = els.publishCheckNote;
    if (!note) return;
    const issues = findAnswerIssues();
    note.classList.toggle('hidden', issues.length === 0);
    if (issues.length) {
        note.textContent = '⚠ нет правильного ответа: ' + issues.length + ' вопр.';
    }
}

function toggleReviewPanel() {
    if (els.reviewPanel.classList.contains('hidden')) showReviewPanel();
    else hideReviewPanel();
}

function showReviewPanel() {
    renderReviewPanel();
    els.reviewPanel.classList.remove('hidden');
    els.btnToggleReview.classList.add('active');
}

function hideReviewPanel() {
    els.reviewPanel.classList.add('hidden');
    els.btnToggleReview.classList.remove('active');
}

// Быстрый пролистыватель всех вопросов всех фрагментов с указанием
// правильного ответа; клик по карточке открывает нужный фрагмент в редакторе.
function renderReviewPanel() {
    const body = els.reviewBody;
    let totalQuestions = 0, badQuestions = 0;

    body.innerHTML = state.testData.fragments.map((frag, fi) => {
        const items = frag.questions.map((q, qi) => {
            totalQuestions++;
            let correctText, ok;
            if (q.type === 'choice') {
                const corr = q.options.filter(o => o.correct).map(o => o.text.trim()).filter(Boolean);
                ok = corr.length > 0;
                correctText = ok ? '✔ ' + corr.join('; ') : '— правильный вариант не выбран';
            } else {
                ok = !!(q.answer || '').trim();
                correctText = ok ? '✔ ' + q.answer : '— ответ не задан';
            }
            if (!ok) badQuestions++;
            return `<div class="review-item ${ok ? 'ok' : 'bad'}" data-frag="${fi}" data-q="${qi}" title="Открыть фрагмент ${fi + 1} в редакторе">
                <div class="review-q"><span class="badge ${q.type === 'choice' ? 'badge-choice' : 'badge-input'}">${q.type === 'choice' ? 'Choice' : 'Input'}</span> Ф${fi + 1}·Q${qi + 1}: ${escHtml(q.text || '(без текста)')}</div>
                <div class="review-a ${ok ? '' : 'missing'}">${escHtml(correctText)}</div>
            </div>`;
        }).join('');
        return `<div class="review-fragment-title">Фрагмент ${fi + 1}</div>${items || '<div class="review-empty">Нет вопросов</div>'}`;
    }).join('');

    if (!totalQuestions) body.innerHTML = '<div class="review-empty">В задании ещё нет вопросов.</div>';

    els.reviewSummary.textContent = totalQuestions
        ? (badQuestions ? '⚠ ' + badQuestions + ' из ' + totalQuestions + ' без ответа' : '✓ ' + totalQuestions + ' вопросов готово')
        : '';
    els.reviewSummary.classList.toggle('bad', badQuestions > 0);

    body.querySelectorAll('.review-item').forEach(item => {
        item.addEventListener('click', () => {
            goToFragment(+item.dataset.frag);
            // Подсветим вопрос в редакторе
            const block = els.questionsContainer.children[+item.dataset.q];
            if (block) {
                block.scrollIntoView({ behavior: 'smooth', block: 'center' });
                block.classList.add('flash-highlight');
                setTimeout(() => block.classList.remove('flash-highlight'), 1200);
            }
        });
    });
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

// Публикация в Gist: если GIST уже привязан — обновляем его, иначе создаём новый.
// Перед публикацией — проверка: у всех вопросов должен быть выбран правильный ответ.
function publishToGist() {
    if (!checkBeforePublish()) return;
    if (state.gistId) return saveToGist();
    return createNewGist();
}

// Проверка готовности к публикации; при проблемах — открываем панель обзора
// и показываем список проблемных вопросов. Возвращает true, если публиковать можно.
function checkBeforePublish() {
    const issues = findAnswerIssues();
    if (!issues.length) return true;
    showReviewPanel();
    const list = issues.slice(0, 8)
        .map(i => `Ф${i.fragment + 1}·Q${i.question + 1} — ${i.reason}`)
        .join('\n') + (issues.length > 8 ? `\n…и ещё ${issues.length - 8}` : '');
    showToast('Публикация невозможна: не у всех вопросов выбран правильный ответ (' + issues.length + ')', true);
    setStatus('Проверка перед публикацией: ' + issues.length + ' вопрос(ов) без правильного ответа:\n' + list.replace(/\n/g, ' · '));
    alert('Перед публикацией нужно выбрать правильный ответ во всех вопросах.\n\nПроблемные вопросы:\n' + list + '\n\nОни отмечены красным в панели «Обзор» справа.');
    return false;
}

function openExternal(url) { window.open(url, '_blank', 'noopener'); }

// Ссылка на опубликованное задание — показывается в строке темы
// (над кнопками Предыдущий/Следующий): ссылка + копировать + открыть.
function updateGistLinkDisplay() {
    const link = buildTaskUrl();
    if (link) {
        els.publishedTaskLink.href = link;
        els.publishedTaskLink.textContent = link;
        els.gistLinkContainer.classList.remove('hidden');
    } else {
        els.gistLinkContainer.classList.add('hidden');
    }
}

// Копирование ссылки на задание (кнопки рядом со ссылкой)
function copyTaskUrl() {
    const link = buildTaskUrl();
    if (!link) return showToast('Задание ещё не опубликовано', true);
    navigator.clipboard.writeText(link);
    showToast('Ссылка на задание скопирована');
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

// Ссылка на задание в приложении (открывается по raw-ссылке XML; Gist или GitVerse)
function buildTaskUrl() {
    if (state.lastPublishTarget === 'gitverse' && state.gitverseRawUrl) {
        return TASK_APP_BASE_URL + '?file=' + encodeURIComponent(state.gitverseRawUrl);
    }
    if (!state.rawUrl) return state.gistUrl || '';
    return TASK_APP_BASE_URL + '?file=' + encodeURIComponent(state.rawUrl);
}

// Показать ссылку на задание после публикации: статус + toast + копирование в буфер
function showPublishedLink(title, link) {
    setStatus(`${title}. Ссылка скопирована в буфер обмена`);
    showToast(`${title}: ${link}`, false);
    if (link && navigator.clipboard) navigator.clipboard.writeText(link).catch(() => {});
}

// ============================================================
// Публикация на сервис (GitHub Gist / GitVerse) — только по кнопке.
// saveToGist вызывается из «Открыть задание» для синхронизации перед открытием.
// ============================================================
async function saveToGist(opts = {}) {
    const token = getGithubToken();
    if (!state.gistId || !token) return;
    if (state.isSaving) { state.needsAnotherSave = true; return; }
    state.isSaving = true;

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
        // Публикация не сбрасывает «несохранённость» файла на диске:
        // dirty остаётся, пока изменения не записаны на диск.
        setStatus('Обновлено в GIST в ' + new Date().toLocaleTimeString());
        if (!opts.silent) showPublishedLink('Обновлено в GIST', buildTaskUrl());
    } catch (e) {
        setStatus('Ошибка сохранения в GIST: ' + e.message);
        if (!opts.silent) showToast('Публикация не удалась: ' + e.message, true);
    } finally {
        state.isSaving = false;
        if (state.needsAnotherSave) {
            state.needsAnotherSave = false;
            saveToGist(opts);
        }
    }
}

async function publishToGitverse(opts = {}) {
    if (!checkBeforePublish()) return;
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
        updateGistLinkDisplay();
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

async function openTask() {
    // Если GIST не привязан, но есть GitVerse-публикация — открываем ссылку на задание
    if (!state.gistId && state.gitverseRawUrl) {
        const taskUrl = TASK_APP_BASE_URL + '?file=' + encodeURIComponent(state.gitverseRawUrl);
        navigator.clipboard.writeText(taskUrl).catch(() => {});
        openExternal(taskUrl);
        showToast('Ссылка на задание скопирована и открыта');
        return;
    }
    if (!state.gistId) return showToast('Сначала опубликуйте задание (Gist или GitVerse)', true);

    copyTaskUrl();
    const win = window.open('about:blank', '_blank');
    try {
        if (state.autoSaveTimeout || state.dirty) {
            clearTimeout(state.autoSaveTimeout);
            state.autoSaveTimeout = null;
            await saveToGist({ silent: true });
        }
    } catch (e) { /* продолжаем даже при ошибке сохранения */ }

    if (!state.rawUrl) {
        if (win) win.close();
        return showToast('Raw-ссылка недоступна', true);
    }

    const taskUrl = buildTaskUrl();
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

// Загрузка обоих промптов из Gist. Пользовательские правки (promptEdits)
// имеют приоритет над текстом с Gist; без сети и правок поле промпта остаётся
// пустым — его можно загрузить кнопкой «↻ Gist» или ввести вручную.
async function loadPromptsFromGists() {
    setStatus('Загрузка промптов с GitHub Gist…');
    let edits = {};
    try { edits = JSON.parse(localStorage.getItem(LS.promptEdits) || '{}'); } catch (e) { edits = {}; }
    let loaded = 0, failed = 0;
    for (const mode of ['paragraphs', 'proposals']) {
        try {
            const text = await fetchGistRaw(PROMPT_GIST_URLS[mode]);
            if (text.trim()) { state.dsPrompts[mode] = text.trim(); loaded++; }
        } catch (e) {
            console.warn('Не удалось загрузить промпт (' + mode + '):', e);
            failed++;
        }
        if (typeof edits[mode] === 'string' && edits[mode].trim()) {
            state.dsPrompts[mode] = edits[mode];   // восстановленная пользовательская версия
        }
    }
    renderModeSwitch();
    if (loaded === 2) setStatus('Готово: промпты загружены с Gist');
    else if (loaded === 1) setStatus('Готово: загружен только один промпт с Gist (второй — «↻ Gist» или вручную)');
    else if (failed) setStatus('Промпты с Gist не загрузились — нажмите «↻ Gist» или отредактируйте поле промпта вручную');
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

// Индикатор прогресса в статусной строке (анимированная точка + текст этапа)
let aiProgressTimer = null;
let aiProgressDots = 0;
function setAiProgress(text) {
    setStatus((text || 'DeepSeek: обработка…') + ' ' + '·'.repeat(aiProgressDots % 4));
}
function startAiProgress() {
    stopAiProgress();
    aiProgressDots = 0;
    setAiProgress('Отправка запроса в DeepSeek');
    aiProgressTimer = setInterval(() => {
        aiProgressDots++;
        // обновляем только точки, не трогая текст, заданный externally
        const base = els.statusText.textContent.replace(/\s*[·]+\s*$/, '');
        setStatus(base + ' ' + '·'.repeat(aiProgressDots % 4));
    }, 500);
}
function updateAiStage(text) {
    if (!state.aiBusy) return;
    setStatus(text + ' ' + '·'.repeat(aiProgressDots % 4));
}
function stopAiProgress() {
    if (aiProgressTimer) { clearInterval(aiProgressTimer); aiProgressTimer = null; }
}

// Блокировка/разблокировка интерфейса на время обращения к DeepSeek
function setUiBusy(busy, reasonText) {
    state.aiBusy = busy;
    document.body.classList.toggle('ai-busy', busy);
    let overlay = document.getElementById('aiOverlay');
    if (busy) {
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'aiOverlay';
            overlay.className = 'ai-overlay';
            overlay.innerHTML =
                '<div class="ai-overlay-box">' +
                '<div class="spinner" aria-hidden="true"></div>' +
                '<div class="ai-overlay-text" id="aiOverlayText">DeepSeek обрабатывает задание…</div>' +
                '<div class="ai-overlay-hint">Интерфейс заблокирован до получения ответа. Это может занять несколько минут.</div>' +
                '</div>';
            document.body.appendChild(overlay);
        }
        if (reasonText) {
            const t = document.getElementById('aiOverlayText');
            if (t) t.textContent = reasonText;
        }
    } else if (overlay) {
        overlay.remove();
    }
    ['btnAskDeepSeek', 'btnApplyXml', 'btnCopyXml', 'btnSaveFile', 'btnPublish', 'btnLoadGist', 'btnSettings']
        .forEach(id => { const b = document.getElementById(id); if (b) b.disabled = busy; });
    if (els.xmlEditor) els.xmlEditor.readOnly = busy;
    if (els.promptText) els.promptText.readOnly = busy;
}

async function askDeepSeek(mode) {
    if (state.aiBusy) return;   // повторный клик во время обработки игнорируется
    mode = mode || currentDsMode();
    localStorage.setItem(LS.dsMode, mode);
    renderModeSwitch();

    const token = getDeepseekToken();
    const xml = els.xmlEditor.value || generateXml();
    if (!xml.trim()) return showToast('XML пуст', true);

    // Промпт должен быть загружен из Gist — иначе просим загрузить
    const promptBase = state.dsPrompts[mode];
    if (!promptBase || !promptBase.trim()) {
        showToast('Промпт для режима «' + (mode === 'proposals' ? 'Предложения' : 'Абзацы') + '» ещё не загружен с Gist — нажмите «↻ Gist»', true);
        reloadActivePromptFromGist();
        return;
    }

    // Без токена: копировать промпт+XML в буфер и открыть чат DeepSeek
    if (!token) {
        const payload = buildDsMessage(mode);
        try { await navigator.clipboard.writeText(payload); } catch (e) { /* не критично */ }
        showToast('Промпт и XML скопированы — вставьте их в чат DeepSeek (открыт в новом окне)');
        openExternal('https://chat.deepseek.com/');
        return;
    }

    const modeName = mode === 'proposals' ? 'режим предложений' : 'режим абзацев';
    // Блокируем интерфейс и показываем прогресс на всё время обращения
    setUiBusy(true, 'DeepSeek (' + modeName + '): обработка задания…');
    startAiProgress();
    try {
        const messages = [{ role: 'user', content: buildDsMessage(mode) }];
        let fullReply = '';
        // Модель могла не закончить задание за один ответ (нет финального блока) —
        // просим продолжить, максимум 3 дополнительных запроса.
        for (let i = 0; i < 4; i++) {
            updateAiStage(i === 0
                ? 'DeepSeek (' + modeName + '): запрос отправлен, ждём ответ…'
                : 'DeepSeek (' + modeName + '): продолжение генерации (' + i + '/3)…');
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
            messages.push({ role: 'user', content: 'Задание ещё не готово (нет финального XML и маркера ' + READY_MARKER + '). Продолжи и выдай ПОЛНЫЙ готовый XML целиком, без пояснений.' });
        }

        stopAiProgress();
        updateAiStage('Ответ получен — применяю к редактору…');
        const resultXml = extractXmlFromText(fullReply);
        if (!resultXml || !resultXml.includes('<readingTest')) {
            throw new Error('В ответе модели нет XML-задания');
        }
        els.xmlEditor.value = resultXml;
        // Результат сразу применяем к редактору; автосохранение запишет его
        // в выбранный файл на диске (если он выбран и автосохранение включено)
        applyingXmlToEditor = true;
        let parsedOk = false;
        try {
            parsedOk = parseXmlToData(resultXml);
            if (parsedOk) {
                state.currentFragmentIndex = 0;
                renderFragment();
            }
        } finally {
            applyingXmlToEditor = false;
        }
        markTaskChanged();
        if (parsedOk) {
            showToast('Ответ DeepSeek применён к XML и редактору');
        } else {
            showToast('Ответ получен, но XML некорректен — проверьте панель XML', true);
        }
        setStatus('DeepSeek: ответ получен и применён');
    } catch (e) {
        console.error(e);
        setStatus('DeepSeek: ошибка — ' + e.message);
        showToast('DeepSeek: ' + e.message, true);
    } finally {
        stopAiProgress();
        setUiBusy(false);
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
function showMetaModal() { els.metaModal.classList.add('show'); els.author.focus(); }
function hideMetaModal() { els.metaModal.classList.remove('show'); readMetaFromSettingsInputs(); updateXmlOutput(); }

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
