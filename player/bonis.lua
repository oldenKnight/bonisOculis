-- bonis oculis -- mpv enforcement script.
--
-- Reads a bonis oculis skip file (spec/SKIPFILE.md) and obeys it: skip, hide (black + mute),
-- blur (pixelate + mute, falls back to hide) and mute ranges. Provides the parent marking keys,
-- the panic key, and reports to the desktop app with `script-message bonis <json>`.
-- No detection happens here. The skip file is the contract. See player/README.md.
--
-- Lua 5.1/5.2 compatible. UTF-8 source (OSD strings). No network code. No dependencies beyond
-- mpv's own modules.

local mp = require 'mp'
local utils = require 'mp.utils'
local options = require 'mp.options'
local msg = require 'mp.msg'

-------------------------------------------------------------------------------------------------
-- Options (--script-opts-append=bonis-<name>=<value>)
-------------------------------------------------------------------------------------------------
local opts = {
    skipfile = "",
    marks = "",
    kidmode = 0,
    lang = "en",
    panickey = "p",
    markin = "i",
    markout = "o",
    undo = "u",
    leadin = 2,
}
options.read_options(opts, "bonis")

local FORMAT = "bonis-oculis-skip"
local LEAD = 0.05          -- enforce a range from start - LEAD (plan 2.3)
local BLUR_PREARM = 0.5    -- the blur filter is armed this long before start (filter reinit)
local SEEK_GUARD = 0.3     -- do not re-seek to the same target within this many seconds
local BACK_MARGIN = 1.0    -- parent-mode backward seeks into a range land at start - 1
local DROP_LIMIT = 5       -- blur watchdog: more drops than this inside a range -> hide
local PANIC_STEP = 10      -- RIGHT while panic-hidden seeks this far

-------------------------------------------------------------------------------------------------
-- Localised OSD strings
-------------------------------------------------------------------------------------------------
local STRINGS = {
    en = {
        skipped = "Scene skipped",
        hidden = "Scene hidden",
        mark_in = "Mark set at %s",
        mark_out = "Scene marked %s - %s",
        need_in = "Press %s first to mark where the scene starts",
        out_before_in = "The end mark must be after the start mark",
        undo_in = "Start mark removed",
        undo_range = "Last marked scene removed",
        nothing_undo = "Nothing to undo",
        kid_locked = "Not available in kid mode",
        panic_on = "Screen hidden. Press %s or Enter to come back. Right arrow skips ahead.",
        panic_off = "Back. That scene will be skipped next time.",
        load_fail = "Protection list could not be loaded. Playing WITHOUT protection.",
        kid_fail = "This movie is not ready for kid mode. Please ask a parent.",
        reload_ok = "Protection updated (%d scenes)",
        reload_fail = "Protection update failed. Keeping the previous list.",
        save_fail = "Could not save the mark to disk. The app still has it.",
    },
    es = {
        skipped = "Escena omitida",
        hidden = "Escena oculta",
        mark_in = "Marca puesta en %s",
        mark_out = "Escena marcada %s - %s",
        need_in = "Primero presiona %s donde empieza la escena",
        out_before_in = "La marca final debe ir después de la marca inicial",
        undo_in = "Se quitó la marca inicial",
        undo_range = "Se quitó la última escena marcada",
        nothing_undo = "No hay nada que deshacer",
        kid_locked = "No disponible en modo infantil",
        panic_on = "Pantalla oculta. Presiona %s o Enter para volver. Flecha derecha adelanta.",
        panic_off = "Listo. Esa escena se omitirá la próxima vez.",
        load_fail = "No se pudo cargar la lista de protección. Reproduciendo SIN protección.",
        kid_fail = "Esta película no está lista para el modo infantil. Pide ayuda a un adulto.",
        reload_ok = "Protección actualizada (%d escenas)",
        reload_fail = "No se pudo actualizar la protección. Se mantiene la lista anterior.",
        save_fail = "No se pudo guardar la marca en el disco. La app sí la tiene.",
    },
}

