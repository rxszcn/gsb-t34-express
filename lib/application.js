/*!
 * express
 * Copyright(c) 2009-2013 TJ Holowaychuk
 * Copyright(c) 2013 Roman Shtylman
 * Copyright(c) 2014-2015 Douglas Christopher Wilson
 * MIT Licensed
 */

'use strict';

/**
 * Module dependencies.
 * @private
 */

var finalhandler = require('finalhandler');
var debug = require('debug')('express:application');
var View = require('./view');
var http = require('node:http');
var methods = require('./utils').methods;
var compileETag = require('./utils').compileETag;
var compileQueryParser = require('./utils').compileQueryParser;
var compileTrust = require('./utils').compileTrust;
var resolve = require('node:path').resolve;
var once = require('once')
var Router = require('router');

/**
 * Module variables.
 * @private
 */

var slice = Array.prototype.slice;
var flatten = Array.prototype.flat;

/**
 * Application prototype.
 */

var app = exports = module.exports = {};

/**
 * Variable for trust proxy inheritance back-compat
 * @private
 */

var explicitSettingsSymbol = '@@symbol:explicit_settings';

/**
 * Variable recording which app wrote the X-Powered-By header
 * @private
 */

var poweredByOwnerSymbol = '@@symbol:x_powered_by_owner';

/**
 * Initialize the server.
 *
 *   - setup default configuration
 *   - setup default middleware
 *   - setup route reflection methods
 *
 * @private
 */

app.init = function init() {
  var router = null;

  this.cache = Object.create(null);
  this.engines = Object.create(null);
  this.settings = Object.create(null);

  // track settings explicitly set on this app, as opposed
  // to constructor defaults, so mounted apps can tell them apart
  Object.defineProperty(this.settings, explicitSettingsSymbol, {
    configurable: true,
    value: Object.create(null)
  });

  this.defaultConfiguration();

  // Setup getting to lazily add base router
  Object.defineProperty(this, 'router', {
    configurable: true,
    enumerable: true,
    get: function getrouter() {
      if (router === null) {
        router = new Router({
          caseSensitive: this.enabled('case sensitive routing'),
          strict: this.enabled('strict routing')
        });
      }

      return router;
    }
  });
};

/**
 * Initialize application configuration.
 * @private
 */

app.defaultConfiguration = function defaultConfiguration() {
  var env = process.env.NODE_ENV || 'development';

  // default settings
  setDefault(this, 'x-powered-by', true);
  setDefault(this, 'etag', 'weak');
  setDefault(this, 'env', env);
  setDefault(this, 'query parser', 'simple');
  setDefault(this, 'subdomain offset', 2);
  setDefault(this, 'trust proxy', false);

  debug('booting in %s mode', env);

  this.on('mount', function onmount(parent) {
    // drop constructor defaults so that settings explicitly
    // set on the parent are inherited through the prototype
    pruneDefaultSettings(this);

    // inherit protos
    Object.setPrototypeOf(this.request, parent.request)
    Object.setPrototypeOf(this.response, parent.response)
    Object.setPrototypeOf(this.engines, parent.engines)
    Object.setPrototypeOf(this.settings, parent.settings)
  });

  // setup locals
  this.locals = Object.create(null);

  // top-most app is mounted at /
  this.mountpath = '/';

  // default locals
  this.locals.settings = this.settings;

  // default configuration
  setDefault(this, 'view', View);
  setDefault(this, 'views', resolve('views'));
  setDefault(this, 'jsonp callback name', 'callback');

  if (env === 'production') {
    setDefault(this, 'view cache', true);
  }
};

/**
 * Dispatch a req, res pair into the application. Starts pipeline processing.
 *
 * If no callback is provided, then default error handlers will respond
 * in the event of an error bubbling through the stack.
 *
 * @private
 */

