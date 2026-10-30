import { now } from '../db.mjs';

export default {
  name: 'lead-bind',
  on: ['job.started'],
  run(row, ctx) {
    ctx.write("update plate set cleared_at = ? where kind = 'lead-missing' and subject = ? and cleared_at is null", now(), row.subject);
  },
};
