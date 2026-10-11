-- M0 test (spec 5.4 #3): a box drawn into the video that counts clicks inside it.
local assdraw = require 'mp.assdraw'
local box = { x = 40, y = 120, w = 240, h = 90 }
local overlay = mp.create_osd_overlay('ass-events')
local hits = 0

local function render()
    local w, h = mp.get_osd_size()
    if not w or w == 0 then return end
    overlay.res_x, overlay.res_y = w, h
    local a = assdraw.ass_new()
    a:new_event()
    a:append('{\\an7\\bord2\\shad0\\1c&H40B0FF&\\1a&H60&\\3c&HFFFFFF&}')
    a:pos(0, 0)
    a:draw_start()
    a:rect_cw(box.x, box.y, box.x + box.w, box.y + box.h)
    a:draw_stop()
    a:new_event()
    a:append('{\\an7\\fs26\\bord1}')
    a:pos(box.x + 14, box.y + 28)
    a:append('click-target: ' .. hits)
    overlay.data = a.text
    overlay:update()
end

mp.add_forced_key_binding('MBTN_LEFT', 'click-target', function()
    local pos = mp.get_property_native('mouse-pos')
    if pos and pos.x >= box.x and pos.x <= box.x + box.w and pos.y >= box.y and pos.y <= box.y + box.h then
        hits = hits + 1
        mp.commandv('script-message', 'kaleido-test', 'hit', tostring(hits))
        render()
    end
end)

mp.observe_property('osd-dimensions', 'native', render)