app.handle = function handle(req, res, callback) {
  // final handler
  var done = callback || finalhandler(req, res, {
    env: this.get('env'),
    onerror: logerror.bind(this)
  });

  // set powered by header, recording this app as the owner of
  // the write so mounted apps know the framework wrote it
  if (this.enabled('x-powered-by')) {
    res.setHeader('X-Powered-By', 'Express');
    res[poweredByOwnerSymbol] = this;
  } else if (res[poweredByOwnerSymbol] !== undefined
    && hasExplicitSetting(this, 'x-powered-by')
    && res.getHeader('X-Powered-By') === 'Express') {
    // an ancestor app wrote the header from its own settings;
    // this app's explicit setting revokes that write
    res.removeHeader('X-Powered-By');
    delete res[poweredByOwnerSymbol];
  }

  // set circular references
  req.res = res;
  res.req = req;

  // alter the prototypes
  Object.setPrototypeOf(req, this.request)
  Object.setPrototypeOf(res, this.response)

  // setup locals
  if (!res.locals) {
    res.locals = Object.create(null);
  }

  this.router.handle(req, res, done);
};

/**
 * Proxy `Router#use()` to add middleware to the app router.
 * See Router#use() documentation for details.
 *
 * If the _fn_ parameter is an express app, then it will be
 * mounted at the _route_ specified.
 *
 * @public
 */

app.use = function use(fn) {
  var offset = 0;
  var path = '/';

  // default path to '/'
  // disambiguate app.use([fn])
  if (typeof fn !== 'function') {
    var arg = fn;

    while (Array.isArray(arg) && arg.length !== 0) {
      arg = arg[0];
    }

    // first arg is the path
    if (typeof arg !== 'function') {
      offset = 1;
      path = fn;
    }
  }

  var fns = flatten.call(slice.call(arguments, offset), Infinity);

  if (fns.length === 0) {
    throw new TypeError('app.use() requires a middleware function')
  }

  // get router
  var router = this.router;

  fns.forEach(function (fn) {
    // non-express app
    if (!fn || !fn.handle || !fn.set) {
      return router.use(path, fn);
    }

    debug('.use app under %s', path);
    fn.mountpath = path;
    fn.parent = this;

    // restore .app property on req and res
    router.use(path, function mounted_app(req, res, next) {
      var orig = req.app;
      fn.handle(req, res, function (err) {
        Object.setPrototypeOf(req, orig.request)
        Object.setPrototypeOf(res, orig.response)
        next(err);
      });
    });

    // mounted an app
    fn.emit('mount', this);
  }, this);

  return this;
};

/**
 * Proxy to the app `Router#route()`
 * Returns a new `Route` instance for the _path_.
 *
 * Routes are isolated middleware stacks for specific paths.
 * See the Route api docs for details.
 *
 * @public
 */

app.route = function route(path) {
  return this.router.route(path);
};

/**
 * Register the given template engine callback `fn`
 * as `ext`.
 *
 * By default will `require()` the engine based on the
 * file extension. For example if you try to render
 * a "foo.ejs" file Express will invoke the following internally:
 *
 *     app.engine('ejs', require('ejs').__express);
 *
 * For engines that do not provide `.__express` out of the box,
 * or if you wish to "map" a different extension to the template engine
 * you may use this method. For example mapping the EJS template engine to
 * ".html" files:
 *
 *     app.engine('html', require('ejs').renderFile);
 *
 * In this case EJS provides a `.renderFile()` method with
 * the same signature that Express expects: `(path, options, callback)`,
 * though note that it aliases this method as `ejs.__express` internally
 * so if you're using ".ejs" extensions you don't need to do anything.
 *
 * Some template engines do not follow this convention, the
 * [Consolidate.js](https://github.com/tj/consolidate.js)
 * library was created to map all of node's popular template
 * engines to follow this convention, thus allowing them to
 * work seamlessly within Express.
 *
 * @param {String} ext
 * @param {Function} fn
 * @return {app} for chaining
 * @public
 */

app.engine = function engine(ext, fn) {
  if (typeof fn !== 'function') {
    throw new Error('callback function required');
  }

  // get file extension
  var extension = ext[0] !== '.'
    ? '.' + ext
    : ext;

  // store engine
  this.engines[extension] = fn;

  return this;
};

