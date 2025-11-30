const express = require('express');

module.exports = function createAuthRoutes(pool, admin, security) {
  const router = express.Router();

  router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
      let user;
      if (email === admin.email && password === admin.password) {
        user = admin;
      } else {
        const { rows } = await pool.query('SELECT id, name, email FROM clients WHERE email = $1 AND access_code = $2 LIMIT 1', [email, password]);
        if (rows[0]) user = { id: rows[0].id, name: rows[0].name, email: rows[0].email, role: 'patient' };
      }
      if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials.' });
      const token = security.signJwt({ id: user.id || 'admin', email: user.email, role: user.role }, security.ACCESS_TOKEN_TTL);
      if (!token) return res.status(500).json({ success: false, message: 'Token error' });
      const rt = security.newRefreshToken();
      await security.storeRefresh({ token: rt, userId: user.id, role: user.role });
      res.cookie('refresh_token', rt, { httpOnly: true, sameSite: 'lax', maxAge: security.REFRESH_TOKEN_TTL * 1000, path: '/api/auth/refresh' });
      return res.json({ success: true, token, user });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  router.post('/refresh', async (req, res) => {
    try {
      const cookies = security.parseCookies(req.headers.cookie);
      const rt = cookies['refresh_token'];
      if (!rt) return res.status(401).json({ message: 'Unauthorized' });
      const info = await security.validateRefresh(rt);
      if (!info) return res.status(401).json({ message: 'Unauthorized' });
      await security.revokeRefresh(rt);
      const newRt = security.newRefreshToken();
      await security.storeRefresh({ token: newRt, userId: info.userId, role: info.role });
      res.cookie('refresh_token', newRt, { httpOnly: true, sameSite: 'lax', maxAge: security.REFRESH_TOKEN_TTL * 1000, path: '/api/auth/refresh' });
      const token = security.signJwt({ id: info.userId || 'admin', role: info.role }, security.ACCESS_TOKEN_TTL);
      return res.json({ token });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  router.post('/logout', async (req, res) => {
    try {
      const cookies = security.parseCookies(req.headers.cookie);
      const rt = cookies['refresh_token'];
      if (rt) await security.revokeRefresh(rt);
      res.cookie('refresh_token', '', { httpOnly: true, sameSite: 'lax', maxAge: 0, path: '/api/auth/refresh' });
      res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
  });

  return router;
};
