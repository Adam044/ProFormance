const express = require('express');
const { v4: uuidv4 } = require('uuid');

module.exports = function createClientRoutes(pool) {
  const router = express.Router();
  const mapClient = (r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    gender: r.gender,
    dob: r.dob,
    accessCode: r.access_code,
    primaryIssue: r.primary_issue,
    status: r.status,
    active: r.active,
    visitMode: r.visit_mode,
    athletic: r.athletic,
    athleticType: r.athletic_type,
    athleticPosition: r.athletic_position,
    occupation: r.occupation,
    medication: r.medication,
    medicationNote: r.medication_note,
    prevInjuryLocation: r.prev_injury_location,
    prevInjuryYear: r.prev_injury_year,
    prevInjuryNote: r.prev_injury_note,
    trainingLoadDays: r.training_load_days,
    suddenLoadChanges: r.sudden_load_changes,
    sleepHours: r.sleep_hours,
    lastUpdated: r.last_updated,
    nextSession: r.next_session,
    bodyMap: r.body_map
  });
  const mapSession = (s) => ({
    id: s.id,
    clientId: s.client_id,
    date: s.date,
    title: s.title,
    note: s.note,
    type: s.type,
    progress: s.progress,
    paymentStatus: s.payment_status,
    currency: s.currency,
    paymentType: s.payment_type,
    amount: s.amount,
    bodyMap: s.body_map
  });

  router.get('/', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM clients ORDER BY last_updated DESC NULLS LAST');
      res.json(rows.map(mapClient));
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  router.get('/:id', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ message: 'Not found' });
      const { rows: sessions } = await pool.query('SELECT * FROM sessions WHERE client_id = $1 ORDER BY date DESC', [req.params.id]);
      const client = mapClient(rows[0]);
      client.history = sessions.map(mapSession);
      res.json(client);
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  router.post('/', async (req, res) => {
    try {
      const accessCode = req.body.accessCode || Math.random().toString(36).slice(-8).toUpperCase();
      const id = uuidv4();
      const now = new Date();
      await pool.query(`INSERT INTO clients (
          id, name, email, phone, gender, dob, access_code, primary_issue, status, active, visit_mode, athletic,
          athletic_type, athletic_position, occupation, medication, medication_note, prev_injury_location,
          prev_injury_year, prev_injury_note, training_load_days, sudden_load_changes, sleep_hours, last_updated,
          next_session, body_map
      ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,'Active',TRUE,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NULL,'{}'::jsonb
      )`, [
        id, req.body.name, req.body.email, req.body.phone, req.body.gender, req.body.dob,
        accessCode, req.body.primaryIssue, req.body.visitMode || 'in_person', req.body.athletic || false,
        req.body.athleticType, req.body.athleticPosition, req.body.occupation, req.body.medication,
        req.body.medicationNote, req.body.prevInjuryLocation, req.body.prevInjuryYear,
        req.body.prevInjuryNote, req.body.trainingLoadDays, req.body.suddenLoadChanges, req.body.sleepHours,
        now
      ]);
      await pool.query(`INSERT INTO sessions (id, client_id, date, title, note, type, progress, payment_status, currency, payment_type, amount)
        VALUES ($1,$2,$3,$4,$5,$6,0,'on_hold','$','cash',0)`, [uuidv4(), id, now, 'File Opened', `Patient registered. Complaint: ${req.body.primaryIssue}`, 'admin']);
      const { rows } = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
      res.json(rows[0]);
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  router.put('/:id', async (req, res) => {
    try {
      const map = {
        name: 'name', email: 'email', phone: 'phone', gender: 'gender', dob: 'dob', primaryIssue: 'primary_issue',
        nextSession: 'next_session', status: 'status', active: 'active', visitMode: 'visit_mode', athletic: 'athletic',
        athleticType: 'athletic_type', athleticPosition: 'athletic_position', occupation: 'occupation', medication: 'medication',
        medicationNote: 'medication_note', prevInjuryLocation: 'prev_injury_location', prevInjuryYear: 'prev_injury_year',
        prevInjuryNote: 'prev_injury_note', trainingLoadDays: 'training_load_days', suddenLoadChanges: 'sudden_load_changes', sleepHours: 'sleep_hours'
      };
      const fields = Object.keys(map).filter(k => typeof req.body[k] !== 'undefined');
      if (!fields.length) return res.json({ success: true });
      const sets = fields.map((k,i) => `${map[k]} = $${i+1}`);
      const values = fields.map(k => req.body[k]);
      values.push(new Date(), req.params.id);
      const sql = `UPDATE clients SET ${sets.join(', ')}, last_updated = $${fields.length+1} WHERE id = $${fields.length+2} RETURNING *`;
      const { rows } = await pool.query(sql, values);
      res.json(rows[0]);
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  router.post('/:id/bodymap', async (req, res) => {
    const { region, clear, ...rest } = req.body;
    if (!region) return res.status(400).json({ message: 'Region required' });
    try {
      const { rows } = await pool.query('SELECT body_map FROM clients WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ message: 'Not found' });
      const bm = rows[0].body_map || {};
      if (clear) { delete bm[region]; } else { bm[region] = { ...(bm[region]||{}), ...rest }; }
      await pool.query('UPDATE clients SET body_map = $1, last_updated = $2 WHERE id = $3', [bm, new Date(), req.params.id]);
      res.json(bm);
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  router.post('/:id/schedule', async (req, res) => {
    const date = req.body.date;
    try {
      if (!date) {
        await pool.query('UPDATE clients SET next_session = NULL WHERE id = $1', [req.params.id]);
        return res.json({ success: true });
      }
      if (new Date(date) <= new Date()) {
        return res.status(400).json({ message: 'Date must be in the future' });
      }
      await pool.query('UPDATE clients SET next_session = $1 WHERE id = $2', [date, req.params.id]);
      res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  return router;
};
