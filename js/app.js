/**
 * RE:AD — основное приложение активного чтения.
 *
 * Экраны: авторизация -> чтение фрагментов с промежуточным тестом ->
 * финальный тест -> результаты.
 */
import { jaroWinkler } from './jaro-winkler.js';
import { parseTaskXml } from './xml-parser.js';

// --- Константы ---
const MAX_QUIZ_ERRORS = 2;          // ошибки в фрагменте до возврата к чтению
const NEXT_QUESTION_DELAY = 800;    // мс, пауза после верного ответа (промежуточный тест)
const FINAL_NEXT_DELAY = 1200;      // мс, пауза перед следующим вопросом финального теста
const WRONG_ANSWER_RESET_DELAY = 1000; // мс, сброс подсветки неверного ответа
const TEACHER_PAGE_URL = 'https://tregubovvn.github.io/rt/right_answer/index.html';

// Оценивание по числу ошибок в финальном тесте: [мин. ошибок, оценка]
const GRADE_SCALE = [
    { minErrors: 10, grade: 2 },
    { minErrors: 6, grade: 3 },
    { minErrors: 4, grade: 4 },
    { minErrors: 0, grade: 5 }
];

// --- Состояние приложения ---
const state = {
    fragments: [],
    currentFragmentIndex: 0,
    currentQuestionIndex: 0,
    mode: 'reading',            // 'reading' | 'quiz' | 'final'
    timerId: null,
    seconds: 0,
    currentErrors: 0,
    results: createResults()
};

function createResults() {
    return { times: [], answers: [] };
}

// --- Элементы DOM ---
const el = {};

function cacheElements() {
    const ids = [
        'main-header', 'header-step', 'header-badge', 'error-counter-box', 'error-count',
        'pips-container', 'screen-auth', 'screen-process', 'screen-result',
        'input-fio', 'topic-name-label', 'file-input', 'file-btn-text', 'file-status',
        'btn-start', 'btn-skip', 'btn-teacher',
        'timer-fill', 'content-area', 'controls-area',
        'final-grade-val', 'final-fio', 'stat-time', 'stat-errors', 'results-table'
    ];
    ids.forEach((id) => { el[id] = document.getElementById(id); });
}

// --- Вспомогательные функции ---

function showScreen(name) {
    el['screen-auth'].classList.toggle('visible', name === 'auth');
    el['screen-process'].classList.toggle('visible', name === 'process');
    el['screen-result'].classList.toggle('visible', name === 'result');
    el['main-header'].style.display = name === 'process' ? 'flex' : 'none';
}

function setHeader(stepText, badgeText, isFinalBadge) {
    el['header-step'].textContent = stepText;
    el['header-badge'].textContent = badgeText;
    el['header-badge'].classList.toggle('badge-final', Boolean(isFinalBadge));
}

function setErrorCounter(visible) {
    el['error-count'].textContent = state.currentErrors;
    el['error-counter-box'].classList.toggle('active', visible);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

/** Все вопросы всех фрагментов одним списком (для финального теста). */
function allQuestions() {
    return state.fragments.flatMap((f) => f.questions);
}

/** Текущий список вопросов в зависимости от режима. */
function currentQuestionList() {
    return state.mode === 'final'
        ? allQuestions()
        : state.fragments[state.currentFragmentIndex].questions;
}

// --- Инициализация и загрузка задания ---

function initFromUrl() {
    const url = new URLSearchParams(window.location.search).get('file');
    if (!url) return;

    setStatus('Загрузка из интернета...', '<span class="loader"></span> Загрузка...');

    fetch(url)
        .then((response) => {
            if (!response.ok) throw new Error('Network error');
            return response.text();
        })
        .then((text) => {
            loadTask(text);
            setStatus('✓ Файл загружен через URL', 'Файл готов');
        })
        .catch((err) => {
            console.error(err);
            setStatus('❌ Ошибка загрузки по ссылке', 'Выбрать XML файл');
        });
}

function setStatus(statusText, btnText) {
    el['file-status'].textContent = statusText;
    if (btnText !== undefined) {
        el['file-btn-text'].innerHTML = btnText;
    }
}

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        if (loadTask(e.target.result)) {
            el['file-status'].textContent = '✓ ' + file.name;
        }
    };
    reader.readAsText(file);
}