local function tr(key)
    local lang = (opts.lang == "es" or string.sub(opts.lang, 1, 2) == "es") and "es" or "en"
    return STRINGS[lang][key] or STRINGS.en[key] or key
end

local function osd(text, seconds)
    mp.osd_message(text, seconds or 1.5)
end

local function hms(t)
    t = math.max(0, math.floor((t or 0) + 0.5))
    return string.format("%02d:%02d:%02d", math.floor(t / 3600), math.floor(t / 60) % 60, t % 60)
end

-------------------------------------------------------------------------------------------------
-- Session state
-------------------------------------------------------------------------------------------------
local kid = (tonumber(opts.kidmode) or 0) == 1
local loaded = false          -- a valid skip file is in force
local load_error = nil        -- last load error message
local offset = 0              -- media.offset of the loaded file
local all_count = 0           -- ranges in the file
local scan_status = nil       -- scan.status of the loaded file
local ranges = {}             -- enforced ranges, playback timeline, sorted by wstart
local maxend = {}             -- prefix max of ranges[i].stop
local session_marks = {}      -- stack of completed manual marks (for undo)
local mark_in = nil           -- pending mark-in (playback time)
local panic = { active = false, start = 0 }
local last_t = nil            -- last observed time-pos
local pre_seek_t = nil        -- time-pos before the current (user) seek
local in_seek = false         -- between a "seek" event and "playback-restart"
local seek_started = nil      -- mp.get_time() when in_seek was set
local own_seek = nil          -- {target, at} of the last seek we issued
local skip_pending = false    -- cover while our own skip seek is in flight
local busy = false            -- re-entrancy guard
local inside = {}             -- ids of ranges currently entered (for one-shot notifications)
local blur_failed = false     -- session-wide: this machine cannot keep up with blur
local blur_base = nil         -- frame-drop-count when the blur filter was applied

local applied = { black = false, mute = false, blur = false }
local saved = { mute = nil, subvis = nil }
local overlay = mp.create_osd_overlay("ass-events")

-------------------------------------------------------------------------------------------------
-- Messages to the app
-------------------------------------------------------------------------------------------------
local function send(tbl)
    local s = utils.format_json(tbl)
    if s then
        mp.commandv("script-message", "bonis", s)
    end
    return s
end

local function append_marks_line(line)
    if not opts.marks or opts.marks == "" then
        return true
    end
    local f = io.open(opts.marks, "a")
    if not f then
        return false
    end
    local ok = f:write(line .. "\n")
    f:flush()
    f:close()
    return ok and true or false
end

-- Write the event to the marks file first (survives the app being gone), then tell the app.
local function record(tbl)
    local line = utils.format_json(tbl)
    if not line then
        return
    end
    if not append_marks_line(line) then
        msg.warn("marks file not writable")
        osd(tr("save_fail"), 3)
    end
    mp.commandv("script-message", "bonis", line)
end

local function new_id()
    local r = math.random(0, 65535)
    return string.format("r%x%04x", os.time(), r)
end

local function round3(x)
    return math.floor(x * 1000 + 0.5) / 1000
end

-------------------------------------------------------------------------------------------------
-- Skip file loading and the range index
-------------------------------------------------------------------------------------------------
local ACTIONS = { skip = true, hide = true, blur = true, mute = true, none = true }
local REVIEWS = { pending = true, approved = true, rejected = true }

local function build_index(list)
    table.sort(list, function(a, b)
        if a.wstart == b.wstart then
            return a.stop < b.stop
        end
        return a.wstart < b.wstart
    end)
    local mx = {}
    local m = -math.huge
    for i = 1, #list do
        if list[i].stop > m then
            m = list[i].stop
        end
        mx[i] = m
    end
    return list, mx
end

local function make_entry(id, start, stop, action)
    local lead = (action == "blur") and BLUR_PREARM or LEAD
    return { id = id, start = start, stop = stop, action = action, wstart = start - lead }
end

