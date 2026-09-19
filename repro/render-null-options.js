'use strict';
// 探针：app.render(name, null, cb) —— 显式传 null 当 options
const fs = require('fs');
const path = require('path');
const express = require('..');

const dir = '/tmp/ex1views';
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'user.x'), 'hello');

const app = express();
app.set('views', dir);
app.set('env', 'production');
app.locals.user = { name: 'tobi' };
app.engine('.x', function (file, options, cb) {
  cb(null, 'rendered, user=' + (options.user ? options.user.name : 'none'));
});

function attempt(label, args) {
  try {
    app.render(...args, function (err, str) {
      console.log(label, '->', err ? 'CALLBACK ERROR: ' + err.constructor.name + ': ' + err.message
                                   : 'OK: ' + str);
    });
  } catch (e) {
    console.log(label, '-> SYNC THROW: ' + e.constructor.name + ': ' + e.message);
  }
}

attempt('render(name, cb)        ', ['user.x']);
attempt('render(name, undefined) ', ['user.x', undefined]);
attempt('render(name, {})        ', ['user.x', {}]);
attempt('render(name, null)      ', ['user.x', null]);