/**
 * Proxy to `Router#param()` with one added api feature. The _name_ parameter
 * can be an array of names.
 *
 * See the Router#param() docs for more details.
 *
 * @param {String|Array} name
 * @param {Function} fn
 * @return {app} for chaining
 * @public
 */

app.param = function param(name, fn) {
  if (Array.isArray(name)) {
    for (var i = 0; i < name.length; i++) {
      this.param(name[i], fn);
    }

    return this;
  }

  this.router.param(name, fn);

  return this;
};

/**
 * Assign `setting` to `val`, or return `setting`'s value.
 *
 *    app.set('foo', 'bar');
 *    app.set('foo');
 *    // => "bar"
 *
 * Mounted servers inherit their parent server's settings.
 *
 * @param {String} setting
 * @param {*} [val]
 * @return {Server} for chaining
 * @public
 */

app.set = function set(setting, val) {
  if (arguments.length === 1) {
    // app.get(setting)
    return this.settings[setting];
  }

  debug('set "%s" to %o', setting, val);

  // set value as explicitly set on this app
  setSetting(this, setting, val, true);

  return this;
};

/**
 * Return the app's absolute pathname
 * based on the parent(s) that have
 * mounted it.
 *
 * For example if the application was
 * mounted as "/admin", which itself
 * was mounted as "/blog" then the
 * return value would be "/blog/admin".
 *
 * @return {String}
 * @private
 */

app.path = function path() {
  return this.parent
    ? this.parent.path() + this.mountpath
    : '';
};

/**
 * Check if `setting` is enabled (truthy).
 *
 *    app.enabled('foo')
 *    // => false
 *
 *    app.enable('foo')
 *    app.enabled('foo')
 *    // => true
 *
 * @param {String} setting
 * @return {Boolean}
 * @public
 */

app.enabled = function enabled(setting) {
  return Boolean(this.set(setting));
};

/**
 * Check if `setting` is disabled.
 *
 *    app.disabled('foo')
 *    // => true
 *
 *    app.enable('foo')
 *    app.disabled('foo')
 *    // => false
 *
 * @param {String} setting
 * @return {Boolean}
 * @public
 */

app.disabled = function disabled(setting) {
  return !this.set(setting);
};

/**
 * Enable `setting`.
 *
 * @param {String} setting
 * @return {app} for chaining
 * @public
 */

app.enable = function enable(setting) {
  return this.set(setting, true);
};

/**
 * Disable `setting`.
 *
 * @param {String} setting
 * @return {app} for chaining
 * @public
 */

app.disable = function disable(setting) {
  return this.set(setting, false);
};

/**
 * Delegate `.VERB(...)` calls to `router.VERB(...)`.
 */

methods.forEach(function (method) {
  app[method] = function (path) {
    if (method === 'get' && arguments.length === 1) {
      // app.get(setting)
      return this.set(path);
    }

    var route = this.route(path);
    route[method].apply(route, slice.call(arguments, 1));
    return this;
  };
});

/**
 * Special-cased "all" method, applying the given route `path`,
 * middleware, and callback to _every_ HTTP method.
 *
 * @param {String} path
 * @param {Function} ...
 * @return {app} for chaining
 * @public
 */

app.all = function all(path) {
  var route = this.route(path);
  var args = slice.call(arguments, 1);

  for (var i = 0; i < methods.length; i++) {
    route[methods[i]].apply(route, args);
  }

  return this;
};

/**
 * Render the given view `name` name with `options`
 * and a callback accepting an error and the
 * rendered template string.
 *
 * Example:
 *
 *    app.render('email', { name: 'Tobi' }, function(err, html){
 *      // ...
 *    })
 *
 * @param {String} name
 * @param {Object|Function} options or fn
 * @param {Function} callback
 * @public
 */