-- Returns (doc_info, nil) or (nil, error). Does not touch the session state.
local function parse_skipfile(path)
    if not path or path == "" then
        return nil, "no skip file"
    end
    local f = io.open(path, "rb")
    if not f then
        return nil, "cannot open skip file"
    end
    local text = f:read("*a")
    f:close()
    local doc = utils.parse_json(text or "")
    if type(doc) ~= "table" then
        return nil, "skip file is not valid JSON"
    end
    if doc.format ~= FORMAT then
        return nil, "wrong format"
    end
    if type(doc.version) ~= "number" or doc.version < 1 or doc.version ~= math.floor(doc.version) then
        return nil, "unsupported version"
    end
    if type(doc.ranges) ~= "table" then
        return nil, "missing ranges"
    end
    local off = 0
    if type(doc.media) == "table" and doc.media.offset ~= nil then
        if type(doc.media.offset) ~= "number" then
            return nil, "bad media.offset"
        end
        off = doc.media.offset
    end
    local list = {}
    for i, r in ipairs(doc.ranges) do
        if type(r) ~= "table" or type(r.start) ~= "number" or type(r["end"]) ~= "number"
            or r["end"] <= r.start or r.start < 0 or not ACTIONS[r.action] or not REVIEWS[r.review] then
            return nil, "invalid range #" .. i
        end
        if r.review ~= "rejected" and r.action ~= "none" then
            local s = r.start + off
            local e = r["end"] + off
            if e > 0 then
                list[#list + 1] = make_entry(type(r.id) == "string" and r.id or ("#" .. i),
                    math.max(0, s), e, r.action)
            end
        end
    end
    local status = nil
    if type(doc.scan) == "table" and type(doc.scan.status) == "string" then
        status = doc.scan.status
    end
    local sorted, mx = build_index(list)
    return { ranges = sorted, maxend = mx, offset = off, count = #doc.ranges, status = status }
end

local function kid_ok(info)
    return info ~= nil and info.status ~= "none"
end

local function adopt(info)
    ranges = info.ranges
    maxend = info.maxend
    offset = info.offset
    all_count = info.count
    scan_status = info.status
    loaded = true
    load_error = nil
    inside = {}
end

-- Ranges whose window [wstart, stop) contains t. O(log n + k).
local function active_at(t)
    local out = {}
    local n = #ranges
    if n == 0 or t == nil then
        return out
    end
    local lo, hi, idx = 1, n, 0
    while lo <= hi do
        local mid = math.floor((lo + hi) / 2)
        if ranges[mid].wstart <= t then
            idx = mid
            lo = mid + 1
        else
            hi = mid - 1
        end
    end
    local j = idx
    while j >= 1 and maxend[j] > t do
        if t < ranges[j].stop then
            out[#out + 1] = ranges[j]
        end
        j = j - 1
    end
    return out
end

-------------------------------------------------------------------------------------------------
-- Effects: black overlay, mute, blur filter. Applied as a diff against `applied`.
-------------------------------------------------------------------------------------------------
local function draw_black()
    local d = mp.get_property_native("osd-dimensions") or {}
    local w = (type(d.w) == "number" and d.w > 0) and d.w or 1920
    local h = (type(d.h) == "number" and d.h > 0) and d.h or 1080
    overlay.res_x = w
    overlay.res_y = h
    overlay.data = string.format("{\\an7\\pos(0,0)\\1c&H000000&\\1a&H00&\\bord0\\shad0\\p1}"
        .. "m 0 0 l %d 0 %d %d 0 %d{\\p0}", w, w, h, h)
    overlay:update()
end

local published = nil

local function publish()
    local key = table.concat({ tostring(applied.black), tostring(applied.mute), tostring(applied.blur),
        tostring(panic.active), tostring(kid), tostring(loaded), tostring(#ranges) }, ",")
    if key == published then
        return
    end
    published = key
    mp.set_property_native("user-data/bonis", {
        black = applied.black,
        mute = applied.mute,
        blur = applied.blur,
        panic = panic.active,
        kid = kid,
        loaded = loaded,
        enforced = #ranges,
        at = mp.get_property_number("time-pos"),   -- playback position when this took effect
    })
end

local function set_black(on)
    if on == applied.black then
        return
    end
    applied.black = on
    if on then
        saved.subvis = mp.get_property_bool("sub-visibility")
        mp.set_property_bool("sub-visibility", false)
        draw_black()
    else
        overlay:remove()
        if saved.subvis ~= nil then
            mp.set_property_bool("sub-visibility", saved.subvis)
        end
        saved.subvis = nil
    end
end

local function set_mute(on)
    if on == applied.mute then
        return
    end
    if on then
        saved.mute = mp.get_property_bool("mute")
        applied.mute = true
        mp.set_property_bool("mute", true)
    else
        applied.mute = false
        mp.set_property_bool("mute", saved.mute == true)
        saved.mute = nil
    end
end

-- Returns false when the filter could not be applied.
local function set_blur(on)
    if on == applied.blur then
        return true
    end
    if on then
        local ok = mp.commandv("vf", "add",
            "@bo-blur:lavfi=[scale=iw/24:-2:flags=area,scale=iw*24:-2:flags=neighbor]")
        if not ok then
            return false
        end
        applied.blur = true
        blur_base = mp.get_property_number("frame-drop-count", 0)
    else
        applied.blur = false
        blur_base = nil
        mp.commandv("vf", "remove", "@bo-blur")
    end
    return true
end

local function apply(want)
    if want.blur and not blur_failed then
        if not set_blur(true) then
            msg.warn("blur filter failed; hiding instead")
            blur_failed = true
        end
    end
    if blur_failed or not want.blur then
        if want.blur then
            want.black = true
        end
        set_blur(false)
    end
    set_black(want.black and true or false)
    set_mute(want.mute and true or false)
    publish()
end

local function release_all()
    set_blur(false)
    set_black(false)
    set_mute(false)
    publish()
end

-------------------------------------------------------------------------------------------------
-- Enforcement
-------------------------------------------------------------------------------------------------
local function seek_to(target, why)
    local now = mp.get_time()
    if own_seek and math.abs(own_seek.target - target) < 0.001 and now - own_seek.at < SEEK_GUARD then
        return false
    end
    own_seek = { target = target, at = now, why = why, pending = true }
    msg.debug(string.format("seek %s -> %.3f", why, target))
    mp.commandv("seek", string.format("%.3f", target), "absolute+exact")
    return true
end

local function notify_entries(act)
    local now_in = {}
    for _, r in ipairs(act) do
        now_in[r.id] = true
        if not inside[r.id] then
            send({ t = "skipped", rangeId = r.id, action = r.action })
            if r.action == "skip" then
                osd(tr("skipped"), 1.5)
            elseif r.action == "hide" or r.action == "blur" then
                osd(tr("hidden"), 1.5)
            end
        end
    end
    inside = now_in
end

-- origin: "tick" (time-pos), "seek" (seek event, t is the target), "restart" (playback-restart)
local function evaluate_inner(t, origin)
    local act = active_at(t)
    local want = { black = panic.active, mute = panic.active, blur = false }

    -- A user seek that went backward into a range: parent -> before it, kid -> after it.
    if origin ~= "tick" and pre_seek_t ~= nil and t < pre_seek_t - 0.5 and #act > 0
        and not (own_seek and math.abs(own_seek.target - t) < 0.05) then
        local target
        for _, r in ipairs(act) do
            if kid then
                if not target or r.stop > target then target = r.stop end
            else
                local s = math.max(0, r.start - BACK_MARGIN)
                if not target or s < target then target = s end
            end
        end
        pre_seek_t = nil
        want.black = true
        want.mute = true
        skip_pending = true
        apply(want)
        seek_to(target, "back")
        return
    end

    local skip_target = nil
    for _, r in ipairs(act) do
        if r.action == "skip" then
            if not skip_target or r.stop > skip_target then
                skip_target = r.stop
            end
        elseif r.action == "hide" then
            want.black = true
            want.mute = true
        elseif r.action == "blur" then
            -- muted from the pre-arm point too: never late, at the cost of 0.5 s of early silence
            want.mute = true
            want.blur = true
        elseif r.action == "mute" then
            want.mute = true
        end
    end

    -- Blur watchdog: too many dropped frames inside a blur range -> hide for the session.
    if want.blur and applied.blur and blur_base ~= nil then
        local drops = mp.get_property_number("frame-drop-count", 0)
        if drops - blur_base > DROP_LIMIT then
            msg.warn("blur dropping frames; switching to hide")
            blur_failed = true
        end
    end
    if want.blur and blur_failed then
        want.black = true
        want.mute = true
    end

    if skip_pending then
        want.black = true
        want.mute = true
    end
    if skip_target then
        want.black = true
        want.mute = true
        skip_pending = true
        notify_entries(act)
        apply(want)
        seek_to(skip_target, "skip")
        return
    end
    notify_entries(act)
    apply(want)
end

local function evaluate(t, origin)
    if busy or t == nil then
        return
    end
    busy = true
    local ok, err = pcall(evaluate_inner, t, origin)
    busy = false
    if not ok then
        msg.error("enforcement error: " .. tostring(err))
    end
end

mp.observe_property("time-pos", "number", function(_, t)
    if t == nil then
        return
    end
    if in_seek then
        return
    end
    -- The new position of a seek can arrive here before the "seek" event does. A backward
    -- jump that is not our own seek is handled as a seek so the direction rules apply.
    if last_t ~= nil and t < last_t - 0.5 and not (own_seek and math.abs(own_seek.target - t) < 0.05) then
        msg.debug(string.format("backward jump %.3f -> %.3f", last_t, t))
        pre_seek_t = last_t
        in_seek = true
        seek_started = mp.get_time()
        evaluate(t, "seek")
        return
    end
    last_t = t
    evaluate(t, "tick")
end)

mp.register_event("seek", function()
    local t = mp.get_property_number("time-pos")
    msg.debug(string.format("event seek t=%s last=%s in_seek=%s", tostring(t), tostring(last_t), tostring(in_seek)))
    if not in_seek then
        pre_seek_t = last_t
        seek_started = mp.get_time()
    end
    in_seek = true
    -- time-pos already holds the seek target here: decide now, before any frame of it is
    -- decoded (a skip re-targets the pending seek; hide/mute cover immediately).
    if t ~= nil and #active_at(t) > 0 then
        if not (own_seek and math.abs(own_seek.target - t) < 0.05) then
            skip_pending = true
            evaluate(t, "seek")
        end
    end
end)

mp.register_event("playback-restart", function()
    in_seek = false
    local t = mp.get_property_number("time-pos")
    msg.debug(string.format("event restart t=%s pre=%s", tostring(t), tostring(pre_seek_t)))
    if t == nil then
        return
    end
    -- A restart from an earlier (user) seek can arrive after we issued our own corrective seek.
    -- Ignore it while ours is on its way, or it would be judged again and override ours.
    if own_seek and own_seek.pending then
        if math.abs(own_seek.target - t) < 0.1 or mp.get_time() - own_seek.at > 1.0 then
            own_seek.pending = false
        else
            in_seek = true
            return
        end
    end
    skip_pending = false
    evaluate(t, "restart")
    pre_seek_t = nil
    last_t = t
end)

-- Safety net: never stay covered because a restart event went missing.
mp.add_periodic_timer(1.0, function()
    local stale_seek = in_seek and seek_started and mp.get_time() - seek_started > 3
    local stale_skip = skip_pending and own_seek and mp.get_time() - own_seek.at > 3
    if stale_seek or stale_skip then
        skip_pending = false
        in_seek = false
        evaluate(mp.get_property_number("time-pos"), "tick")
    end
end)

-- Keep holding mute if something else unmutes during a range.
mp.observe_property("mute", "bool", function(_, v)
    if applied.mute and v == false then
        mp.set_property_bool("mute", true)
    end
end)

mp.observe_property("osd-dimensions", "native", function()
    if applied.black then
        draw_black()
    end
end)

local closing = false     -- kid-mode refusal in progress: keep the cover until mpv is gone

mp.register_event("end-file", function()
    if closing then
        return
    end
    release_all()
    inside = {}
end)

-------------------------------------------------------------------------------------------------
-- Load at start, fail closed in kid mode
-------------------------------------------------------------------------------------------------
local function fail_closed(reason)
    closing = true
    mp.set_property_bool("pause", true)
    apply({ black = true, mute = true, blur = false })
    send({ t = "error", msg = reason, code = "kid-refused" })
    osd(tr("kid_fail"), 5)
    mp.add_timeout(1.5, function()
        mp.commandv("quit", 3)
    end)
end

local load_seq = 0           -- increments on every (re)load; lets the app drop duplicate "ready"s

local function ready_message()
    return { t = "ready", seq = load_seq, ranges = all_count, enforced = #ranges, kid = kid, loaded = loaded }
end

local function initial_load()
    load_seq = load_seq + 1
    local info, err = parse_skipfile(opts.skipfile)
    if info and kid and not kid_ok(info) then
        info, err = nil, "scan status is none"
    end
    if info then
        adopt(info)
        send(ready_message())
        return
    end
    load_error = err
    msg.warn("skip file: " .. tostring(err))
    if kid then
        fail_closed(err)
    else
        send({ t = "error", msg = err, code = "skipfile" })
        osd(tr("load_fail"), 5)
        send(ready_message())
    end
end

-- The start position may lie inside a range (resume after a crash): cover from the first frame.
local function cover_start()
    local s = tonumber(mp.get_property("options/start") or "")
    if s ~= nil and #active_at(s) > 0 then
        skip_pending = true
        apply({ black = true, mute = true, blur = false })
    end
end

-------------------------------------------------------------------------------------------------
-- Keys: marking (parent only) and panic (everyone)
-------------------------------------------------------------------------------------------------
local function now_t()
    return mp.get_property_number("time-pos") or last_t or 0
end

local function make_range(start_pt, end_pt, source, review)
    local s = math.max(0, round3(start_pt - offset))
    local e = round3(end_pt - offset)
    if e <= s then
        e = s + 0.5
    end
    return {
        id = new_id(), start = s, ["end"] = e, category = "other", confidence = 1,
        action = "skip", source = source, review = review,
    }
end

local function on_mark_in()
    if kid then
        osd(tr("kid_locked"))
        return
    end
    mark_in = now_t()
    osd(string.format(tr("mark_in"), hms(mark_in)), 2)
end

local function on_mark_out()
    if kid then
        osd(tr("kid_locked"))
        return
    end
    if not mark_in then
        osd(string.format(tr("need_in"), opts.markin), 2)
        return
    end
    local t = now_t()
    if t <= mark_in + 0.1 then
        osd(tr("out_before_in"), 2)
        return
    end
    local range = make_range(mark_in, t, "manual", "pending")
    mark_in = nil
    session_marks[#session_marks + 1] = range.id
    record({ t = "mark", range = range })
    osd(string.format(tr("mark_out"), hms(range.start + offset), hms(range["end"] + offset)), 2)
end

local function on_undo()
    if kid then
        osd(tr("kid_locked"))
        return
    end
    if mark_in then
        mark_in = nil
        osd(tr("undo_in"))
    elseif #session_marks > 0 then
        local id = table.remove(session_marks)
        record({ t = "undo", id = id })
        osd(tr("undo_range"))
    else
        osd(tr("nothing_undo"))
    end
end

-------------------------------------------------------------------------------------------------
-- Kid-mode seek interception. In kid mode every key bound to a seek-like command is taken over:
-- the script computes the target first and, when it falls inside an enforced range, asks mpv for
-- the range end (forward) or start - 1 s (backward) instead, so a kid's seek never lands inside a
-- range. The post-hoc enforcement above stays as the safety net (IPC seeks, other scripts).
-------------------------------------------------------------------------------------------------
local function safe_target(target, forward)
    local dur = mp.get_property_number("duration")
    for _ = 1, 50 do
        if target < 0 then
            target = 0
        end
        if dur and target >= dur then
            return dur
        end
        local act = active_at(target)
        if #act == 0 then
            return target
        end
        local nt
        for _, r in ipairs(act) do
            if forward then
                if not nt or r.stop > nt then nt = r.stop end
            else
                local s = r.start - BACK_MARGIN
                if not nt or s < nt then nt = s end
            end
        end
        if not forward and nt < 0 then
            forward = true        -- nothing before a range that starts at 0: go past it
            nt = target
        end
        target = nt
    end
    return target
end

local function safe_seek_abs(target)
    local t = now_t()
    seek_to(safe_target(target, target >= t), "kid")
end

local function safe_seek(delta)
    safe_seek_abs(now_t() + delta)
end

local function safe_chapter(delta)
    local list = mp.get_property_native("chapter-list") or {}
    local cur = mp.get_property_number("chapter")
    if #list == 0 or cur == nil then
        return
    end
    local idx = cur + delta
    if idx < 0 then
        safe_seek_abs(0)
    elseif idx < #list then
        safe_seek_abs(list[idx + 1].time)
    end
end

local function safe_frame_step(dir)
    local fps = mp.get_property_number("container-fps") or 25
    local t = now_t()
    local next_t = t + dir / fps
    if #active_at(next_t) > 0 then
        mp.set_property_bool("pause", true)
        seek_to(safe_target(next_t, dir > 0), "kid")
    elseif dir > 0 then
        mp.commandv("frame-step")
    else
        mp.commandv("frame-back-step")
    end
end

local CMD_PREFIXES = { "no%-osd", "osd%-auto", "osd%-bar", "osd%-msg%-bar", "osd%-msg", "raw",
    "expand%-properties", "repeatable", "nonrepeatable", "async", "sync" }

-- Returns a replacement handler for a seek-like input command, or nil.
local function kid_handler(cmd)
    if type(cmd) ~= "string" or cmd:find(";", 1, true) then
        return nil
    end
    local c = cmd:gsub("^%s+", ""):gsub("%s+$", "")
    local changed = true
    while changed do
        changed = false
        for _, p in ipairs(CMD_PREFIXES) do
            local n = c:gsub("^" .. p .. "%s+", "")
            if n ~= c then
                c = n
                changed = true
            end
        end
    end
    local w = {}
    for word in c:gmatch("%S+") do
        w[#w + 1] = (word:gsub('^"(.*)"$', "%1"))
    end
    local name = w[1]
    if name == "seek" then
        local amount = tonumber(w[2])
        local flags = w[3] or ""
        if not amount then
            return nil
        end
        if flags:find("absolute%-percent") then
            return function()
                local d = mp.get_property_number("duration")
                if d then safe_seek_abs(d * amount / 100) end
            end
        elseif flags:find("relative%-percent") then
            return function()
                local d = mp.get_property_number("duration")
                if d then safe_seek(d * amount / 100) end
            end
        elseif flags:find("absolute") then
            return function()
                local d = mp.get_property_number("duration") or 0
                safe_seek_abs(amount < 0 and d + amount or amount)
            end
        end
        return function() safe_seek(amount) end
    elseif (name == "add" or name == "cycle") and w[2] == "chapter" then
        local delta = tonumber(w[3]) or 1
        return function() safe_chapter(delta) end
    elseif name == "frame-step" then
        return function() safe_frame_step(1) end
    elseif name == "frame-back-step" then
        return function() safe_frame_step(-1) end
    elseif name == "sub-seek" or name == "revert-seek" or name == "ab-loop" then
        return function() end       -- could land inside a range; not available to kids
    end
    return nil
end

local kid_keys = {}

local function set_osc(visibility)
    mp.commandv("script-message-to", "osc", "osc-visibility", visibility, "no-osd")
end

local function enable_kid_seeks()
    if #kid_keys > 0 then
        return
    end
    local best = {}
    for _, b in ipairs(mp.get_property_native("input-bindings") or {}) do
        if type(b.key) == "string" and kid_handler(b.cmd) then
            local cur = best[b.key]
            if not cur or (b.priority or 0) > (cur.priority or 0) then
                best[b.key] = b
            end
        end
    end
    for key, b in pairs(best) do
        local name = "bonis-kidseek-" .. (#kid_keys + 1)
        mp.add_forced_key_binding(key, name, kid_handler(b.cmd), { repeatable = true })
        kid_keys[#kid_keys + 1] = name
    end
    set_osc("never")                -- the seek bar is a mouse seek we cannot intercept
    msg.debug("kid seek keys intercepted: " .. #kid_keys)
end

local function disable_kid_seeks()
    for _, name in ipairs(kid_keys) do
        mp.remove_key_binding(name)
    end
    kid_keys = {}
    set_osc("auto")
end

local panic_end

local function panic_start()
    local t = now_t()
    panic.active = true
    panic.start = math.max(0, t - (tonumber(opts.leadin) or 2))
    mp.add_forced_key_binding("RIGHT", "bonis-panic-right", function()
        safe_seek(PANIC_STEP)
    end, { repeatable = true })
    mp.add_forced_key_binding("ENTER", "bonis-panic-enter", function() panic_end() end)
    mp.add_forced_key_binding("KP_ENTER", "bonis-panic-kpenter", function() panic_end() end)
    apply({ black = true, mute = true, blur = false })
    send({ t = "panic", phase = "start", at = round3(t) })
    osd(string.format(tr("panic_on"), opts.panickey), 4)
end

panic_end = function()
    if not panic.active then
        return
    end
    local t = now_t()
    mp.remove_key_binding("bonis-panic-right")
    mp.remove_key_binding("bonis-panic-enter")
    mp.remove_key_binding("bonis-panic-kpenter")
    local range = make_range(panic.start, t, "panic", "approved")
    record({ t = "panic", phase = "end", at = round3(t), range = range })
    -- Enforce it for the rest of this session too (it is approved).
    local list = {}
    for i = 1, #ranges do
        list[i] = ranges[i]
    end
    list[#list + 1] = make_entry(range.id, range.start + offset, range["end"] + offset, "skip")
    ranges, maxend = build_index(list)
    inside[range.id] = true
    panic.active = false
    osd(tr("panic_off"), 2)
    evaluate(t, "tick")
end

local function on_panic()
    if panic.active then
        panic_end()
    else
        panic_start()
    end
end

mp.add_forced_key_binding(opts.markin, "bonis-mark-in", on_mark_in)
mp.add_forced_key_binding(opts.markout, "bonis-mark-out", on_mark_out)
mp.add_forced_key_binding(opts.undo, "bonis-undo", on_undo)
mp.add_forced_key_binding(opts.panickey, "bonis-panic", on_panic)
mp.add_forced_key_binding("ctrl+SPACE", "bonis-panic-alt", on_panic)

-------------------------------------------------------------------------------------------------
-- Messages from the app: script-message-to bonis <cmd> [arg]
-------------------------------------------------------------------------------------------------
mp.register_script_message("reload", function(path)
    local info, err = parse_skipfile(path)
    if info and kid and not kid_ok(info) then
        info, err = nil, "scan status is none"
    end
    if info then
        opts.skipfile = path
        load_seq = load_seq + 1
        adopt(info)
        osd(string.format(tr("reload_ok"), #ranges), 2)
        send(ready_message())
        evaluate(now_t(), "tick")
    else
        send({ t = "error", msg = tostring(err), code = "reload" })
        if kid and not loaded then
            fail_closed(err)
        else
            osd(tr("reload_fail"), 3)
        end
    end
end)

mp.register_script_message("set-kidmode", function(v)
    kid = (v == "1" or v == "yes" or v == "true")
    if kid then
        enable_kid_seeks()
    else
        disable_kid_seeks()
    end
    publish()
    if kid and (not loaded or scan_status == "none") then
        fail_closed(load_error or "scan status is none")
    end
end)

-- The app connects to IPC after we start; it asks again so nothing is lost.
mp.register_script_message("hello", function()
    if load_error then
        send({ t = "error", msg = load_error, code = kid and "kid-refused" or "skipfile" })
    end
    send(ready_message())
end)

math.randomseed(os.time())
initial_load()
cover_start()
if kid then
    enable_kid_seeks()
end
-- The OSC may load after us; hide its seek bar again once the file is open.
mp.register_event("file-loaded", function()
    if kid then
        set_osc("never")
    end
end)
publish()