/** Загружает XML-строку в состояние приложения. Возвращает true при успехе. */
function loadTask(xmlString) {
    try {
        const task = parseTaskXml(xmlString);
        state.fragments = task.fragments;
        el['topic-name-label'].textContent = task.topicName
            ? 'Тема: ' + task.topicName
            : 'Тема:';
        ['btn-start', 'btn-skip', 'btn-teacher'].forEach((id) => { el[id].disabled = false; });
        return true;
    } catch (err) {
        console.error(err);
        alert('Ошибка парсинга XML: ' + err.message);
        return false;
    }
}

// --- Режим чтения ---

function validateInput() {
    if (!el['input-fio'].value.trim()) {
        alert('Введите ФИО');
        return false;
    }
    if (state.fragments.length === 0) {
        alert('Нет данных');
        return false;
    }
    return true;
}

function startTest() {
    if (!validateInput()) return;

    state.currentFragmentIndex = 0;
    state.results = createResults();

    showScreen('process');
    renderPips();
    showFragment();
}

function renderPips() {
    el['pips-container'].innerHTML = '';
    for (let i = 0; i <= state.fragments.length; i++) {
        const pip = document.createElement('div');
        pip.className = 'pip';
        if (i < state.currentFragmentIndex) pip.classList.add('done');
        if (i === state.currentFragmentIndex) pip.classList.add('active');
        el['pips-container'].appendChild(pip);
    }
}

function showFragment() {
    const frag = state.fragments[state.currentFragmentIndex];

    state.mode = 'reading';
    state.currentErrors = 0;
    setErrorCounter(false);
    setHeader('Фрагмент ' + (state.currentFragmentIndex + 1), 'Чтение', false);

    restartTimer(frag);

    const content = el['content-area'];
    content.innerHTML = escapeHtml(frag.text);
    // Перезапуск анимации появления
    content.style.animation = 'none';
    void content.offsetHeight;
    content.style.animation = '';

    el['controls-area'].innerHTML =
        '<button class="btn" id="btn-ready">Готов к вопросам</button>';
    document.getElementById('btn-ready').addEventListener('click', startQuestions);
}

function restartTimer(frag) {
    clearInterval(state.timerId);
    state.seconds = 0;

    const fill = el['timer-fill'];
    fill.style.width = '0%';
    fill.classList.remove('warning', 'danger');

    state.timerId = setInterval(() => {
        state.seconds++;
        fill.style.width = Math.min(100, (state.seconds / frag.timeGood) * 100) + '%';
        fill.classList.toggle('danger', state.seconds > frag.timeGood);
        fill.classList.toggle('warning', !fill.classList.contains('danger') && state.seconds > frag.timeExcellent);
    }, 1000);
}

// --- Промежуточный тест ---

function startQuestions() {
    clearInterval(state.timerId);

    const frag = state.fragments[state.currentFragmentIndex];
    state.results.times.push({
        spent: state.seconds,
        exc: frag.timeExcellent,
        good: frag.timeGood
    });

    state.mode = 'quiz';
    state.currentQuestionIndex = 0;

    setHeader('Фрагмент ' + (state.currentFragmentIndex + 1), 'Тест', false);
    setErrorCounter(true);

    renderQuestion();
}

function renderQuestion() {
    const list = currentQuestionList();

    if (state.currentQuestionIndex >= list.length) {
        onFragmentQuestionsFinished();
        return;
    }

    const q = list[state.currentQuestionIndex];
    el['header-step'].textContent = 'Вопрос ' + (state.currentQuestionIndex + 1);

    let html = `<div class="question-title">${escapeHtml(q.text)}</div>`;
    if (q.type === 'choice') {
        html += '<div class="options-list">' +
            q.options.map((o) => `<div class="option-item">${escapeHtml(o.text)}</div>`).join('') +
            '</div>';
    } else {
        html += '<input type="text" id="ans-input" class="answer-input" placeholder="Напишите ответ...">';
    }

    el['content-area'].innerHTML = html;
    el['controls-area'].innerHTML =
        '<div class="feedback-msg" id="fb"></div>' +
        '<button class="btn" id="submit-btn">Ответить</button>';

    el['content-area'].querySelectorAll('.option-item').forEach((item) => {
        item.addEventListener('click', () => selectOption(item));
    });
    document.getElementById('submit-btn').addEventListener('click', submitAnswer);
}

