const { makeRowRepo } = require('./_rowRepo');

const FIELD_MAP = {
  exercise: 'exercise', sets: 'sets', reps: 'reps', weight: 'weight',
  done: 'done', sortOrder: 'sort_order',
  source: 'source', externalId: 'external_id', lastModifiedBy: 'last_modified_by',
};

const DEFAULTS = { exercise: '', sets: null, reps: null, weight: null, done: 0, lastModifiedBy: 'user' };

const sportRepo = db => makeRowRepo(db, 'sport_sets', FIELD_MAP, DEFAULTS);

module.exports = { sportRepo, SPORT_FIELD_MAP: FIELD_MAP };
