import express from 'express';
const app = express();
app.get('/x', (req, res) => {
  res.send('<b>' + req.query.name + '</b>');
  eval(req.query.code as string);
  res.redirect(req.query.to as string);
});