/** Все вопросы пройдены: переход к следующему фрагменту или финальному тесту. */
function onFragmentQuestionsFinished() {
    if (state.currentFragmentIndex < state.fragments.length - 1) {
        state.currentFragmentIndex++;
        renderPips();
        showFragment();
    } else {
        finishTest();
    }
}

function selectOption(optionEl) {
    optionEl.parentElement.querySelectorAll('.option-item')
        .forEach((e) => e.classList.remove('selected'));
    optionEl.classList.add('selected');
}

function showFeedback(text, isSuccess) {
    const fb = document.getElementById('fb');
    fb.textContent = text;
    fb.className = 'feedback-msg ' + (isSuccess ? 'fb-success' : 'fb-error');
}

function hideFeedback() {
    const fb = document.getElementById('fb');
    if (fb) fb.style.display = 'none';
}

// --- Проверка ответа ---

/**
 * Определяет, является ли ответ пользователя правильным.
 * @returns {{value: string|null, correct: boolean}} значение ответа и результат проверки.
 */
function checkAnswer(q) {
    if (q.type === 'choice') {
        const selected = el['content-area'].querySelector('.option-item.selected');
        if (!selected) return { value: null, correct: false };
        const value = selected.textContent;
        const correct = q.options.some((o) => o.text === value && o.correct);
        return { value, correct };
    }

    const input = document.getElementById('ans-input');
    const value = input ? input.value.trim() : '';
    if (!value) return { value: null, correct: false };

    // Нестрогая проверка текстового ответа по алгоритму Jaro-Winkler
    const similarity = jaroWinkler(value.toLowerCase(), q.answer);
    return { value, correct: similarity >= q.similarity };
}

function submitAnswer() {
    const q = currentQuestionList()[state.currentQuestionIndex];
    const { value, correct } = checkAnswer(q);

    if (value === null) {
        showFeedback(q.type === 'choice' ? 'Выберите вариант' : 'Введите ответ', false);
        return;
    }

    if (state.mode === 'final') {
        handleFinalAnswer(q, value, correct);
    } else {
        handleQuizAnswer(q, correct);
    }
}

// --- Логика промежуточного теста (обучающий режим) ---

function handleQuizAnswer(q, correct) {
    if (correct) {
        showFeedback('Отлично!', true);
        state.currentErrors = 0;
        setErrorCounter(true);
        state.currentQuestionIndex++;
        setTimeout(renderQuestion, NEXT_QUESTION_DELAY);
        return;
    }

    state.currentErrors++;
    setErrorCounter(true);

    if (state.currentErrors >= MAX_QUIZ_ERRORS) {
        showFeedback('Слишком много ошибок.', false);
        setTimeout(() => {
            alert(`Допущено ${MAX_QUIZ_ERRORS} ошибки. Необходимо перечитать фрагмент.`);
            showFragment();
        }, WRONG_ANSWER_RESET_DELAY);
        return;
    }

    showFeedback('Неверно. Попробуйте еще раз.', false);

    if (q.type === 'choice') {
        el['content-area'].querySelectorAll('.option-item.selected').forEach((item) => {
            item.classList.add('wrong');
            setTimeout(() => {
                item.classList.remove('wrong', 'selected');
                hideFeedback();
            }, WRONG_ANSWER_RESET_DELAY);
        });
    } else {
        const input = document.getElementById('ans-input');
        input.classList.add('invalid');
        setTimeout(() => {
            input.classList.remove('invalid');
            hideFeedback();
        }, WRONG_ANSWER_RESET_DELAY);
    }
}

// --- Финальный тест ---

