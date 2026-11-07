/* شاشة الأغاني — منطق التشغيل المشترك بين الشاشة والموبايل
 * دوال نقية: تأخذ البيانات الحالية وتعيد التعديلات المطلوب كتابتها في Firebase.
 * ES5 لتعمل على متصفحات التلفزيونات القديمة.
 */
(function (global) {
  'use strict';

  var DEFAULT_STATE = {
    playlistId: null, index: 0, playing: false,
    volume: 80, muted: false, shuffle: false, repeat: 'all',
    margin: 25, nonce: 0,
    seek: { id: 0, to: 0 },
    reloadId: 0
  };

  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  function uid(n) {
    var chars = 'abcdefghijkmnopqrstuvwxyz23456789', s = '', i;
    var buf = new Uint8Array(n || 10);
    (global.crypto || global.msCrypto).getRandomValues(buf);
    for (i = 0; i < buf.length; i++) s += chars.charAt(buf[i] % chars.length);
    return s;
  }

  // Firebase يحوّل المصفوفات إلى كائنات أحياناً ويحذف الفارغة منها — نعيدها مصفوفات دائماً
  function toArray(v) {
    if (!v) return [];
    var arr = Array.isArray(v) ? v : Object.keys(v).sort(function (a, b) { return a - b; }).map(function (k) { return v[k]; });
    return arr.filter(function (x) { return x != null; });
  }

  function normalize(t) {
    t = t || {};
    var d = {}, k;
    d.playlists = toArray(t.playlists).map(function (p) {
      return { id: p.id, name: p.name || '', items: toArray(p.items) };
    });
    d.state = {};
    for (k in DEFAULT_STATE) {
      d.state[k] = t.state && t.state[k] !== undefined ? t.state[k] : clone(DEFAULT_STATE[k]);
    }
    if (!d.state.seek || typeof d.state.seek.id !== 'number') d.state.seek = { id: 0, to: 0 };
    d.progress = t.progress || { position: 0, duration: 0 };
    d.tv = t.tv || {};
    return d;
  }

  function fail(msg) { throw new Error(msg); }

  function listIndex(d, id) {
    for (var i = 0; i < d.playlists.length; i++) if (d.playlists[i].id === id) return i;
    return -1;
  }
  function findList(d, id) {
    var i = listIndex(d, id);
    if (i < 0) fail('القائمة غير موجودة');
    return d.playlists[i];
  }
  function cleanText(s, max) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
  }

  // ---------- يوتيوب ----------
  function parseYouTubeId(input) {
    var s = String(input || '').trim(), m;
    if (/^[\w-]{11}$/.test(s)) return s;
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    m = s.match(/^https?:\/\/([^\/?#]+)([^?#]*)(\?[^#]*)?/i);
    if (!m) return null;
    var host = m[1].toLowerCase().replace(/^(www\.|m\.|music\.)/, ''), path = m[2] || '', query = m[3] || '';
    if (host === 'youtu.be') { m = path.match(/^\/([\w-]{11})/); return m ? m[1] : null; }
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
      m = query.match(/[?&]v=([\w-]{11})/); if (m) return m[1];
      m = path.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/); if (m) return m[1];
    }
    return null;
  }
  function parseLinks(text) {
    var seen = {}, out = [];
    String(text || '').split(/[\s,]+/).forEach(function (part) {
      var id = part && parseYouTubeId(part);
      if (id && !seen[id]) { seen[id] = 1; out.push(id); }
    });
    return out.slice(0, 50);
  }

  // ---------- منطق التشغيل ----------
  function loadAt(d, playlistId, index, play) {
    var i = listIndex(d, playlistId);
    if (i < 0 || !d.playlists[i].items.length) return false;
    var n = d.playlists[i].items.length;
    d.state.playlistId = playlistId;
    d.state.index = Math.max(0, Math.min(index, n - 1));
    d.state.playing = play !== false;
    d.state.nonce++;
    d.progress = { position: 0, duration: 0 };
    d._progressChanged = true;
    return true;
  }
  function stopAll(d) {
    d.state.playing = false;
    d.state.playlistId = null;
    d.state.index = 0;
    d.state.nonce++;
  }
  function currentExists(d) {
    var i = listIndex(d, d.state.playlistId);
    return i >= 0 && !!d.playlists[i].items[d.state.index];
  }
  function step(d, dir, auto) {
    var i = listIndex(d, d.state.playlistId);
    if (i < 0) return;
    var n = d.playlists[i].items.length, cur = d.state.index, next;
    if (!n) return;
    if (auto && d.state.repeat === 'one') { loadAt(d, d.state.playlistId, cur); return; }
    if (d.state.shuffle && n > 1) {
      do { next = Math.floor(Math.random() * n); } while (next === cur);
    } else next = cur + dir;
    if (next >= n) {
      if (auto && d.state.repeat === 'off') { d.state.playing = false; return; }
      next = 0;
    }
    if (next < 0) next = n - 1;
    loadAt(d, d.state.playlistId, next);
  }
  function seekTo(d, to) {
    d.state.seek = { id: (d.state.seek.id || 0) + 1, to: Math.max(0, to) };
  }

  function command(d, c) {
    var s = d.state;
    switch (c.action) {
      case 'play':
        if (!currentExists(d)) {
          for (var i = 0; i < d.playlists.length; i++) if (d.playlists[i].items.length) { loadAt(d, d.playlists[i].id, 0); break; }
        } else s.playing = true;
        break;
      case 'pause': s.playing = false; break;
      case 'toggle': command(d, { action: s.playing ? 'pause' : 'play' }); break;
      case 'next': step(d, 1); break;
      case 'prev': if ((d.progress.position || 0) > 5) seekTo(d, 0); else step(d, -1); break;
      case 'ended': step(d, 1, true); break;
      case 'playAt': loadAt(d, String(c.playlistId || ''), Number(c.index) || 0); break;
      case 'volume': s.volume = Math.max(0, Math.min(100, Math.round(Number(c.value) || 0))); s.muted = false; break;
      case 'mute': s.muted = !s.muted; break;
      case 'shuffle': s.shuffle = !s.shuffle; break;
      case 'repeat': s.repeat = { all: 'one', one: 'off', off: 'all' }[s.repeat] || 'all'; break;
      case 'seek': seekTo(d, Number(c.to) || 0); break;
      case 'seekBy': seekTo(d, (d.progress.position || 0) + (Number(c.by) || 0)); break;
      case 'margin': s.margin = Math.max(0, Math.min(60, Math.round(Number(c.value) || 0))); break;
      case 'reloadTv': s.reloadId = (s.reloadId || 0) + 1; break;
      case 'stop': stopAll(d); break;
      default: fail('أمر غير معروف');
    }
  }

  /**
   * ينفّذ عملية ويعيد { data: البيانات الجديدة, patch: ما يُكتب في Firebase, extra }
   * metas (لإضافة المقاطع): { videoId: { title, author } }
   */
  function apply(data, action, body, metas) {
    var d = clone(data), extra = {}, touchesLists = true, l, idx, j, t, k, here;
    body = body || {};
    switch (action) {
      case 'cmd':
        command(d, body); touchesLists = false;
        break;
      case 'pl_create':
        t = cleanText(body.name, 60);
        if (!t) fail('اكتب اسم القائمة');
        d.playlists.push({ id: uid(10), name: t, items: [] });
        extra.created = d.playlists[d.playlists.length - 1].id;
        break;
      case 'pl_rename':
        l = findList(d, body.id); t = cleanText(body.name, 60);
        if (t) l.name = t;
        break;
      case 'pl_delete':
        idx = listIndex(d, body.id);
        if (idx < 0) fail('القائمة غير موجودة');
        if (d.state.playlistId === body.id) stopAll(d);
        d.playlists.splice(idx, 1);
        break;
      case 'pl_move':
        idx = listIndex(d, body.id); j = idx + (body.dir < 0 ? -1 : 1);
        if (idx >= 0 && j >= 0 && j < d.playlists.length) { t = d.playlists[idx]; d.playlists[idx] = d.playlists[j]; d.playlists[j] = t; }
        break;
      case 'it_add':
        l = findList(d, body.pl);
        var ids = parseLinks(body.url);
        if (!ids.length) fail('الرابط غير صالح — الصق رابط يوتيوب');
        ids.forEach(function (vid) {
          var m = (metas && metas[vid]) || {};
          l.items.push({ id: uid(10), videoId: vid, title: m.title || 'مقطع يوتيوب', author: m.author || '' });
        });
        extra.added = ids.length;
        break;
      case 'it_delete':
      case 'it_rename':
      case 'it_move':
        l = findList(d, body.pl); idx = -1;
        for (k = 0; k < l.items.length; k++) if (l.items[k].id === body.id) idx = k;
        if (idx < 0) fail('المقطع غير موجود');
        here = d.state.playlistId === body.pl;
        if (action === 'it_delete') {
          l.items.splice(idx, 1);
          if (here) {
            if (!l.items.length) stopAll(d);
            else if (idx < d.state.index) d.state.index--;
            else if (idx === d.state.index) loadAt(d, body.pl, Math.min(idx, l.items.length - 1), d.state.playing);
          }
        } else if (action === 'it_rename') {
          t = cleanText(body.title, 150);
          if (t) l.items[idx].title = t;
        } else {
          j = idx + (body.dir < 0 ? -1 : 1);
          if (j >= 0 && j < l.items.length) {
            t = l.items[idx]; l.items[idx] = l.items[j]; l.items[j] = t;
            if (here) {
              if (d.state.index === idx) d.state.index = j;
              else if (d.state.index === j) d.state.index = idx;
            }
          }
        }
        break;
      default:
        fail('عملية غير معروفة');
    }
    var patch = { state: d.state };
    if (touchesLists) patch.playlists = d.playlists;
    if (d._progressChanged) { patch.progress = d.progress; delete d._progressChanged; }
    return { data: d, patch: patch, extra: extra };
  }

  global.PtvCore = {
    DEFAULT_STATE: DEFAULT_STATE,
    uid: uid, clone: clone, normalize: normalize, apply: apply,
    parseYouTubeId: parseYouTubeId, parseLinks: parseLinks
  };
})(window);
