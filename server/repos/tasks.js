const { makeRowRepo } = require('./_rowRepo');

const FIELD_MAP = {
  bucket: 'bucket', text: 'text', done: 'done',
  sortOrder: 'sort_order', carriedFrom: 'carried_from',
};

const DEFAULTS = { bucket: 'work', text: '', done: 0, carriedFrom: null };

function tasksRepo(db) {
  const base = makeRowRepo(db, 'tasks', FIELD_MAP, DEFAULTS);
  return {
    ...base,
    listByBucket(userId, date, bucket) {
      return base.list(userId, date).filter(t => t.bucket === bucket);
    },
  };
}

module.exports = { tasksRepo, TASKS_FIELD_MAP: FIELD_MAP };