function startFinalTestStage() {
    state.mode = 'final';
    state.currentQuestionIndex = 0;
    state.currentFragmentIndex = state.fragments.length; // индикатор конца чтения

    renderPips();
    setHeader('Итог', 'Финал', true);
    setErrorCounter(false);
    showFinalIntro('Начать');
}

function startFinalTestDirectly() {
    if (!validateInput()) return;

    state.results = createResults();
    showScreen('process');
    startFinalTestStage();
}

function showFinalIntro(buttonLabel) {
    el['timer-fill'].style.width = '0%';
    el['content-area'].innerHTML =
        '<div class="final-intro"><h2>Финальный тест</h2>' +
        '<p>Проверка знаний по всему материалу.</p></div>';
    el['controls-area'].innerHTML = `<button class="btn" id="btn-begin-final">${buttonLabel}</button>`;
    document.getElementById('btn-begin-final').addEventListener('click', renderQuestion);
}

function handleFinalAnswer(q, value, correct) {
    const btn = document.getElementById('submit-btn');
    btn.disabled = true;

    if (q.type === 'choice') {
        el['content-area'].querySelectorAll('.option-item').forEach((item) => {
            item.classList.add('locked');
            const isCorrectOption = q.options.some((o) => o.text === item.textContent && o.correct);
            if (isCorrectOption) item.classList.add('correct');
            if (item.classList.contains('selected') && !correct) item.classList.add('wrong');
        });
    } else {
        const input = document.getElementById('ans-input');
        input.disabled = true;
        input.style.borderColor = correct ? 'var(--success)' : 'var(--danger)';
    }

    state.results.answers.push({ stage: 'final', text: q.text, answer: value, correct });

    showFeedback(correct ? 'Верно!' : 'Неверно', correct);

    state.currentQuestionIndex++;
    setTimeout(renderQuestion, FINAL_NEXT_DELAY);
}

// --- Результаты ---

function calculateGrade(errors) {
    const rule = GRADE_SCALE.find((r) => errors >= r.minErrors);
    return rule.grade;
}

function finishTest() {
    showScreen('result');

    const finalAnswers = state.results.answers.filter((a) => a.stage === 'final');
    const totalSeconds = state.results.times.reduce((sum, t) => sum + t.spent, 0);
    const errors = finalAnswers.filter((a) => !a.correct).length;

    el['final-fio'].textContent = el['input-fio'].value.trim();
    el['final-grade-val'].textContent = calculateGrade(errors);
    el['stat-time'].textContent =
        Math.floor(totalSeconds / 60) + 'м ' + (totalSeconds % 60) + 'с';
    el['stat-errors'].textContent = errors;

    renderResultsTable(finalAnswers);
}

function renderResultsTable(finalAnswers) {
    const tbody = el['results-table'].querySelector('tbody');
    tbody.innerHTML = '';

    if (finalAnswers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="center">Нет данных</td></tr>';
        return;
    }

    finalAnswers.forEach((a) => {
        const tr = document.createElement('tr');
        const statusClass = a.correct ? 'status-correct' : 'status-wrong';
        const statusText = a.correct ? 'Верно' : 'Ошибка';
        tr.innerHTML =
            `<td>${escapeHtml(a.text)}</td>` +
            `<td>${escapeHtml(a.answer)}</td>` +
            `<td><span class="status-badge ${statusClass}">${statusText}</span></td>`;
        tbody.appendChild(tr);
    });
}

// --- Переход в режим преподавателя ---

function redirectToTeacherPage() {
    const fileParam = new URLSearchParams(window.location.search).get('file');
    if (!fileParam) {
        console.warn('Параметр "file" не найден в URL');
        return;
    }
    window.location.href = `${TEACHER_PAGE_URL}?xml=${encodeURIComponent(fileParam)}`;
}

// --- Точка входа ---

document.addEventListener('DOMContentLoaded', () => {
    cacheElements();

    el['file-input'].addEventListener('change', handleFileSelect);
    document.getElementById('btn-choose-file').addEventListener('click', () => el['file-input'].click());
    el['btn-start'].addEventListener('click', startTest);
    el['btn-skip'].addEventListener('click', startFinalTestDirectly);
    el['btn-teacher'].addEventListener('click', redirectToTeacherPage);

    initFromUrl();
});
