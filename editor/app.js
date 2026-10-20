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
    dsMode: 'editor_deepseek_mode',    // id активного промпта/режима
    promptEdits: 'editor_ds_prompt_edits',   // отредактированные пользователем промпты {id: text}
    promptsGist: 'editor_prompts_gist_url',  // единая ссылка на Gist со всеми промптами (MD)
    lastSaveTime: 'editor_last_save_time',   // время последнего сохранения файла на диск
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
    // Все промпты DeepSeek: [{id, name, text, source:'gist'|'local'}].
    // Загружаются из ОДНОГО GitHub Gist в MD-формате (см. DEFAULT_PROMPTS_GIST_URL);
    // пользователь может добавить свои промпты и сохранить всё обратно в этот же Gist.
    prompts: [],
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
    renderModeSelect();
    updateLastSaveTimeLabel();
    initResizer();
    bindEvents();
    // Отладочный доступ к функциям (все объявления подняты — можно ссылаться)
    Object.assign(window.editorState.api, {
        publishToGist, publishToGitverse, saveToFile, askDeepSeek, setDsMode, currentDsMode,
        generateXml, parseXmlToData, loadPromptsFromGists, buildDsPrompt,
        openTask, copyTaskUrl, showMetaModal, hideMetaModal, reloadActivePromptFromGist, savePromptEdit,
        addLocalPrompt, removePrompt, savePromptsToGist, getPromptsGistUrl,
    });
    loadPromptsFromGists();   // подгружаем все промпты из единого Gist (MD)
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
        'dsModeSelect', 'btnManagePrompts', 'btnEditPrompt', 'btnCopyPrompt', 'btnReloadPrompt',
        'promptGistLink', 'lastSaveTimeLabel',
        'promptsModal', 'promptList', 'newPromptName', 'btnAddPrompt', 'promptsGistUrl',
        'btnReloadPrompts', 'btnSavePromptsToGist',
        'promptEditorModal', 'promptEditorArea', 'promptEditorInfo',
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

    // Панель промпта под окном XML: выбор режима (из единого Gist), редактор, копирование
    els.dsModeSelect.addEventListener('change', () => setDsMode(els.dsModeSelect.value));
    on('btnManagePrompts', 'click', showPromptsModal);
    on('btnEditPrompt', 'click', openPromptEditor);
    on('btnCopyPrompt', 'click', () => copyPrompt(currentDsMode()));
    on('btnReloadPrompt', 'click', reloadActivePromptFromGist);

    // Окно «Промпты DeepSeek» (все промпты в одном Gist, MD-формат)
    on('btnPromptsClose', 'click', hidePromptsModal);
    on('btnPromptsDone', 'click', hidePromptsModal);
    els.promptsModal.addEventListener('click', (e) => { if (e.target === els.promptsModal) hidePromptsModal(); });
    on('btnAddPrompt', 'click', addLocalPrompt);
    on('btnReloadPrompts', 'click', reloadAllPromptsFromGist);
    on('btnSavePromptsToGist', 'click', savePromptsToGist);
    els.promptsGistUrl.addEventListener('change', () => {
        localStorage.setItem(LS.promptsGist, els.promptsGistUrl.value.trim());
        updatePromptGistLink();
    });

    // Модальное окно текстового редактора активного промпта
    on('btnPromptEditorClose', 'click', hidePromptEditor);
    on('btnPromptEditorCancel', 'click', hidePromptEditor);
    on('btnPromptEditorSave', 'click', savePromptFromEditor);
    els.promptEditorModal.addEventListener('click', (e) => { if (e.target === els.promptEditorModal) hidePromptEditor(); });

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

// Активный режим DeepSeek = id промпта из state.prompts (paragraphs | proposals | custom-…)
function currentDsMode() { return localStorage.getItem(LS.dsMode) || 'paragraphs'; }
function setDsMode(mode) {
    localStorage.setItem(LS.dsMode, mode);
    renderModeSelect();
}

