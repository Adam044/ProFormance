const express = require('express');
const { v4: uuidv4 } = require('uuid');

module.exports = function createSessionRoutes(pool) {
  const router = express.Router({ mergeParams: true });

  router.post('/:id/sessions', async (req, res) => {
    try {
      const id = uuidv4();
      const date = req.body.date || new Date();
      await pool.query(`INSERT INTO sessions (id, client_id, date, title, note, type, progress, payment_status, currency, payment_type, amount)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
        id, req.params.id, date, req.body.title, req.body.note, 'session', Number(req.body.progress||0), req.body.paymentStatus||'on_hold', req.body.currency||'$', req.body.paymentType||'cash', Number(req.body.amount||0)
      ]);
      await pool.query('UPDATE clients SET last_updated = $1 WHERE id = $2', [new Date(), req.params.id]);
      await pool.query(`INSERT INTO payments (id, client_id, session_id, date, amount, currency, status, method, reference, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
        uuidv4(), req.params.id, id, new Date(date), Number(req.body.amount||0), req.body.currency||'$', req.body.paymentStatus||'on_hold', req.body.paymentType||'cash', null, req.body.note || null
      ]);
      const { rows } = await pool.query('SELECT * FROM sessions WHERE id = $1', [id]);
      res.json(rows[0]);
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  router.put('/:id/sessions/:sessionId', async (req, res) => {
    try {
      const map = { date:'date', title:'title', note:'note', type:'type', progress:'progress', paymentStatus:'payment_status', currency:'currency', paymentType:'payment_type', amount:'amount' };
      const fields = Object.keys(map).filter(k => typeof req.body[k] !== 'undefined');
      if (!fields.length) return res.json({ success: true });
      const sets = fields.map((k,i)=> `${map[k]} = $${i+1}`);
      const values = fields.map(k => (k==='progress'||k==='amount')? Number(req.body[k]): req.body[k]);
      values.push(req.params.sessionId, req.params.id);
      const sql = `UPDATE sessions SET ${sets.join(', ')} WHERE id = $${fields.length+1} AND client_id = $${fields.length+2} RETURNING *`;
      const { rows } = await pool.query(sql, values);
      const s = rows[0];
      if (s) {
        const { rows: existing } = await pool.query('SELECT id FROM payments WHERE session_id = $1', [req.params.sessionId]);
        if (existing[0]) {
          await pool.query(`UPDATE payments SET date = $1, amount = $2, currency = $3, status = $4, method = $5, note = $6 WHERE session_id = $7`, [
            new Date(s.date), Number(s.amount||0), s.currency || '$', s.payment_status || 'on_hold', s.payment_type || 'cash', s.note || null, req.params.sessionId
          ]);
        } else {
          await pool.query(`INSERT INTO payments (id, client_id, session_id, date, amount, currency, status, method, reference, note)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
            uuidv4(), req.params.id, req.params.sessionId, new Date(s.date), Number(s.amount||0), s.currency || '$', s.payment_status || 'on_hold', s.payment_type || 'cash', null, s.note || null
          ]);
        }
      }
      res.json(rows[0]);
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  router.delete('/:id/sessions/:sessionId', async (req, res) => {
    try {
      await pool.query('DELETE FROM sessions WHERE id = $1 AND client_id = $2', [req.params.sessionId, req.params.id]);
      await pool.query('DELETE FROM payments WHERE session_id = $1', [req.params.sessionId]);
      res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  router.post('/:id/sessions/:sessionId/bodymap', async (req, res) => {
    const { region, clear, ...rest } = req.body;
    if (!region) return res.status(400).json({ message: 'Region required' });
    try {
      const { rows } = await pool.query('SELECT body_map FROM sessions WHERE id = $1 AND client_id = $2', [req.params.sessionId, req.params.id]);
      if (!rows[0]) return res.status(404).json({ message: 'Session not found' });
      const bm = rows[0].body_map || {};
      if (clear) { delete bm[region]; } else { bm[region] = { ...(bm[region]||{}), ...rest }; }
      await pool.query('UPDATE sessions SET body_map = $1 WHERE id = $2', [bm, req.params.sessionId]);
      res.json(bm);
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  return router;
};
