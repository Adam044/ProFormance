const express = require('express');

module.exports = function createPaymentRoutes(pool) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM payments ORDER BY date DESC');
      res.json(rows);
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  router.post('/', async (req, res) => {
    try {
      const { v4: uuidv4 } = require('uuid');
      const id = uuidv4();
      const p = req.body || {};
      const date = p.date ? new Date(p.date) : new Date();
      await pool.query(`INSERT INTO payments (id, client_id, session_id, date, amount, currency, status, method, reference, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
        id, p.clientId || null, p.sessionId || null, date, Number(p.amount || 0), p.currency || '$', p.status || 'paid', p.method || 'cash', p.reference || null, p.note || null
      ]);
      const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
      res.json(rows[0]);
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  return router;
}