// Наполнение выпадающего списка режимов и показ текста активного промпта
function renderModeSelect() {
    const activeId = currentDsMode();
    if (els.dsModeSelect) {
        els.dsModeSelect.innerHTML = state.prompts
            .map(p => `<option value="${escHtml(p.id)}"${p.id === activeId ? ' selected' : ''}>${escHtml(p.name)}</option>`)
            .join('');
        // Если активного id ещё нет в списке — выбираем первый доступный
        if (state.prompts.length && !state.prompts.some(p => p.id === activeId)) {
            els.dsModeSelect.selectedIndex = 0;
            localStorage.setItem(LS.dsMode, state.prompts[0].id);
        }
    }
    const prompt = getPromptById(currentDsMode()) || state.prompts[0];
    if (document.activeElement !== els.promptText) {
        els.promptText.value = prompt ? prompt.text : '';
    }
    updatePromptGistLink();
}

function getPromptById(id) {
    return state.prompts.find(p => p.id === id) || null;
}

// Сохранение отредактированного пользователем промпта (для активного режима).
// Правки живут локально (localStorage) до «Сохранить все в Gist».
function savePromptEdit(text) {
    const id = currentDsMode();
    const p = getPromptById(id);
    if (!p) return;
    p.text = text;
    try {
        const edits = JSON.parse(localStorage.getItem(LS.promptEdits) || '{}');
        edits[id] = text;
        localStorage.setItem(LS.promptEdits, JSON.stringify(edits));
    } catch (e) { /* повреждённые данные — пропускаем */ }
}

// Кнопка «↻ Gist» — перезагрузить активный промпт из единого Gist (отменяет локальные правки)
async function reloadActivePromptFromGist() {
    const id = currentDsMode();
    const p = getPromptById(id);
    if (!p || p.source !== 'gist') {
        showToast('Этот промпт локальный — перезагрузка из Gist недоступна', true);
        return;
    }
    await loadPromptsFromGists({ only: id });
    setStatus('Промпт обновлён из Gist');
    showToast('Промпт «' + p.name + '» обновлён из Gist (правки отменены)');
}

// Ссылка на единый Gist со всеми промптами (под окном XML и в окне «Промпты»)
function getPromptsGistUrl() {
    return localStorage.getItem(LS.promptsGist) || DEFAULT_PROMPTS_GIST_URL;
}

function updatePromptGistLink() {
    const link = els.promptGistLink;
    if (!link) return;
    const url = getPromptsGistUrl();
    if (url) {
        link.href = url;
        link.textContent = 'Промпты на Gist ↗';
        link.classList.remove('hidden');
    } else {
        link.classList.add('hidden');
    }
}

