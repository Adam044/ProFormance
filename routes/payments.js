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
        id, p.clientId || null, p.sessionId || null, date, Number(p.amount || 0), p.currency || '$',
        p.status || 'paid', p.method || 'cash', p.reference || null, p.note || null
      ]);
      const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
      res.json(rows[0]);
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  function parseRange(q) {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 180*24*60*60*1000);
    return { from, to };
  }

  router.get('/summary', async (req, res) => {
    try {
      const { from, to } = parseRange(req.query);
      const currency = req.query.currency || null;
      const paid = await pool.query(
        `SELECT COALESCE(SUM(amount),0) AS gross, COUNT(*) AS count
         FROM payments
         WHERE status = 'paid' AND date BETWEEN $1 AND $2 ${currency ? 'AND currency = $3' : ''}`,
        currency ? [from, to, currency] : [from, to]
      );
      const pending = await pool.query(
        `SELECT COALESCE(SUM(amount),0) AS balance, COUNT(*) AS count
         FROM payments
         WHERE status <> 'paid' AND date BETWEEN $1 AND $2 ${currency ? 'AND currency = $3' : ''}`,
        currency ? [from, to, currency] : [from, to]
      );
      res.json({
        gross: Number(paid.rows[0].gross || 0),
        countPaid: Number(paid.rows[0].count || 0),
        balance: Number(pending.rows[0].balance || 0),
        pendingCount: Number(pending.rows[0].count || 0)
      });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  router.get('/timeseries', async (req, res) => {
    try {
      const { from, to } = parseRange(req.query);
      const currency = req.query.currency || null;
      const gran = req.query.granularity || 'month';
      const unit = gran === 'day' ? 'day' : (gran === 'week' ? 'week' : 'month');
      const status = (req.query.status === 'all') ? 'all' : 'paid';
      const { rows } = await pool.query(
        `SELECT date_trunc('${unit}', date) AS bucket, COALESCE(SUM(amount),0) AS total
         FROM payments
         WHERE ${status === 'paid' ? "status = 'paid' AND " : ''}date BETWEEN $1 AND $2 ${currency ? 'AND currency = $3' : ''}
         GROUP BY bucket
         ORDER BY bucket ASC`,
        currency ? [from, to, currency] : [from, to]
      );
      res.json(rows.map(r => ({ bucket: r.bucket, total: Number(r.total || 0) })));
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  router.get('/breakdown/methods', async (req, res) => {
    try {
      const { from, to } = parseRange(req.query);
      const currency = req.query.currency || null;
      const status = (req.query.status === 'all') ? 'all' : 'paid';
      const { rows } = await pool.query(
        `SELECT method, COALESCE(SUM(amount),0) AS total
         FROM payments
         WHERE ${status === 'paid' ? "status = 'paid' AND " : ''}date BETWEEN $1 AND $2 ${currency ? 'AND currency = $3' : ''}
         GROUP BY method
         ORDER BY total DESC`,
        currency ? [from, to, currency] : [from, to]
      );
      res.json(rows.map(r => ({ method: r.method || 'unknown', total: Number(r.total || 0) })));
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  router.get('/top-clients', async (req, res) => {
    try {
      const { from, to } = parseRange(req.query);
      const currency = req.query.currency || null;
      const limit = Math.max(1, Math.min(50, Number(req.query.limit || 10)));
      const { rows } = await pool.query(
        `SELECT c.id, c.name, COALESCE(SUM(p.amount),0) AS total
         FROM payments p LEFT JOIN clients c ON p.client_id = c.id
         WHERE p.status = 'paid' AND p.date BETWEEN $1 AND $2 ${currency ? 'AND p.currency = $3' : ''}
         GROUP BY c.id, c.name
         ORDER BY total DESC
         LIMIT $${currency ? 4 : 3}`,
        currency ? [from, to, currency, limit] : [from, to, limit]
      );
      res.json(rows.map(r => ({ id: r.id, name: r.name || 'Unknown', total: Number(r.total || 0) })));
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  return router;
}