app.render = function render(name, options, callback) {
  var cache = this.cache;
  var done = callback;
  var engines = this.engines;
  var opts = options;
  var view;

  // support callback function as second arg
  if (typeof options === 'function') {
    done = options;
    opts = {};
  }

  // merge options
  var renderOptions = { ...this.locals, ...opts._locals, ...opts };

  // set .cache unless explicitly provided
  if (renderOptions.cache == null) {
    renderOptions.cache = this.enabled('view cache');
  }

  // primed cache
  if (renderOptions.cache) {
    view = cache[name];
  }

  // view
  if (!view) {
    var View = this.get('view');

    view = new View(name, {
      defaultEngine: this.get('view engine'),
      root: this.get('views'),
      engines: engines
    });

    if (!view.path) {
      var dirs = Array.isArray(view.root) && view.root.length > 1
        ? 'directories "' + view.root.slice(0, -1).join('", "') + '" or "' + view.root[view.root.length - 1] + '"'
        : 'directory "' + view.root + '"'
      var err = new Error('Failed to lookup view "' + name + '" in views ' + dirs);
      err.view = view;
      return done(err);
    }

    // prime the cache
    if (renderOptions.cache) {
      cache[name] = view;
    }
  }

  // render
  tryRender(view, renderOptions, done);
};

/**
 * Listen for connections.
 *
 * A node `http.Server` is returned, with this
 * application (which is a `Function`) as its
 * callback. If you wish to create both an HTTP
 * and HTTPS server you may do so with the "http"
 * and "https" modules as shown here:
 *
 *    var http = require('node:http')
 *      , https = require('node:https')
 *      , express = require('express')
 *      , app = express();
 *
 *    http.createServer(app).listen(80);
 *    https.createServer({ ... }, app).listen(443);
 *
 * @return {http.Server}
 * @public
 */

app.listen = function listen() {
  var server = http.createServer(this)
  var args = slice.call(arguments)
  if (typeof args[args.length - 1] === 'function') {
    var done = args[args.length - 1] = once(args[args.length - 1])
    server.once('error', done)
  }
  return server.listen.apply(server, args)
}

/**
 * Log error using console.error.
 *
 * @param {Error} err
 * @private
 */

function logerror(err) {
  /* istanbul ignore next */
  if (this.get('env') !== 'test') console.error(err.stack || err.toString());
}

/**
 * Assign `setting` to `val` on the app, recording whether the
 * value was explicitly set (vs a constructor default), and
 * triggering the derived settings of matched settings.
 *
 * @param {Object} app
 * @param {String} setting
 * @param {*} val
 * @param {Boolean} explicit
 * @private
 */

function setSetting(app, setting, val, explicit) {
  var settings = app.settings;

  // set value
  settings[setting] = val;

  // record explicitly-set settings
  if (explicit) {
    settings[explicitSettingsSymbol][setting] = true;
  }

  // trigger matched settings
  switch (setting) {
    case 'etag':
      setSetting(app, 'etag fn', compileETag(val), explicit);
      break;
    case 'query parser':
      setSetting(app, 'query parser fn', compileQueryParser(val), explicit);
      break;
    case 'trust proxy':
      setSetting(app, 'trust proxy fn', compileTrust(val), explicit);
      break;
  }
}

/**
 * Assign a constructor default `setting` to `val` on the app.
 *
 * @param {Object} app
 * @param {String} setting
 * @param {*} val
 * @private
 */

function setDefault(app, setting, val) {
  setSetting(app, setting, val, false);
}

/**
 * Check if `setting` was explicitly set on the app.
 *
 * @param {Object} app
 * @param {String} setting
 * @return {Boolean}
 * @private
 */

function hasExplicitSetting(app, setting) {
  return app.settings[explicitSettingsSymbol][setting] === true;
}

/**
 * Remove the constructor default settings from the app, keeping
 * only the settings explicitly set on it, so that inherited
 * parent settings are no longer shadowed by own defaults.
 *
 * @param {Object} app
 * @private
 */

function pruneDefaultSettings(app) {
  var settings = app.settings;
  var explicit = settings[explicitSettingsSymbol];
  var keys = Object.keys(settings);

  for (var i = 0; i < keys.length; i++) {
    var setting = keys[i];

    if (explicit[setting] !== true) {
      delete settings[setting];
    }
  }
}

/**
 * Try rendering a view.
 * @private
 */

function tryRender(view, options, callback) {
  try {
    view.render(options, callback);
  } catch (err) {
    callback(err);
  }
}