// Полное сообщение для отправки в DeepSeek: активный промпт + XML из панели
function buildDsMessage(mode) {
    const p = getPromptById(mode) || state.prompts[0];
    const xml = els.xmlEditor.value || generateXml();
    return buildDsPrompt(p ? p.text : '') + '\n\nXML-ЗАДАНИЕ:\n' + xml;
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
// Промпты DeepSeek — универсальная работа.
// Все промпты (включая добавленные пользователем) хранятся в ОДНОМ
// GitHub Gist в формате Markdown: каждый промпт — секция «## Название».
// Режимы DeepSeek = промпты из этого списка; пользователь может добавить свои.
// Текст берётся из окна XML, результат возвращается в окно XML.
// Без токена: копируем промпт+XML и открываем чат DeepSeek.
// ============================================================

// Ссылка на единый Gist со всеми промптами (MD). Можно переопределить в окне «📝 Промпты…».
const DEFAULT_PROMPTS_GIST_URL = 'https://gist.github.com/tregubovvn/2f9804a3ad5439b1bb60957b8969826a';

// Встроенные (дефолтные) режимы — используются как заготовки, если в Gist
// соответствующих секций нет; их тексты догружаются с отдельных gist'ов.
const BUILTIN_PROMPTS = [
    { id: 'paragraphs', name: 'Абзацы',
      fallbackUrl: 'https://gist.github.com/tregubovvn/e837aa6949f0b20dee3925983ba2f424' },
    { id: 'proposals', name: 'Предложения',
      fallbackUrl: 'https://gist.github.com/tregubovvn/61c8a72e42d33dbdccf81d42cfda87f2' },
];

// Конец сообщения модели — этим блоком модель подтверждает, что задание
// готово полностью; если его нет, просим модель продолжить.
const READY_MARKER = '[RE:AD-TEST-READY]';

// Добавляем к промпту технические требования к формату ответа
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

// --- MD-формат единого файла промптов -------------------------------------
// Разбирает MD-текст на промпты по заголовкам верхнего уровня «## Название».
// Первый заголовок уровня 1 (# ...) — название набора, игнорируется.
function parsePromptsMarkdown(md) {
    const list = [];
    const lines = (md || '').split(/\r?\n/);
    let cur = null;
    for (const line of lines) {
        const h = line.match(/^##\s+(.+?)\s*$/);
        if (h) {
            if (cur && cur.body.trim()) list.push(cur);
            cur = { title: h[1].trim(), body: '' };
            continue;
        }
        if (cur) cur.body += line + '\n';
    }
    if (cur && cur.body.trim()) list.push(cur);
    return list.map(item => ({
        id: promptIdFromTitle(item.title),
        name: item.title,
        text: item.body.trim(),
        source: 'gist',
    }));
}

// Генерирует единый MD-файл из текущего списка промптов (для сохранения в Gist)
function buildPromptsMarkdown(prompts) {
    const header = '# Промпты для редактора RE:AD\n\n' +
        'Каждая секция «## Название» — отдельный промпт (режим DeepSeek).\n' +
        'Редактируйте прямо здесь или в редакторе тестов кнопкой «📝 Промпты…» → «💾 Сохранить все в Gist».\n';
    return header + prompts.map(p => '\n## ' + p.name + '\n\n' + (p.text || '(пусто)') + '\n').join('\n---\n');
}

// Стабильный id промпта по названию (кириллица разрешена)
function promptIdFromTitle(title) {
    const slug = (title || '').toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
    return slug || ('prompt-' + Math.random().toString(36).slice(2, 8));
}

// Загрузка ВСЕХ промптов из единого Gist (MD). Локальные правки (promptEdits)
// имеют приоритет над текстом из Gist; локальные (пользовательские) промпты
// всегда остаются в списке. opts.only — обновить только промпт с этим id.
async function loadPromptsFromGists(opts = {}) {
    setStatus('Загрузка промптов с GitHub Gist…');
    let edits = {};
    try { edits = JSON.parse(localStorage.getItem(LS.promptEdits) || '{}'); } catch (e) { edits = {}; }

    const localPrompts = state.prompts.filter(p => p.source === 'local');
    let gistPrompts = [];
    try {
        const md = await fetchGistRaw(getPromptsGistUrl());
        gistPrompts = parsePromptsMarkdown(md);
    } catch (e) {
        console.warn('Не удалось загрузить единый Gist промптов:', e);
    }

    // Если в едином Gist нет встроенных режимов — догружаем их с fallback-ссылок
    for (const b of BUILTIN_PROMPTS) {
        if (!gistPrompts.some(p => p.id === b.id)) {
            try {
                const text = await fetchGistRaw(b.fallbackUrl);
                if (text.trim()) gistPrompts.push({ id: b.id, name: b.name, text: text.trim(), source: 'gist' });
            } catch (e) { /* сеть недоступна — режим останется с пустым текстом */ }
        }
    }

    // Порядок: встроенные первыми (как привычные режимы), остальные — как в Gist
    const ordered = [
        ...BUILTIN_PROMPTS.map(b => gistPrompts.find(p => p.id === b.id)).filter(Boolean),
        ...gistPrompts.filter(p => !BUILTIN_PROMPTS.some(b => b.id === p.id)),
    ];

    if (opts.only) {
        // Обновляем только один промпт из Gist, всё остальное оставляем как есть
        const fresh = ordered.find(p => p.id === opts.only);
        if (fresh) {
            const existing = getPromptById(opts.only);
            if (existing) { existing.text = fresh.text; existing.name = fresh.name; existing.source = 'gist'; }
            else state.prompts.push(fresh);
        }
    } else {
        state.prompts = [...ordered, ...localPrompts];
    }

    // Восстанавливаем локальные правки поверх загруженных текстов
    for (const p of state.prompts) {
        if (typeof edits[p.id] === 'string' && edits[p.id].trim()) p.text = edits[p.id];
    }

    renderModeSelect();
    if (!els.promptsModal.classList.contains('hidden')) renderPromptList();
    const okCount = state.prompts.filter(p => p.text).length;
    if (okCount === state.prompts.length && okCount > 0) setStatus('Готово: ' + okCount + ' промпт(ов) загружено из Gist');
    else if (okCount > 0) setStatus('Готово: ' + okCount + ' из ' + state.prompts.length + ' промптов имеют текст («↻ Gist» или редактор промпта)');
    else setStatus('Промпты с Gist не загрузились — нажмите «↻ Gist» или отредактируйте промпт вручную');
}

// Перезагрузка всех промптов из Gist (кнопка в окне «Промпты…») — отменяет правки
async function reloadAllPromptsFromGist() {
    localStorage.setItem(LS.promptEdits, '{}');   // отменяем локальные правки текстов
    await loadPromptsFromGists();
    renderPromptList();
    showToast('Все промпты перезагружены из Gist');
}

// --- Окно «Промпты DeepSeek» ------------------------------------------------
function showPromptsModal() {
    els.promptsGistUrl.value = getPromptsGistUrl();
    renderPromptList();
    els.promptsModal.classList.add('show');
}
function hidePromptsModal() {
    els.promptsModal.classList.remove('show');
    renderModeSelect();
}

function renderPromptList() {
    els.promptList.innerHTML = state.prompts.map(p => `
        <li class="prompt-item${p.id === currentDsMode() ? ' active' : ''}" data-id="${escHtml(p.id)}">
            <div class="prompt-item-main">
                <span class="prompt-item-name">${p.source === 'gist' ? '☁' : '📝'} ${escHtml(p.name)}</span>
                <span class="prompt-item-meta">${p.source === 'gist' ? 'из Gist' : 'локальный'} · ${(p.text || '').length} симв.</span>
            </div>
            <div class="prompt-item-actions">
                <button type="button" class="btn btn-sm btn-ghost" data-action="edit" title="Открыть в текстовом редакторе">✎</button>
                ${p.source === 'local' ? '<button type="button" class="btn btn-sm btn-ghost" data-action="remove" title="Удалить локальный промпт">✕</button>' : ''}
            </div>
        </li>`).join('') || '<li class="hint">Промпты не загружены — «↻ Загрузить из Gist».</li>';

    els.promptList.querySelectorAll('.prompt-item').forEach(li => {
        const id = li.dataset.id;
        li.addEventListener('click', (e) => {
            const action = e.target.closest('[data-action]')?.dataset.action;
            if (action === 'edit') { setDsMode(id); openPromptEditor(); return; }
            if (action === 'remove') { removePrompt(id); return; }
            setDsMode(id);          // выбор режима кликом по строке
            renderPromptList();
        });
    });
}

// Добавление своего (локального) промпта
function addLocalPrompt() {
    const name = els.newPromptName.value.trim();
    if (!name) { showToast('Введите название промпта', true); return; }
    let id = promptIdFromTitle(name);
    if (getPromptById(id)) id = id + '-' + Date.now().toString(36);
    state.prompts.push({ id, name, text: '', source: 'local' });
    els.newPromptName.value = '';
    setDsMode(id);
    renderPromptList();
    openPromptEditor();   // сразу предлагаем написать текст
    showToast('Промпт «' + name + '» добавлен. Напишите его текст и сохраните.');
}

function removePrompt(id) {
    const idx = state.prompts.findIndex(p => p.id === id);
    if (idx === -1) return;
    const [removed] = state.prompts.splice(idx, 1);
    const edits = JSON.parse(localStorage.getItem(LS.promptEdits) || '{}');
    delete edits[id];
    localStorage.setItem(LS.promptEdits, JSON.stringify(edits));
    if (currentDsMode() === id) setDsMode(state.prompts[0]?.id || 'paragraphs');
    renderPromptList();
    renderModeSelect();
    showToast('Промпт «' + removed.name + '» удалён');
}

// Сохранение ВСЕХ промптов обратно в тот же самый Gist (MD-файл)
async function savePromptsToGist() {
    const token = getGithubToken();
    if (!token) { showToast('Нужен GitHub Token (⚙ Настройки)', true); return; }
    const url = els.promptsGistUrl.value.trim() || getPromptsGistUrl();
    const md = buildPromptsMarkdown(state.prompts);
    setStatus('Сохранение промптов в Gist…');
    try {
        const gistIdMatch = url.match(/(?:gist\.github\.com|gist\.githubusercontent\.com)\/(?:[^/\s]+\/)?([0-9a-f]{7,})/i);
        let res;
        if (gistIdMatch) {
            // Обновляем существующий Gist: заменяем MD-файл (или добавляем новый)
            const cur = await (await fetch('https://api.github.com/gists/' + gistIdMatch[1], {
                headers: { Authorization: `Bearer ${token}` },
            })).json();
            const oldFilename = Object.keys(cur.files || {})[0] || 'prompts.md';
            res = await fetch('https://api.github.com/gists/' + gistIdMatch[1], {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: { 'prompts.md': { content: md }, ...(oldFilename !== 'prompts.md' ? { [oldFilename]: null } : {}) } }),
            });
        } else {
            // Новый Gist — создаём и запоминаем ссылку
            res = await fetch('https://api.github.com/gists', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: 'Промпты для редактора RE:AD', public: false, files: { 'prompts.md': { content: md } } }),
            });
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error((err.message) || 'HTTP ' + res.status);
        }
        const data = await res.json();
        const newUrl = data.html_url || url;
        localStorage.setItem(LS.promptsGist, newUrl);
        els.promptsGistUrl.value = newUrl;
        updatePromptGistLink();
        // После записи в Gist локальные правки больше не нужны — текст уже там
        localStorage.setItem(LS.promptEdits, '{}');
        state.prompts.forEach(p => { if (p.source === 'local') p.source = 'gist'; });
        renderPromptList();
        setStatus('Промпты сохранены в Gist: ' + newUrl);
        showToast('Все промпты сохранены в Gist');
    } catch (e) {
        setStatus('Ошибка сохранения промптов: ' + e.message);
        showToast('Сохранение промптов: ' + e.message, true);
    }
}

