/* عميل صغير لـ Firebase Realtime Database عبر REST + البث اللحظي (EventSource)
 * بدون مكتبة Firebase — يعمل على متصفحات التلفزيونات القديمة. ES5.
 */
(function (global) {
  'use strict';

  function RTDB(baseUrl) {
    this.base = String(baseUrl || '').replace(/\/+$/, '');
  }

  RTDB.prototype.url = function (path) {
    return this.base + '/' + String(path || '').replace(/^\/+|\/+$/g, '') + '.json';
  };

  RTDB.prototype.request = function (method, path, body) {
    return fetch(this.url(path), {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('Firebase ' + r.status + ': ' + t); });
      return r.json();
    });
  };

  RTDB.prototype.get = function (path) { return this.request('GET', path); };
  RTDB.prototype.set = function (path, value) { return this.request('PUT', path, value); };
  // تحديث متعدد المسارات: { "state": {...}, "tv/lastSeen": {".sv":"timestamp"} }
  RTDB.prototype.update = function (path, obj) { return this.request('PATCH', path, obj); };
  RTDB.prototype.remove = function (path) { return this.request('DELETE', path); };

  function setAt(tree, path, value) {
    var parts = String(path || '').split('/').filter(Boolean);
    if (!parts.length) return value == null ? null : value;
    var root = tree && typeof tree === 'object' ? tree : {};
    var node = root;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
      node = node[parts[i]];
    }
    if (value == null) delete node[parts[parts.length - 1]];
    else node[parts[parts.length - 1]] = value;
    return root;
  }

  /**
   * يستمع لتغيّرات المسار ويستدعي onData(tree, changedPath) عند كل تغيير.
   * onStatus('open' | 'error' | 'denied')
   */
  RTDB.prototype.listen = function (path, onData, onStatus) {
    var tree = null, es;
    var self = this;
    function handle(type, e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (er) { return; }
      if (!msg) return;
      if (type === 'put') tree = setAt(tree, msg.path, msg.data);
      else {
        for (var k in msg.data) if (msg.data.hasOwnProperty(k)) {
          tree = setAt(tree, (msg.path === '/' ? '' : msg.path) + '/' + k, msg.data[k]);
        }
      }
      onData(tree, msg.path);
    }
    function open() {
      es = new EventSource(self.url(path));
      es.addEventListener('put', function (e) { handle('put', e); });
      es.addEventListener('patch', function (e) { handle('patch', e); });
      es.addEventListener('cancel', function () { if (onStatus) onStatus('denied'); });
      es.onopen = function () { if (onStatus) onStatus('open'); };
      es.onerror = function () {
        if (onStatus) onStatus('error');
        // EventSource يعيد المحاولة وحده، إلا إذا أُغلق نهائياً
        if (es.readyState === 2) setTimeout(open, 3000);
      };
    }
    open();
    return { close: function () { es && es.close(); } };
  };

  RTDB.TIMESTAMP = { '.sv': 'timestamp' };
  global.RTDB = RTDB;
})(window);
