function validateDayData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return 'Данные должны быть объектом';
  }

  if (!data.date || typeof data.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    return 'Поле date обязательно в формате YYYY-MM-DD';
  }

  const d = new Date(data.date);
  if (isNaN(d.getTime())) {
    return 'Поле date содержит некорректную дату';
  }

  const arrayFields = ['schedule', 'workTasks', 'homeTasks', 'sport', 'habits', 'notes'];
  for (const field of arrayFields) {
    if (data[field] !== undefined && !Array.isArray(data[field])) {
      return `Поле ${field} должно быть массивом`;
    }
  }

  if (data.weight !== undefined && data.weight !== null) {
    const w = parseFloat(data.weight);
    if (isNaN(w) || w < 0 || w > 999) {
      return 'Поле weight должно быть числом от 0 до 999';
    }
  }

  return null;
}

module.exports = { validateDayData };