// --- Модальное окно текстового редактора активного промпта ------------------
function openPromptEditor() {
    const p = getPromptById(currentDsMode());
    if (!p) { showToast('Сначала выберите или добавьте промпт', true); return; }
    els.promptEditorArea.value = p.text || '';
    els.promptEditorInfo.textContent =
        'Промпт: «' + p.name + '» (' + (p.source === 'gist' ? 'из Gist' : 'локальный') + '). ' +
        'Правка сохраняется в браузере; чтобы записать её в Gist — «📝 Промпты…» → «💾 Сохранить все в Gist».';
    els.promptEditorModal.classList.add('show');
    els.promptEditorArea.focus();
}
function hidePromptEditor() { els.promptEditorModal.classList.remove('show'); }

function savePromptFromEditor() {
    savePromptEdit(els.promptEditorArea.value);
    renderModeSelect();
    if (!els.promptsModal.classList.contains('hidden')) renderPromptList();
    hidePromptEditor();
    showToast('Промпт сохранён (локально). Для записи в Gist — «💾 Сохранить все в Gist»');
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

// Индикатор прогресса: статусная строка + «живое» оверлей-окно (см. setUiBusy)
let aiProgressTimer = null;
let aiElapsedTimer = null;
let aiProgressDots = 0;
let aiStartedAt = 0;

function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

// Обновление содержимого оверлея (таймер, этап, пульсирующие точки)
function renderAiOverlay() {
    const box = document.getElementById('aiOverlayStage');
    if (!box) return;
    const el = document.getElementById('aiOverlayElapsed');
    if (el && aiStartedAt) el.textContent = fmtElapsed(Date.now() - aiStartedAt);
    box.textContent = els.statusText.textContent.replace(/\s*[·]+\s*$/, '');
    const dots = document.getElementById('aiOverlayDots');
    if (dots) dots.textContent = '·'.repeat(aiProgressDots % 4) || ' ';
}

function setAiProgress(text) {
    setStatus((text || 'DeepSeek: обработка…') + ' ' + '·'.repeat(aiProgressDots % 4));
    renderAiOverlay();
}
function startAiProgress() {
    stopAiProgress();
    aiProgressDots = 0;
    aiStartedAt = Date.now();
    setAiProgress('Отправка запроса в DeepSeek');
    aiProgressTimer = setInterval(() => {
        aiProgressDots++;
        // обновляем только точки, не трогая текст, заданный externally
        const base = els.statusText.textContent.replace(/\s*[·]+\s*$/, '');
        setStatus(base + ' ' + '·'.repeat(aiProgressDots % 4));
        renderAiOverlay();
    }, 500);
    aiElapsedTimer = setInterval(renderAiOverlay, 1000);
}
function updateAiStage(text) {
    if (!state.aiBusy) return;
    setStatus(text + ' ' + '·'.repeat(aiProgressDots % 4));
    renderAiOverlay();
}
function stopAiProgress() {
    if (aiProgressTimer) { clearInterval(aiProgressTimer); aiProgressTimer = null; }
    if (aiElapsedTimer) { clearInterval(aiElapsedTimer); aiElapsedTimer = null; }
}

// Блокировка/разблокировка интерфейса на время обращения к DeepSeek.
// Окно ожидания сделано выразительным: градиентная карточка, «орбита» со
// спутником вместо обычного спиннера, живой таймер и смена этапов запроса.
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
                '<div class="ai-orbit" aria-hidden="true">' +
                '<span class="ai-core">✨</span>' +
                '<span class="ai-satellite"></span>' +
                '<span class="ai-ring ai-ring-1"></span>' +
                '<span class="ai-ring ai-ring-2"></span>' +
                '</div>' +
                '<div class="ai-overlay-title">DeepSeek думает<span class="ai-dots"><span>.</span><span>.</span><span>.</span></span></div>' +
                '<div class="ai-overlay-text" id="aiOverlayStage">Отправка запроса…</div>' +
                '<div class="ai-overlay-timer-row">Прошло времени: <span class="ai-timer" id="aiOverlayElapsed">00:00</span><span id="aiOverlayDots"></span></div>' +
                '<div class="ai-overlay-hint">Интерфейс заблокирован до получения ответа — глубокие задания могут занять несколько минут.</div>' +
                '</div>';
            document.body.appendChild(overlay);
        }
        renderAiOverlay();
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
    renderModeSelect();

    const token = getDeepseekToken();
    const xml = els.xmlEditor.value || generateXml();
    if (!xml.trim()) return showToast('XML пуст', true);

    // Промпт должен быть загружен — иначе просим загрузить из Gist
    const activePrompt = getPromptById(mode) || state.prompts[0];
    if (!activePrompt || !activePrompt.text.trim()) {
        showToast('Промпт «' + (activePrompt ? activePrompt.name : mode) + '» ещё не загружен — нажмите «↻ Gist»', true);
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

    const modeName = activePrompt.name;
    // Блокируем интерфейс и показываем прогресс на всё время обращения
    setUiBusy(true, 'DeepSeek (промпт «' + modeName + '»): обработка задания…');
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

// Кнопка «📋 Копировать» — копирует активный промпт в буфер обмена
async function copyPrompt(mode) {
    const p = getPromptById(mode) || state.prompts[0];
    try {
        await navigator.clipboard.writeText(p ? p.text : '');
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
