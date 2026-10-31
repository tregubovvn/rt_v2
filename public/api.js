/**
 * Student Tracker API
 * Простой API для сохранения оценок студентов в Supabase
 * 
 * Использование:
 * <script src="https://tregubovvn.github.io/save_all_result/public/api.js"></script>
 * <script>
 *   StudentAPI.save({
 *     studentId: 'STU001',
 *     activity: 'Лабораторная работа',
 *     grade: '5',
 *     comment: 'Отлично'
 *   }).then(result => {
 *     console.log(result.success ? 'Сохранено!' : 'Ошибка: ' + result.message);
 *   });
 * </script>
 */

const StudentAPI = (function() {
  const SUPABASE_URL = 'https://nfoynqfjkvgtqsgwxves.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5mb3lucWZqa3ZndHFzZ3d4dmVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMzNzc3NDUsImV4cCI6MjEwODk1Mzc0NX0.SR2krMy390zOPeVwUjdBAhufwcj57Kk8VQXqFBu3Fdo';

  /**
   * Сохранить запись
   * @param {Object} data - данные для сохранения
   * @param {string} data.studentId - ИД студента (обязательно)
   * @param {string} data.activity - Название активности (обязательно)
   * @param {string} data.grade - Оценка 0-5 (обязательно)
   * @param {string} [data.comment] - Комментарий (опционально)
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async function save(data) {
    // Валидация
    if (!data || !data.studentId) {
      return { success: false, message: 'Не указан studentId' };
    }
    if (!data.activity) {
      return { success: false, message: 'Не указана activity' };
    }
    if (!data.grade) {
      return { success: false, message: 'Не указана grade' };
    }

    // Проверка ограничения по времени (10 минут)
    try {
      const lastCheck = await checkLastRecord(data.studentId);
      if (!lastCheck.allowed) {
        return { success: false, message: lastCheck.message };
      }
    } catch (e) {
      console.warn('Не удалось проверить ограничение по времени:', e);
    }

    // Формируем данные
    const record = {
      student_id: data.studentId,
      activity: data.activity,
      grade: String(data.grade),
      comment: data.comment || '',
      date_time: new Date().toISOString()
    };

    try {
      const url = `${SUPABASE_URL}/rest/v1/records?apikey=${encodeURIComponent(SUPABASE_KEY)}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(record)
      });

      if (response.ok || response.status === 201) {
        return { 
          success: true, 
          message: 'Запись сохранена',
          record: record
        };
      } else {
        const errorText = await response.text();
        return { 
          success: false, 
          message: 'Ошибка сервера: ' + errorText 
        };
      }
    } catch (error) {
      return { 
        success: false, 
        message: 'Ошибка соединения: ' + error.message 
      };
    }
  }

  /**
   * Получить все записи студента
   * @param {string} studentId - ИД студента
   * @returns {Promise<Array>}
   */
  async function getRecords(studentId) {
    try {
      const url = `${SUPABASE_URL}/rest/v1/records?student_id=eq.${encodeURIComponent(studentId)}&order=date_time.desc&apikey=${encodeURIComponent(SUPABASE_KEY)}`;
      
      const response = await fetch(url, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      });

      if (!response.ok) {
        throw new Error('Ошибка загрузки');
      }

      return await response.json();
    } catch (error) {
      console.error('Ошибка получения записей:', error);
      return [];
    }
  }

  /**
   * Проверка последней записи для ограничения по времени
   */
  async function checkLastRecord(studentId) {
    const url = `${SUPABASE_URL}/rest/v1/records?student_id=eq.${encodeURIComponent(studentId)}&order=date_time.desc&limit=1&apikey=${encodeURIComponent(SUPABASE_KEY)}`;
    
    const response = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });

    if (!response.ok) {
      return { allowed: true };
    }

    const records = await response.json();
    
    if (records.length === 0) {
      return { allowed: true };
    }

    const lastTime = new Date(records[0].date_time).getTime();
    const now = Date.now();
    const diffMinutes = (now - lastTime) / (1000 * 60);

    if (diffMinutes < 10) {
      const remainingMinutes = Math.ceil(10 - diffMinutes);
      return {
        allowed: false,
        message: `Для студента ${studentId} можно сохранять не чаще раза в 10 минут. Подождите ещё ${remainingMinutes} мин.`
      };
    }

    return { allowed: true };
  }

  /**
   * Удалить запись по ID
   * @param {number} id - ID записи
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async function deleteRecord(id) {
    try {
      const url = `${SUPABASE_URL}/rest/v1/records?id=eq.${id}&apikey=${encodeURIComponent(SUPABASE_KEY)}`;
      
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      });

      if (response.ok) {
        return { success: true, message: 'Запись удалена' };
      } else {
        const errorText = await response.text();
        return { success: false, message: 'Ошибка: ' + errorText };
      }
    } catch (error) {
      return { success: false, message: 'Ошибка соединения: ' + error.message };
    }
  }

  /**
   * Получить ссылку на страницу результатов студента
   * @param {string} studentId - ИД студента
   * @returns {string} URL
   */
  function getStudentPageUrl(studentId) {
    const baseUrl = window.location.origin + window.location.pathname.replace(/[^/]*$/, '');
    return `${baseUrl}public/student.html?id=${encodeURIComponent(studentId)}`;
  }

  // Публичный API
  return {
    save: save,
    getRecords: getRecords,
    deleteRecord: deleteRecord,
    getStudentPageUrl: getStudentPageUrl
  };
})();
