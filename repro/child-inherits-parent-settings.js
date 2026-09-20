'use strict';
// usage: node p1_subapp_defaults.js <express-root>
const express = require(process.argv[2] || "../");
const http = require('node:http');

const parent = express();
const child = express();

parent.disable('x-powered-by');
parent.set('theme', 'dark'); // custom setting, never set on child

function probe(req, res) {
  res.json({
    app: req.app === parent ? 'parent' : 'child',
    settingXPoweredBy: req.app.enabled('x-powered-by'),
    theme: req.app.get('theme') || null
  });
}
child.get('/probe', probe);
parent.get('/probe', probe);
parent.use('/c', child);

const srv = http.createServer(parent).listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  let n = 0;
  const get = (p, label) => http.get({ port, path: p }, res => {
    let b = '';
    res.on('data', d => { b += d; });
    res.on('end', () => {
      console.log(label, 'header=' + (res.headers['x-powered-by'] || 'ABSENT'), 'body=' + b);
      if (++n === 2) srv.close();
    });
  });
  get('/probe', 'PARENT-ROUTE:');
  get('/c/probe', 'CHILD-ROUTE:');
});
