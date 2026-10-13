'use strict';
// The closed list of renderer -> main channels (PLAN 2.1, 6). Every payload is checked against a
// shape before a handler sees it; handlers answer cb(err, data) and the renderer always receives
// {ok, error, data}, never an exception. While the app is locked (kid mode) only the channels
// marked kid: true are served; everything else answers {ok:false, error:'locked'}.

var RE = {
  id: /^[0-9a-f]{16}$/,
  rangeId: /^r[0-9a-z]{4,16}$/,
  pin: /^[0-9]{4,6}$/,
  token: /^[0-9a-f]{16,64}$/
};

var CHANNELS = {
  'app:state': { kid: true, shape: {} },
  'app:version': { kid: true, shape: {} },
  'app:reveal': { shape: { path: 'string' } },
  'library:list': { kid: true, shape: {} },
  'library:add': { shape: { paths: 'paths' } },
  'library:pick': { shape: {} },
  'library:remove': { shape: { id: 'id' } },
  'library:poster': { kid: true, shape: { id: 'id' } },
  'scan:queue': { shape: { id: 'id' } },
  'scan:pause': { shape: {} },
  'scan:resume': { shape: {} },
  'scan:cancel': { shape: { id: 'id' } },
  'scan:status': { shape: {} },
  'skip:get': { shape: { id: 'id' } },
  'skip:save': { shape: { id: 'id', doc: 'object' } },
  'skip:approve': { shape: { id: 'id', rangeIds: 'rangeIds' } },
  'skip:reject': { shape: { id: 'id', rangeIds: 'rangeIds' } },
  'skip:edit': { shape: { id: 'id', rangeId: 'rangeId', patch: 'object' } },
  'skip:add': { shape: { id: 'id', start: 'number', end: 'number', category: 'string?' } },
  'skip:delete': { shape: { id: 'id', rangeId: 'rangeId' } },
  'skip:undo': { shape: { id: 'id' } },
  'skip:markReviewed': { shape: { id: 'id' } },
  'skip:approveClean': { shape: { id: 'id' } },
  'skip:trust': { shape: { id: 'id' } },
  'skip:thumbs': { shape: { id: 'id', rangeIds: 'rangeIdList' } },
  'skip:strip': { shape: { id: 'id', n: 'count' } },
  'skip:peek': { shape: { id: 'id', rangeId: 'rangeId' } },
  'player:play': { kid: true, shape: { id: 'id', kidMode: 'boolean?', unprotected: 'boolean?' } },
  'player:preview': { shape: { id: 'id' } },
  'player:stop': { kid: true, shape: {} },
  'player:status': { kid: true, shape: {} },
  'pin:status': { kid: true, shape: {} },
  'pin:set': { shape: { pin: 'pin' } },
  'pin:verify': { kid: true, shape: { pin: 'pin', purpose: ['unlock', 'peek'] } },
  'pin:recover': { kid: true, shape: { code: 'string', newPin: 'pin' } },
  'pin:lock': { shape: { reason: 'lockReason?' } },
  'pin:change': { shape: { oldPin: 'pin', newPin: 'pin' } },
  'settings:get': { kid: true, shape: {} },
  'settings:set': { shape: { patch: 'object' } },
  'export:json': { shape: { id: 'id', dir: 'string?' } },
  'export:edl': { shape: { id: 'id', dir: 'string?' } },
  'export:clean': { shape: { id: 'id', dir: 'string?', aac: 'boolean?' } },
  'export:cancel': { shape: {} },
  'export:pickFolder': { shape: {} },
  'import:json': { shape: { token: 'token?', targetId: 'id?' } },
  'help:open': { shape: { doc: ['help', 'licenses'] } },
  'accuracy:run': { shape: { id: 'id' } },
  'app:copyText': { shape: { text: 'string' } },
  'activity:list': { shape: {} }
};

// main -> renderer events (webContents.send); preload.js only forwards these.
var EVENTS = ['scan:progress', 'player:event', 'library:changed', 'toast', 'app:locked', 'app:navigate', 'export:progress', 'settings:changed', 'app:integrity'];

function isPlainObject(v) { return v !== null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]'; }

