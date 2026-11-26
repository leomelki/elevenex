// The Linux helper is bundled as source with the backend. It uses Python's
// standard library and the local X11 socket, including on hosts without Xlib tools.
export const x11Input = String.raw`
class PrivateInput:
    def __init__(self, number, cookie, size):
        self.size = size
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(2)
        self.sock.connect('/tmp/.X11-unix/X%d' % number)
        auth = b'MIT-MAGIC-COOKIE-1'
        self.sock.sendall(struct.pack('<BBHHHHH', 108, 0, 11, 0, len(auth), len(cookie), 0)
                          + auth + bytes((-len(auth)) % 4) + cookie)
        header = self.read(8)
        setup = self.read(struct.unpack_from('<H', header, 6)[0] * 4)
        if header[0] != 1:
            raise RuntimeError('Private display authentication failed')
        vendor_size = struct.unpack_from('<H', setup, 16)[0]
        self.root = struct.unpack_from('<I', setup, 32 + ((vendor_size + 3) & ~3) + 8 * setup[21])[0]
        self.sock.sendall(struct.pack('<BBHH2x8s', 98, 0, 4, 5, b'XTEST'))
        extension = self.reply()
        if not extension[8]:
            raise RuntimeError('Xvfb must provide the XTEST extension')
        self.opcode = extension[9]
        self.sock.sendall(struct.pack('<BBHBxH', self.opcode, 0, 2, 2, 2))
        self.reply()
        self.keys = set()
        self.buttons = set()
        # Prefer the real XKB key for printable characters. Remapping an
        # XF86 multimedia key to a letter can still trigger the physical
        # browser/desktop action in applications that inspect the scan code.
        first, last = setup[26], setup[27]
        self.sock.sendall(struct.pack('<BBHBB2x', 101, 0, 2, first, last-first+1))
        mapping = self.reply()
        stride = mapping[1]
        if not stride or len(mapping) != 32 + 4*stride*(last-first+1):
            raise RuntimeError('Invalid private display keyboard mapping')
        self.printable = {}
        self.text_slots = []
        for code in range(first, last+1):
            symbols = struct.unpack_from('<'+'I'*stride, mapping, 32+4*stride*(code-first))
            if 10 <= code <= 65:
                for level, sym in enumerate(symbols[:2]):
                    if 32 <= sym <= 126:
                        self.printable.setdefault(sym, (code, level == 1))
            elif code > 135 and not any(symbols):
                self.text_slots.append(code)
        self.text_mapping = {}
        self.slot_use = {}
        self.next_slot = 0
        self.focus_on_click = False

    def read(self, size):
        result = bytearray()
        while len(result) < size:
            part = self.sock.recv(size - len(result))
            if not part:
                raise RuntimeError('Private display closed')
            result.extend(part)
        return result

    def reply(self):
        while True:
            packet = self.read(32)
            if packet[0] == 0:
                raise RuntimeError('Private display rejected input')
            if packet[0] == 1:
                length = struct.unpack_from('<I', packet, 4)[0] * 4
                if length > 1048576:
                    raise RuntimeError('Invalid private display reply')
                return packet + self.read(length)

    def fake(self, kind, detail=0, x=0, y=0):
        self.sock.sendall(struct.pack('<BBHBB2xII8xhh8x', self.opcode, 2, 9, kind, detail,
                                      0, self.root if kind == 6 else 0, x, y))

    def atom(self, name):
        raw = name.encode('ascii')
        field = raw + bytes((-len(raw)) % 4)
        self.sock.sendall(struct.pack('<BBHH2x', 16, 1, 2+len(field)//4, len(raw)) + field)
        return struct.unpack_from('<I', self.reply(), 8)[0]

    def property(self, window, prop):
        if not prop:
            return []
        self.sock.sendall(struct.pack('<BBHIIIII', 20, 0, 6, window, prop, 0, 0, 32))
        result = self.reply()
        if result[1] != 32:
            return []
        return [field[0] for field in struct.iter_unpack('<I', result[32:])]

    def place_window(self, window, width, height, border, fit):
        # In the no-WM fallback place only the initial normal window. Let the
        # application position its dialogs, popups and transient helper windows.
        if self.property(window, 68):  # WM_TRANSIENT_FOR
            return
        types = self.property(window, self.atom('_NET_WM_WINDOW_TYPE'))
        if types and self.atom('_NET_WM_WINDOW_TYPE_NORMAL') not in types:
            return
        hints = self.property(window, 40)  # WM_NORMAL_HINTS
        flags = hints[0] if len(hints) >= 15 else 0
        if flags & 1:  # explicit user-positioned geometry
            return
        available_w, available_h = self.size['width'] - 2*border, self.size['height'] - 2*border
        if fit and not (flags & 128) and (not (flags & 64) or hints[9:11] == [1, 1]):
            max_w, max_h = hints[7:9] if flags & 32 else (available_w, available_h)
            min_w, min_h = hints[5:7] if flags & 16 else (1, 1)
            if min_w <= available_w and min_h <= available_h and max_w >= min_w and max_h >= min_h:
                width, height = min(available_w,max_w), min(available_h,max_h)
        x, y = max(0,(available_w-width)//2), max(0,(available_h-height)//2)
        self.sock.sendall(struct.pack('<BBHIH2xiiII', 12,0,7,window,15,x,y,width,height))

    def has_window(self, fit):
        # The only producers on this display are this app and its private WM.
        # Ignore tiny WM ownership windows and input-only helpers.
        self.sock.sendall(struct.pack('<BBHI', 15, 0, 2, self.root))
        tree = self.reply()
        for (window,) in struct.iter_unpack('<I', tree[max(32,len(tree)-256):]):
            try:
                self.sock.sendall(struct.pack('<BBHI', 3, 0, 2, window))
                attrs = self.reply()
                if attrs[26] != 2 or struct.unpack_from('<H', attrs, 12)[0] != 1:
                    continue
                self.sock.sendall(struct.pack('<BBHI', 14, 0, 2, window))
                width, height, border = struct.unpack_from('<HHH', self.reply(), 16)
                if width >= 64 and height >= 64:
                    if self.focus_on_click and not attrs[27]:
                        self.place_window(window,width,height,border,fit)
                    return True
            except RuntimeError:
                continue
        return False

    def click_focus(self):
        if self.focus_on_click:
            self.sock.sendall(struct.pack('<BBHI', 38, 0, 2, self.root))
            child = struct.unpack_from('<I', self.reply(), 12)[0]
            if child:
                self.sock.sendall(struct.pack('<BBHII', 42, 1, 3, child, 0))

    def apply(self, event):
        kind = event['kind']
        if kind in ('move', 'down', 'up', 'wheel'):
            self.fake(6, 0, event['x'], event['y'])
        if kind in ('down', 'up'):
            button = event.get('button', 0) + 1
            if kind == 'down':
                self.click_focus()
                self.buttons.add(button)
            else:
                self.buttons.discard(button)
            self.fake(4 if kind == 'down' else 5, button)
        elif kind == 'wheel':
            for delta, negative, positive in ((event['deltaY'], 4, 5), (event['deltaX'], 6, 7)):
                for _ in range(min(8, math.ceil(abs(delta) / 100))):
                    button = negative if delta < 0 else positive
                    self.fake(4, button)
                    self.fake(5, button)
        elif kind == 'key':
            code = event['keycode']
            if event['down']:
                self.keys.add(code)
            else:
                self.keys.discard(code)
            self.fake(2 if event['down'] else 3, code)
        elif kind == 'text':
            # Applications resolve queued key events against the current keymap.
            # Give distinct committed characters distinct keycodes so an entire
            # IME commit cannot collapse to its last character. Reserve only
            # high private-display codes never used by forwarded physical keys.
            self.sock.sendall(struct.pack('<BBHI', 38, 0, 2, self.root))
            caps_lock = bool(struct.unpack_from('<H', self.reply(), 24)[0] & 2)
            held = [code for code in self.keys if code in (37,50,62,64,105,108,133,134)]
            for code in held:
                self.fake(3, code)
            try:
                for char in event['text']:
                    value = ord(char)
                    ordinary = self.printable.get(value)
                    if ordinary:
                        code, shift = ordinary
                        if caps_lock and (65 <= value <= 90 or 97 <= value <= 122):
                            shift = not shift
                        if shift:
                            self.fake(2, 50)
                        self.fake(2, code)
                        self.fake(3, code)
                        if shift:
                            self.fake(3, 50)
                        continue
                    if not self.text_slots:
                        raise RuntimeError('Private display has no available Unicode input keys')
                    sym = value if value < 256 else 0x01000000 | value
                    code = self.text_mapping.get(sym)
                    if code is None:
                        code = self.text_slots[self.next_slot]
                        self.next_slot = (self.next_slot + 1) % len(self.text_slots)
                        previous = self.slot_use.get(code)
                        if previous:
                            old_symbol, used = previous
                            remaining = used + 0.1 - time.monotonic()
                            if remaining > 0:
                                time.sleep(remaining)
                            self.text_mapping.pop(old_symbol, None)
                        self.sock.sendall(struct.pack('<BBHBB2xIIII', 100, 1, 6, code, 4, sym, sym, sym, sym))
                        self.text_mapping[sym] = code
                    self.slot_use[code] = (sym, time.monotonic())
                    self.fake(2, code)
                    self.fake(3, code)
            finally:
                for code in held:
                    self.fake(2, code)
        elif kind == 'release':
            for code in self.keys:
                self.fake(3, code)
            for button in self.buttons:
                self.fake(5, button)
            self.keys.clear()
            self.buttons.clear()
`;
