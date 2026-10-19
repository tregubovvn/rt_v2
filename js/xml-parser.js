/**
 * Разбор XML-файла задания формата <readingTest>.
 */

// Значения по умолчанию для временных нормативов фрагмента (секунды)
const DEFAULT_TIME_EXCELLENT = 120;
const DEFAULT_TIME_GOOD = 200;
// Порог схожести для нестрогой проверки текстовых ответов (Jaro-Winkler)
const DEFAULT_SIMILARITY = 0.8;

/**
 * Парсит строку XML в структуру задания.
 * @param {string} xmlString - содержимое XML-файла.
 * @returns {{topicName: string, fragments: Array}} структура теста.
 * @throws {Error} если XML некорректен или не содержит фрагментов.
 */
export function parseTaskXml(xmlString) {
    const doc = new DOMParser().parseFromString(xmlString, 'text/xml');

    if (doc.querySelector('parsererror')) {
        throw new Error('Некорректный XML');
    }

    const fragmentNodes = doc.querySelectorAll('fragment');
    if (fragmentNodes.length === 0) {
        throw new Error('В файле не найдено ни одного фрагмента');
    }

    const topicNode = doc.querySelector('topicName');

    return {
        topicName: topicNode ? topicNode.textContent.trim() : '',
        fragments: Array.from(fragmentNodes, parseFragment)
    };
}

function parseFragment(node) {
    return {
        text: node.querySelector('text')?.textContent ?? '',
        timeExcellent: parseInt(node.getAttribute('timeExcellent'), 10) || DEFAULT_TIME_EXCELLENT,
        timeGood: parseInt(node.getAttribute('timeGood'), 10) || DEFAULT_TIME_GOOD,
        questions: Array.from(node.querySelectorAll('question'), parseQuestion)
    };
}

function parseQuestion(node) {
    const type = node.getAttribute('type');
    const question = {
        type,
        text: node.querySelector('text')?.textContent ?? '',
        similarity: parseFloat(node.getAttribute('similarity')) || DEFAULT_SIMILARITY
    };

    if (type === 'choice') {
        question.options = Array.from(node.querySelectorAll('option'), (o) => ({
            text: o.textContent,
            correct: o.getAttribute('correct') === 'true'
        }));
    } else {
        question.answer = (node.querySelector('answer')?.textContent ?? '').trim().toLowerCase();
    }

    return question;
}
