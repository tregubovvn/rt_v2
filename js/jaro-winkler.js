/**
 * Алгоритм нечёткого сравнения строк Jaro-Winkler.
 * Возвращает число от 0 до 1 — степень схожести двух строк.
 * Используется для мягкой проверки текстовых ответов (опечатки, падежи).
 */
export function jaroWinkler(s1, s2) {
    if (s1 === s2) return 1.0;

    const matchWindow = Math.max(s1.length, s2.length) / 2 - 1;
    let matches = 0;
    let transpositions = 0;

    const s1Matches = new Array(s1.length).fill(false);
    const s2Matches = new Array(s2.length).fill(false);

    for (let i = 0; i < s1.length; i++) {
        const start = Math.max(0, i - Math.floor(matchWindow));
        const end = Math.min(i + Math.floor(matchWindow) + 1, s2.length);

        for (let j = start; j < end; j++) {
            if (s2Matches[j] || s1[i] !== s2[j]) continue;
            s1Matches[i] = true;
            s2Matches[j] = true;
            matches++;
            break;
        }
    }

    if (matches === 0) return 0.0;

    let k = 0;
    for (let i = 0; i < s1.length; i++) {
        if (!s1Matches[i]) continue;
        while (!s2Matches[k]) k++;
        if (s1[i] !== s2[k]) transpositions++;
        k++;
    }

    const jaro = (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;

    // Модификация Винклера: учитывается общий префикс (до 4 символов)
    let prefix = 0;
    for (let i = 0; i < Math.min(s1.length, s2.length, 4); i++) {
        if (s1[i] === s2[i]) prefix++;
        else break;
    }

    return jaro + prefix * 0.1 * (1 - jaro);
}