function checkType(type, v) {
  if (Array.isArray(type)) { return type.indexOf(v) >= 0; }
  switch (type) {
    case 'id': case 'rangeId': case 'pin': case 'token': return typeof v === 'string' && RE[type].test(v);
    case 'string': return typeof v === 'string' && v.length > 0 && v.length <= 32768;
    case 'number': return typeof v === 'number' && isFinite(v);
    case 'lockReason': return v === 'manual' || v === 'idle';
    case 'count': return typeof v === 'number' && Math.floor(v) === v && v >= 1 && v <= 200;
    case 'boolean': return typeof v === 'boolean';
    case 'object': return isPlainObject(v);
    case 'paths': return Array.isArray(v) && v.length >= 1 && v.length <= 200 && v.every(function (p) { return typeof p === 'string' && p.length > 0 && p.length <= 4096; });
    case 'rangeIdList': return Array.isArray(v) && v.length <= 2000 && v.every(function (x) { return typeof x === 'string' && RE.rangeId.test(x); });
    case 'rangeIds': return v === 'all' || (Array.isArray(v) && v.length >= 1 && v.length <= 2000 && v.every(function (x) { return typeof x === 'string' && RE.rangeId.test(x); }));
    default: return false;
  }
}

// -> null when fine, else a short reason.
function validate(channel, payload) {
  var spec = CHANNELS[channel];
  var k, type, optional;
  if (!spec) { return 'unknownChannel'; }
  if (payload === undefined || payload === null) { payload = {}; }
  if (!isPlainObject(payload)) { return 'badPayload'; }
  for (k in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, k) && !Object.prototype.hasOwnProperty.call(spec.shape, k)) { return 'unexpected:' + k; }
  }
  for (k in spec.shape) {
    if (!Object.prototype.hasOwnProperty.call(spec.shape, k)) { continue; }
    type = spec.shape[k];
    optional = typeof type === 'string' && /\?$/.test(type);
    if (optional) { type = type.slice(0, -1); }
    if (payload[k] === undefined) {
      if (!optional) { return 'missing:' + k; }
      continue;
    }
    if (!checkType(type, payload[k])) { return 'bad:' + k; }
  }
  return null;
}

// handlers: {channel: function (payload, ctx, cb(err, data))}; opts: {isLocked(), log, checkSender(event)}
function createIpc(handlers, opts) {
  var o = opts || {};
  var log = o.log || { warn: function () {}, error: function () {} };

  function dispatch(channel, payload, ctx, cb) {
    var reply = typeof cb === 'function' ? cb : function () {};
    var answered = false;
    function answer(res) {
      if (answered) { return; }
      answered = true;
      reply(res);
    }
    try {
      var bad = validate(channel, payload);
      if (bad) { log.warn('ipc refused', channel, bad); answer({ ok: false, error: 'badPayload', data: null }); return; }
      if (o.isLocked && o.isLocked() && !CHANNELS[channel].kid) { answer({ ok: false, error: 'locked', data: null }); return; }
      var fn = handlers[channel];
      if (typeof fn !== 'function') { answer({ ok: false, error: 'notImplemented', data: null }); return; }
      fn(payload || {}, ctx || {}, function (err, data) {
        if (err) {
          answer({ ok: false, error: typeof err === 'string' ? err : (err.code || 'failed'), data: data === undefined ? null : data });
        } else {
          answer({ ok: true, error: null, data: data === undefined ? null : data });
        }
      });
    } catch (e) {
      log.error('ipc handler threw', channel, e);
      answer({ ok: false, error: 'internal', data: null });
    }
  }

  // Wires ipcMain.handle for every channel. The one Promise here is the bridge Electron requires.
  function register(ipcMain) {
    Object.keys(CHANNELS).forEach(function (channel) {
      ipcMain.handle(channel, function (event, payload) {
        return new Promise(function (resolve) {
          if (o.checkSender && !o.checkSender(event)) { resolve({ ok: false, error: 'forbidden', data: null }); return; }
          dispatch(channel, payload, { sender: event.sender }, resolve);
        });
      });
    });
  }

  return { dispatch: dispatch, register: register };
}

module.exports = { CHANNELS: CHANNELS, EVENTS: EVENTS, validate: validate, createIpc: createIpc };
