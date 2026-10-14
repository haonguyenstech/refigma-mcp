"""Resolve a decoded Figma clipboard message into a normalized model, then emit
tree.txt, index.html (+ inline CSS), SVG icons, downloaded images and tokens.

usage: extract.py <msg.json> <root node id> <out dir>
"""
import base64, copy, gzip, hashlib, html, json, math, os, re, shutil, struct, subprocess, sys, time, urllib.parse, urllib.request

MSG, ROOT, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
msg = json.load(gzip.open(MSG) if MSG.endswith('.gz') else open(MSG))
N = msg['nodeChanges']
META = msg.get('__figmeta', {})
if not re.fullmatch(r'[A-Za-z0-9]+', str(META.get('fileKey') or '')): META.pop('fileKey', None)
g = lambda x: f"{x['sessionID']}:{x['localID']}"
byid = {g(n['guid']): n for n in N}
kids = {}
for n in N:
    p = n.get('parentIndex')
    if p: kids.setdefault(g(p['guid']), []).append(n)
for v in kids.values(): v.sort(key=lambda c: c['parentIndex']['position'])

# ---------------------------------------------------------------- styles
# A node keeps whatever paint/effect/typography it had when a style was applied; the style node holds the current
# values (library shadow styles, image fill styles, text styles). Figma's copy handler inlines them for plain nodes
# but not inside instance overrides, and the page document never does: resolve every reference to the style itself.
STYLE_PROPS = {'styleIdForFill': ['fillPaints'], 'styleIdForStrokeFill': ['strokePaints'], 'styleIdForEffect': ['effects'],
               'styleIdForText': ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'paragraphSpacing', 'paragraphIndent',
                                  'textCase', 'textDecoration', 'fontVariations', 'fontVariantCommonLigatures',
                                  'fontVariantContextualLigatures', 'textTracking', 'leadingTrim', 'fontVersion']}
STYLES_BY_KEY = {}
for n in N:
    if n.get('styleType') and n.get('key'): STYLES_BY_KEY.setdefault(n['key'], []).append(n)

def style_node(ref):
    if not ref: return None
    if 'guid' in ref:
        n = byid.get(g(ref['guid'])); return n if n and n.get('styleType') else None
    cands = STYLES_BY_KEY.get((ref.get('assetRef') or {}).get('key'))
    if not cands: return None
    return next((c for c in cands if c.get('version') == ref['assetRef'].get('version')), cands[-1])

def resolve_styles(o):
    for ref, props in STYLE_PROPS.items():
        st = style_node(o.get(ref))
        if st:
            for p in props:
                if p in st: o[p] = copy.deepcopy(st[p])
    # text runs reference styles too; a run's own fields are overrides on top of its style (isOverrideOverTextStyle)
    for run in ((o.get('textData') or {}).get('styleOverrideTable') or []) + (o.get('styleOverrideTable') or []):
        for ref, props in STYLE_PROPS.items():
            st = style_node(run.get(ref))
            if st:
                for p in props:
                    if p in st and p not in run: run[p] = copy.deepcopy(st[p])

# lazily, for the nodes actually rendered: a page document holds ~100k nodes, the frame a few hundred (2s -> ~0).
# Only ever on raw nodes, before overrides are applied: an override's own paints must win over the node's style.
STYLED = set()
def ensure_styles(n):
    if id(n) in STYLED or n.get('styleType'): return n
    STYLED.add(id(n))
    resolve_styles(n)
    for e in (n.get('symbolData') or {}).get('symbolOverrides') or []: resolve_styles(e)
    return n

# ---------------------------------------------------------------- variables / tokens
VARS = {}           # key or guid -> VARIABLE node
for n in N:
    if n.get('type') == 'VARIABLE':
        VARS[g(n['guid'])] = n
        if n.get('key'): VARS[n['key']] = n
SETS = {}
for n in N:
    if n.get('type') == 'VARIABLE_SET':
        SETS[g(n['guid'])] = n
        if n.get('key'): SETS[n['key']] = n

def alias_target(v):
    a = (v or {}).get('value', {}).get('alias', {})
    if 'assetRef' in a: return VARS.get(a['assetRef']['key'])
    if 'guid' in a: return VARS.get(g(a['guid']))

MODE_CTX = [{}]   # stack of {variable set key -> mode id} from variableModeBySetMap on ancestors

def set_key(sid):
    sid = sid or {}
    return sid.get('assetRef', {}).get('key') or (g(sid['guid']) if 'guid' in sid else None)

def resolve_var(var, depth=0):
    """Value of a variable in the active mode (explicit frame mode, else the collection's first mode)."""
    if not var or depth > 10: return None
    sk = set_key(var.get('variableSetID'))
    vset = SETS.get(sk) or {}
    modes = sorted(vset.get('variableSetModes', []), key=lambda m_: m_.get('sortPosition', ''))
    want = MODE_CTX[-1].get(sk) or (g(modes[0]['id']) if modes else None)
    entries = var.get('variableDataValues', {}).get('entries', [])
    e = next((x for x in entries if g(x['modeID']) == want), entries[0] if entries else None)
    if not e: return None
    d = e.get('variableData', {}); val = d.get('value', {})
    if 'alias' in val: return resolve_var(alias_target(d), depth + 1)
    return next((val[k] for k in ('colorValue', 'floatValue', 'textValue', 'boolValue') if k in val), None)

def push_modes(n):
    ctx = dict(MODE_CTX[-1])
    for e in (n.get('variableModeBySetMap') or {}).get('entries', []):
        sk = set_key(e.get('variableSetID') or e.get('setID') or {})
        mid = e.get('variableModeID') or e.get('modeID')
        if sk and mid: ctx[sk] = g(mid)
    MODE_CTX.append(ctx)

USED_TOKENS = {}
def token_of(v):
    t = alias_target(v)
    if t:
        USED_TOKENS[t['name']] = t
        return t['name']

def css_var(name):
    return '--' + re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')

def var_value(var, depth=0):
    """Resolved values of a variable per mode name."""
    out = {}
    sid = var.get('variableSetID') or {}
    vset = SETS.get(sid.get('assetRef', {}).get('key')) or (SETS.get(g(sid['guid'])) if 'guid' in sid else None)
    modes = {g(m['id']): m['name'] for m in (vset or {}).get('variableSetModes', [])}
    for e in var.get('variableDataValues', {}).get('entries', []):
        mode = modes.get(g(e['modeID']), g(e['modeID']))
        d = e.get('variableData', {})
        val = d.get('value', {})
        if 'alias' in val and depth < 8:
            t = alias_target(d)
            if t:
                sub = var_value(t, depth + 1)
                out[mode] = sub.get(mode, next(iter(sub.values()), None)) if sub else None
                continue
        if 'colorValue' in val: out[mode] = rgba(val['colorValue'])
        elif 'floatValue' in val: out[mode] = val['floatValue']
        elif 'textValue' in val: out[mode] = val['textValue']
        elif 'boolValue' in val: out[mode] = val['boolValue']
    return out

# ---------------------------------------------------------------- color / paint helpers
def rgba(c, op=1.0):
    a = c.get('a', 1) * op
    r, gg, b = (round(c[k] * 255) for k in 'rgb')
    return f'#{r:02X}{gg:02X}{b:02X}' if a >= 0.999 else f'rgba({r},{gg},{b},{a:.3f})'.replace('.000)', ')')

def inv(t):
    a, b, c, d, e, f = t['m00'], t['m01'], t['m02'], t['m10'], t['m11'], t['m12']
    det = a * e - b * d or 1e-9
    return {'m00': e / det, 'm01': -b / det, 'm02': (b * f - c * e) / det,
            'm10': -d / det, 'm11': a / det, 'm12': (c * d - a * f) / det}

def apply_t(t, x, y): return (t['m00'] * x + t['m01'] * y + t['m02'], t['m10'] * x + t['m11'] * y + t['m12'])

def paint(p, w, h):
    if not p.get('visible', True): return None
    op = p.get('opacity', 1)
    t = p['type']
    if t == 'SOLID':
        # a bound variable is authoritative; the paint's cached colour can be stale (e.g. after a variant swap)
        var = alias_target(p.get('colorVar'))
        c = resolve_var(var) if var else None
        if isinstance(c, dict):
            if abs(op - c.get('a', 1)) < 0.002 and p['color'].get('a', 1) >= 0.999: op = 1
        else: c = p['color']
        return {'type': 'solid', 'color': rgba(c, op), 'token': token_of(p.get('colorVar'))}
    if t.startswith('GRADIENT'):
        stops = [{'color': rgba(s['color'], op), 'pos': s['position']} for s in p.get('stops', [])]
        it = inv(p.get('transform') or {'m00': 1, 'm01': 0, 'm02': 0, 'm10': 0, 'm11': 1, 'm12': 0})
        if t == 'GRADIENT_LINEAR':
            x0, y0 = apply_t(it, 0, .5); x1, y1 = apply_t(it, 1, .5)
            dx, dy = (x1 - x0) * w, (y1 - y0) * h
            ang = math.degrees(math.atan2(dx, -dy)) % 360
            th = math.radians(ang); ux, uy = math.sin(th), -math.cos(th)
            L = abs(w * ux) + abs(h * uy) or 1
            cx, cy = w / 2, h / 2
            css = []
            for s in stops:
                px, py = x0 * w + s['pos'] * dx, y0 * h + s['pos'] * dy
                css.append(f"{s['color']} {((px - cx) * ux + (py - cy) * uy) / L * 100 + 50:.2f}%")
            return {'type': 'linear', 'angle': round(ang, 2), 'stops': stops, 'p0': (x0 * w, y0 * h), 'p1': (x1 * w, y1 * h),
                    'css': f"linear-gradient({ang:.2f}deg, {', '.join(css)})"}
        cx, cy = apply_t(it, .5, .5); ex, ey = apply_t(it, 1, .5); fx, fy = apply_t(it, .5, 1)
        rx = math.hypot((ex - cx) * w, (ey - cy) * h); ry = math.hypot((fx - cx) * w, (fy - cy) * h)
        css = ', '.join(f"{s['color']} {s['pos'] * 100:.2f}%" for s in stops)
        kind = 'radial' if t == 'GRADIENT_RADIAL' else t[9:].lower()
        if kind == 'angular':
            return {'type': kind, 'stops': stops, 'css': f"conic-gradient(from 90deg at {cx * 100:.2f}% {cy * 100:.2f}%, {css})"}
        return {'type': kind, 'stops': stops, 'c': (cx * w, cy * h), 'r': (rx, ry),
                'css': f"radial-gradient({rx:.1f}px {ry:.1f}px at {cx * 100:.2f}% {cy * 100:.2f}%, {css})"}
    if t == 'IMAGE':
        hsh = (p.get('image') or {}).get('hash')
        return {'type': 'image', 'hash': hsh, 'scale': p.get('imageScaleMode', 'FILL'), 'opacity': op}
    return {'type': t.lower()}

def paints(ps, w, h): return [x for x in (paint(p, w, h) for p in ps or []) if x]

def effect(e):
    if not e.get('visible', True): return None
    t = e['type']
    if t in ('DROP_SHADOW', 'INNER_SHADOW'):
        o = e.get('offset', {})
        return {'type': 'inner' if t == 'INNER_SHADOW' else 'drop', 'x': o.get('x', 0), 'y': o.get('y', 0),
                'blur': e.get('radius', 0), 'spread': e.get('spread', 0),
                'color': rgba((lambda c: c if isinstance(c, dict) else e.get('color', {'r': 0, 'g': 0, 'b': 0, 'a': .25}))(resolve_var(alias_target(e.get('colorVar'))))),
                'token': token_of(e.get('colorVar'))}
    if t in ('FOREGROUND_BLUR', 'LAYER_BLUR'): return {'type': 'blur', 'radius': e.get('radius', 0)}
    if t == 'BACKGROUND_BLUR': return {'type': 'bg-blur', 'radius': e.get('radius', 0)}

# ---------------------------------------------------------------- instance resolution
key = lambda n: g(n.get('overrideKey') or n['guid'])

VISUAL = ('fillPaints', 'strokePaints', 'strokeWeight', 'strokeAlign', 'strokeJoin', 'strokeCap', 'dashPattern',
          'borderStrokeWeightsIndependent', 'borderTopWeight', 'borderRightWeight', 'borderBottomWeight', 'borderLeftWeight',
          'cornerRadius', 'rectangleCornerRadiiIndependent', 'rectangleTopLeftCornerRadius', 'rectangleTopRightCornerRadius',
          'rectangleBottomLeftCornerRadius', 'rectangleBottomRightCornerRadius', 'effects', 'opacity', 'frameMaskDisabled',
          'stackMode', 'stackSpacing', 'stackHorizontalPadding', 'stackVerticalPadding', 'stackPaddingRight', 'stackPaddingBottom',
          'stackPrimaryAlignItems', 'stackCounterAlignItems', 'stackPrimarySizing', 'stackCounterSizing', 'stackWrap', 'stackCounterSpacing',
          'prototypeInteractions')

def apply_ov(n, ov):
    if not ov: return n
    n = copy.copy(n)
    for k, v in ov.items():
        if k == 'guidPath': continue
        if k == 'componentPropAssignments':
            # merge per property definition; the override wins for the props it names
            merged = {g(a['defID']): a for a in n.get(k) or []}
            merged.update({g(a['defID']): a for a in v})
            n[k] = list(merged.values())
        else: n[k] = v
    if n.get('type') == 'INSTANCE' and 'overriddenSymbolID' in ov:
        n['_explicit'] = set(ov)
    return n

def ovmap(entries):
    m = {}
    for e in entries or []:
        path = tuple(g(x) for x in e.get('guidPath', {}).get('guids', []))
        if path: m.setdefault(path, {}).update(e)
    # one node can have several entries (a style reference in one, stale cached paints in a later one): the style wins
    for e in m.values(): resolve_styles(e)
    return m

PROPDEFS = {}
for n in N:
    for d in n.get('componentPropDefs') or []:
        if 'initialValue' in d: PROPDEFS[g(d['id'])] = d['initialValue']

def propdefault(sym, defid):
    for d in sym.get('componentPropDefs') or []:
        if g(d['id']) == defid:
            if 'initialValue' in d: return d['initialValue']
            if d.get('parentPropDefId'): return PROPDEFS.get(g(d['parentPropDefId']))

def prop_value(a):
    v = a.get('value') or {}
    if v: return v
    vv = (a.get('varValue') or {}).get('value') or {}
    if 'alias' in vv:
        r = resolve_var(alias_target(a['varValue']))
        return {'boolValue': r} if isinstance(r, bool) else {'textValue': {'characters': r}} if isinstance(r, str) else {}
    if 'boolValue' in vv: return {'boolValue': vv['boolValue']}
    if 'symbolIdValue' in vv: return {'guidValue': vv['symbolIdValue']['guid']}
    if isinstance(vv.get('textValue'), str): return {'textValue': {'characters': vv['textValue']}}
    return {}

def apply_props(n, pv):
    if not pv or not n.get('componentPropRefs'): return n
    n = copy.copy(n)
    for r in n['componentPropRefs']:
        v = pv.get(g(r['defID']))
        if v is None: continue
        f = r.get('componentPropNodeField')
        if f == 'VISIBLE' and 'boolValue' in v: n['visible'] = v['boolValue']
        elif f == 'TEXT_DATA' and 'textValue' in v: n['textData'] = v['textValue']
        elif f == 'OVERRIDDEN_SYMBOL_ID' and 'guidValue' in v: n['overriddenSymbolID'] = v['guidValue']
    return n

def resolve(n, ov=None, pv=None):
    """Return a resolved raw node with '_children' (instances expanded, overrides/props applied)."""
    ov = ov or {}
    n = dict(n)
    if n.get('type') == 'INSTANCE':
        sym_id = g(n['overriddenSymbolID']) if n.get('overriddenSymbolID') else g((n.get('symbolData') or {}).get('symbolID') or n['guid'])
        sym = ensure_styles(byid.get(sym_id, {}))
        n['_component'] = sym.get('name')
        inner = ovmap((n.get('symbolData') or {}).get('symbolOverrides'))
        for path, e in ovmap(n.get('derivedSymbolData')).items():
            d = inner.setdefault(path, {})
            for k in ('size', 'transform', 'derivedTextData'):
                if k in e and k not in d: d[k] = e[k]
        for path, e in ov.items(): inner.setdefault(path, {}).update(e)
        ipv = {}
        for d in sym.get('componentPropDefs') or []:
            v = propdefault(sym, g(d['id']))
            if v is not None: ipv[g(d['id'])] = v
        for a in n.get('componentPropAssignments') or []:
            ipv[g(a['defID'])] = prop_value(a)
        # the symbol's own frame styling is the instance's base; instance fields win
        # (not the component's own placement in its component set: stackChild* / stackPositioning belong to the instance)
        base = {k: v for k, v in sym.items() if k not in ('guid', 'parentIndex', 'transform', 'name', 'type', 'size', 'visible', 'componentPropDefs',
                                                          'stackChildPrimaryGrow', 'stackChildAlignSelf', 'stackPositioning')}
        orig = g((n.get('symbolData') or {}).get('symbolID') or n['guid'])
        if sym_id != orig:
            # variant swapped from outside: the raw node still carries the old variant's styling
            explicit = n.get('_explicit', set())
            for k in VISUAL:
                if k in explicit: continue
                if k in sym: n[k] = sym[k]
                else: n.pop(k, None)
        for k, v in base.items(): n.setdefault(k, v)
        n['_children'] = [resolve_child(c, inner, ipv) for c in kids.get(sym_id, [])]
    else:
        n['_children'] = [resolve_child(c, ov, pv) for c in kids.get(g(n['guid']), [])]
    n['_children'] = [c for c in n['_children'] if c]
    return n

def resolve_child(c, ov, pv):
    k = key(ensure_styles(c))
    c = apply_props(apply_ov(c, ov.get((k,))), pv)
    if c.get('type') == 'INSTANCE':
        return resolve(c, {p[1:]: e for p, e in ov.items() if len(p) > 1 and p[0] == k}, None)
    return resolve(c, ov, pv)

# ---------------------------------------------------------------- vector geometry
def blob(i):
    b = msg['blobs'][i]['bytes']
    return base64.b64decode(b[4:]) if b.startswith('b64:') else bytes.fromhex(b)

def vector_paths(n):
    """SVG path data from a vector network blob, scaled to the node size. -> (fill_paths, stroke_path)"""
    vd = n.get('vectorData') or {}
    if 'vectorNetworkBlob' not in vd: return [], ''
    raw = blob(vd['vectorNetworkBlob'])
    nv, ns, nr = struct.unpack_from('<III', raw, 0); o = 12
    ns_ = vd.get('normalizedSize') or n.get('size')
    sx = n['size']['x'] / (ns_['x'] or 1); sy = n['size']['y'] / (ns_['y'] or 1)
    V = []
    for _ in range(nv):
        _, x, y = struct.unpack_from('<Iff', raw, o); o += 12; V.append((x * sx, y * sy))
    S = []
    for _ in range(ns):
        _, a, tax, tay, b, tbx, tby = struct.unpack_from('<IIffIff', raw, o); o += 28
        S.append((a, tax * sx, tay * sy, b, tbx * sx, tby * sy))
    f = lambda v: f'{v:.3f}'.rstrip('0').rstrip('.')
    def seg_cmd(s, rev=False):
        a, tax, tay, b, tbx, tby = s
        if rev: a, b, tax, tay, tbx, tby = b, a, tbx, tby, tax, tay
        (x0, y0), (x1, y1) = V[a], V[b]
        if tax == tay == tbx == tby == 0: return f'L{f(x1)} {f(y1)}'
        return f'C{f(x0 + tax)} {f(y0 + tay)} {f(x1 + tbx)} {f(y1 + tby)} {f(x1)} {f(y1)}'
    def chain(idx):
        d, cur = [], None
        for i in idx:
            a, b = S[i][0], S[i][3]
            rev = False
            if cur is not None and cur != a and cur == b: rev = True
            start = b if rev else a
            if cur != start: d.append(f'M{f(V[start][0])} {f(V[start][1])}')
            d.append(seg_cmd(S[i], rev)); cur = a if rev else b
        return ''.join(d)
    fills = []
    for _ in range(nr):
        hdr, nloops = struct.unpack_from('<II', raw, o); o += 8
        loops = []
        for _ in range(nloops):
            cnt, = struct.unpack_from('<I', raw, o); o += 4
            idx = struct.unpack_from(f'<{cnt}I', raw, o); o += 4 * cnt
            loops.append(chain(idx) + 'Z')
        fills.append({'d': ''.join(loops), 'rule': 'nonzero' if hdr & 1 else 'evenodd'})
    stroke = chain(range(ns))
    if not fills and ns: fills = [{'d': stroke, 'rule': 'nonzero'}]
    return fills, stroke

# ---------------------------------------------------------------- FigJam (pre-tessellated geometry)
def commands_path(i, sx=1.0, sy=1.0, dx=0.0, dy=0.0):
    """Figma path commands blob: u8 op (0 close, 1 move, 2 line, 3 quad, 4 cubic) + f32 coordinates."""
    raw = blob(i); o = 0; d = []
    f = lambda v: f'{v:.2f}'.rstrip('0').rstrip('.')
    pt = lambda x, y: f'{f(x * sx + dx)} {f(y * sy + dy)}'
    while o < len(raw):
        op = raw[o]; o += 1
        if op == 0: d.append('Z')
        elif op in (1, 2):
            x, y = struct.unpack_from('<ff', raw, o); o += 8; d.append(('M' if op == 1 else 'L') + pt(x, y))
        elif op == 3:
            x1, y1, x, y = struct.unpack_from('<4f', raw, o); o += 16; d.append(f'Q{pt(x1, y1)} {pt(x, y)}')
        elif op == 4:
            x1, y1, x2, y2, x, y = struct.unpack_from('<6f', raw, o); o += 24; d.append(f'C{pt(x1, y1)} {pt(x2, y2)} {pt(x, y)}')
        else: break
    return ''.join(d)

FIGJAM_DEFAULT_TEXT = {'r': 0.11, 'g': 0.11, 'b': 0.11, 'a': 1}
def figjam_svg(n):
    """SVG for FigJam nodes (shape-with-text, connector, sticky...) from derivedImmutableFrameData geometry + glyph outlines."""
    gen = {tuple(g(x) for x in ov['guidPath']['guids']): ov for ov in (n.get('nodeGenerationData') or {}).get('overrides', [])}
    out = []
    for ov in (n.get('derivedImmutableFrameData') or {}).get('overrides', []):
        key = tuple(g(x) for x in ov['guidPath']['guids'])
        st = gen.get(key, {})
        if st.get('visible') is False: continue
        t = ov.get('transform') or {}
        part = []
        fill = next((rgba(p['color'], p.get('opacity', 1)) for p in st.get('fillPaints') or [] if p.get('visible', True) and p['type'] == 'SOLID'), None)
        stroke = next((rgba(p['color'], p.get('opacity', 1)) for p in st.get('strokePaints') or [] if p.get('visible', True) and p['type'] == 'SOLID'), None)
        if ov.get('derivedTextData'):
            # text sub-node: fillPaints colour the glyphs; strokeGeometry here is the text box outline, not drawn
            col = fill or rgba(FIGJAM_DEFAULT_TEXT)
            gl = []
            for gph in ov['derivedTextData'].get('glyphs', []):
                if 'commandsBlob' not in gph: continue
                fs_ = gph.get('fontSize', 16); pos = gph['position']
                gl.append(commands_path(gph['commandsBlob'], fs_, -fs_, pos['x'], pos['y']))
            if gl: part.append(f'<path d="{"".join(gl)}" fill="{col}"/>')
        else:
            for fg in ov.get('fillGeometry') or []:
                if fill: part.append(f'<path d="{commands_path(fg["commandsBlob"])}" fill="{fill}" fill-rule="{"evenodd" if fg.get("windingRule") == "ODD" else "nonzero"}"/>')
            for sg in ov.get('strokeGeometry') or []:
                if stroke: part.append(f'<path d="{commands_path(sg["commandsBlob"])}" fill="{stroke}"/>')
        if part: out.append(f'<g transform="translate({fmt(t.get("m02", 0))} {fmt(t.get("m12", 0))})">' + ''.join(part) + '</g>')
    return ''.join(out)

# ---------------------------------------------------------------- normalized model
WEIGHTS = {'thin': 100, 'hairline': 100, 'extralight': 200, 'ultralight': 200, 'light': 300, 'regular': 400, 'normal': 400, 'book': 400,
           'medium': 500, 'semibold': 600, 'demibold': 600, 'bold': 700, 'extrabold': 800, 'ultrabold': 800, 'black': 900, 'heavy': 900}
def font_weight(style):
    s = (style or '').lower().replace(' ', '').replace('-', '').replace('italic', '')
    return WEIGHTS.get(s, 400)

STYLES = {}   # style key / guid -> style name ("Text sm/Semibold", "Shadows/shadow-xs", ...)
for _n in N:
    if _n.get('styleType'):
        STYLES[g(_n['guid'])] = _n.get('name')
        if _n.get('key'): STYLES[_n['key']] = _n.get('name')

def style_key(ref):
    if not ref: return None
    if 'assetRef' in ref: return ref['assetRef'].get('key')
    if 'guid' in ref and ref['guid'].get('sessionID') != 4294967295: return g(ref['guid'])

def annotations_of(n):
    out = []
    for a in n.get('annotations') or []:
        label = a.get('label') or a.get('labelMarkdown') or ''
        props = [p.get('type', '').lower() for p in a.get('properties') or [] if p.get('type')]
        if label or props: out.append({'label': label, 'properties': props})
    return out

def interactions_of(n):
    out = []
    for it in n.get('prototypeInteractions') or []:
        if it.get('isDeleted'): continue
        ev = (it.get('event') or {}).get('interactionType', '')
        for a in it.get('actions') or []:
            tgt = g(a['transitionNodeID']) if a.get('transitionNodeID') else None
            out.append({'event': ev, 'nav': a.get('navigationType') or a.get('connectionType', ''), 'target': tgt,
                        'targetName': (byid.get(tgt) or {}).get('name') if tgt else None, 'url': a.get('connectionURL'),
                        'transition': a.get('transitionType'), 'duration': a.get('transitionDuration'), 'easing': a.get('easingType'),
                        'delay': (it.get('event') or {}).get('transitionTimeout')})
    return out

HOVER_DEPTH = []
VECTORISH = {'VECTOR', 'BOOLEAN_OPERATION', 'ELLIPSE', 'STAR', 'REGULAR_POLYGON', 'LINE', 'RECTANGLE', 'ROUNDED_RECTANGLE'}
ICONS, IMAGES = {}, set()

def safe_family(f): return re.sub(r'''[^\w .+-]''', '', f) if f else f

def text_model(n):
    td = n.get('textData') or {}
    chars = td.get('characters', '')
    fn = n.get('fontName', {})
    base = {'family': safe_family(fn.get('family')), 'style': fn.get('style'), 'weight': font_weight(fn.get('style')),
            'italic': 'italic' in (fn.get('style') or '').lower(), 'size': n.get('fontSize', 12),
            'lineHeight': n.get('lineHeight'), 'letterSpacing': n.get('letterSpacing'),
            'decoration': n.get('textDecoration'), 'case': n.get('textCase'),
            'fills': paints(n.get('fillPaints'), 1, 1)}
    runs = [{'text': chars, **base}]
    ids, table = td.get('characterStyleIDs'), {s['styleID']: s for s in td.get('styleOverrideTable') or n.get('styleOverrideTable') or [] if 'styleID' in s}
    if ids and table:
        runs, cur, start = [], None, 0
        ids = list(ids) + [0] * (len(chars) - len(ids))
        for i in range(len(chars) + 1):
            sid = ids[i] if i < len(chars) else None
            if sid != cur or i == len(chars):
                if i > start:
                    st = dict(base); o = table.get(cur, {})
                    if 'fontName' in o: st.update(family=safe_family(o['fontName'].get('family')), style=o['fontName'].get('style'), weight=font_weight(o['fontName'].get('style')), italic='italic' in (o['fontName'].get('style') or '').lower())
                    for k_src, k_dst in (('fontSize', 'size'), ('lineHeight', 'lineHeight'), ('letterSpacing', 'letterSpacing'), ('textDecoration', 'decoration'), ('textCase', 'case')):
                        if k_src in o: st[k_dst] = o[k_src]
                    if 'fillPaints' in o: st['fills'] = paints(o['fillPaints'], 1, 1)
                    runs.append({'text': chars[start:i], **st})
                cur, start = sid, i
    return {'characters': chars, 'runs': runs, 'alignH': n.get('textAlignHorizontal', 'LEFT'), 'alignV': n.get('textAlignVertical', 'TOP'),
            'autoResize': n.get('textAutoResize', 'NONE'), 'paragraphSpacing': n.get('paragraphSpacing', 0),
            'truncate': n.get('textTruncation') == 'ENDING', 'maxLines': n.get('maxLines'), **base}

def model(n, parent_layout=None):
    if not n.get('visible', True): return None
    push_modes(n)
    try: return _model(n, parent_layout)
    finally: MODE_CTX.pop()

def _model(n, parent_layout=None):
    t = n.get('type'); s = n.get('size', {'x': 0, 'y': 0}); tr = n.get('transform', {})
    w, h = s.get('x', 0), s.get('y', 0)
    m = {'id': g(n['guid']), 'type': t, 'name': n.get('name', ''), 'w': w, 'h': h,
         'x': tr.get('m02', 0), 'y': tr.get('m12', 0), 'rotation': round(math.degrees(math.atan2(tr.get('m10', 0), tr.get('m00', 1))), 3)}
    mx = [tr.get('m00', 1), tr.get('m10', 0), tr.get('m01', 0), tr.get('m11', 1)]   # CSS matrix(a, b, c, d) order
    if max(abs(v - i) for v, i in zip(mx, (1, 0, 0, 1))) > 1e-6: m['matrix'] = [round(v, 6) for v in mx]   # rotation and/or flip
    if n.get('_component'): m['component'] = n['_component']
    if n.get('isMask'): m['mask'] = n.get('maskType') or 'ALPHA'   # clips the siblings above it, is not painted itself
    if n.get('opacity', 1) < 0.999: m['opacity'] = n['opacity']
    if n.get('blendMode') not in (None, 'NORMAL', 'PASS_THROUGH'):   # CSS has no linear-burn / linear-dodge
        m['blend'] = {'LINEAR_BURN': 'multiply', 'LINEAR_DODGE': 'plus-lighter'}.get(n['blendMode'], n['blendMode'].lower().replace('_', '-'))
    if n.get('stackMode') in ('HORIZONTAL', 'VERTICAL'):
        hp = n.get('stackHorizontalPadding', 0); vp = n.get('stackVerticalPadding', 0)
        m['layout'] = {'dir': 'row' if n['stackMode'] == 'HORIZONTAL' else 'col', 'gap': n.get('stackSpacing', 0),
                       'pad': [vp, n.get('stackPaddingRight', hp), n.get('stackPaddingBottom', vp), hp],
                       'justify': n.get('stackPrimaryAlignItems', 'MIN'), 'align': n.get('stackCounterAlignItems', 'MIN'),
                       'wrap': n.get('stackWrap') == 'WRAP', 'counterGap': n.get('stackCounterSpacing'),
                       'primarySizing': n.get('stackPrimarySizing', 'FIXED'), 'counterSizing': n.get('stackCounterSizing', 'FIXED'),
                       'strokesInLayout': n.get('strokesIncludedInLayout', False), 'reverseZ': bool(n.get('stackReverseZIndex'))}
    if parent_layout:
        ch = {}
        if n.get('stackPositioning') == 'ABSOLUTE': ch['absolute'] = True
        if n.get('stackChildPrimaryGrow'): ch['grow'] = True
        if n.get('stackChildAlignSelf') == 'STRETCH': ch['stretch'] = True
        if ch: m['child'] = ch
    for k in ('minSize', 'maxSize'):
        if n.get(k): m[k] = n[k]
    fills = paints(n.get('fillPaints'), w, h)
    for f in fills:
        if f['type'] == 'image' and f.get('hash'): IMAGES.add(f['hash'])
    strokes = paints(n.get('strokePaints'), w, h)
    if fills and t != 'TEXT': m['fills'] = fills
    if strokes and n.get('strokeWeight', 0) > 0 and t != 'TEXT':
        st = {'paints': strokes, 'weight': n.get('strokeWeight', 1), 'align': n.get('strokeAlign', 'INSIDE'),
              'cap': n.get('strokeCap'), 'join': n.get('strokeJoin'), 'dash': n.get('dashPattern')}
        if n.get('borderStrokeWeightsIndependent'):
            st['sides'] = [n.get('borderTopWeight', 0), n.get('borderRightWeight', 0), n.get('borderBottomWeight', 0), n.get('borderLeftWeight', 0)]
        m['stroke'] = st
    if n.get('rectangleCornerRadiiIndependent'):
        r = [n.get(f'rectangle{c}CornerRadius', 0) for c in ('TopLeft', 'TopRight', 'BottomRight', 'BottomLeft')]
        if any(r): m['radius'] = r
    elif n.get('cornerRadius'): m['radius'] = [n['cornerRadius']] * 4
    effs = [e for e in (effect(e) for e in n.get('effects') or []) if e]
    if effs: m['effects'] = effs
    if t in ('FRAME', 'INSTANCE', 'SYMBOL') and not n.get('frameMaskDisabled', False): m['clip'] = True
    st_names = {k: STYLES.get(style_key(n.get(f))) for k, f in (('text', 'styleIdForText'), ('fill', 'styleIdForFill'),
                                                               ('stroke', 'styleIdForStrokeFill'), ('effect', 'styleIdForEffect'))}
    st_names = {k: v for k, v in st_names.items() if v}
    if st_names: m['styles'] = st_names
    ann = annotations_of(n)
    if ann: m['annotations'] = ann
    acts = interactions_of(n)
    if acts: m['interactions'] = acts
    hov = next((a['target'] for a in acts if a['event'] == 'ON_HOVER' and a['nav'] in ('SWAP_STATE', 'CHANGE_TO') and a.get('target')), None)
    if hov and t == 'INSTANCE' and hov in byid and not HOVER_DEPTH:
        HOVER_DEPTH.append(1)
        try:
            fake = {k: v for k, v in n.items() if k not in ('_children', 'overriddenSymbolID', 'prototypeInteractions')}
            fake['symbolData'] = {**(n.get('symbolData') or {}), 'symbolID': byid[hov]['guid']}
            fake['_explicit'] = set()
            fake.pop('_component', None)
            hm = model(resolve(fake), parent_layout)
            if hm: m['hover'] = hm
        finally: HOVER_DEPTH.pop()
    if n.get('derivedImmutableFrameData'): m['figjam'] = figjam_svg(n)
    if t == 'TEXT': m['text'] = text_model(n)
    if t == 'VECTOR': m['paths'], m['strokePath'] = vector_paths(n)
    if t == 'BOOLEAN_OPERATION': m['boolean'] = n.get('booleanOperation', 'UNION')
    if t in ('STAR', 'REGULAR_POLYGON'): m['points'] = n.get('count', 5); m['innerRadius'] = n.get('starInnerScale', .38)
    if t == 'ELLIPSE' and n.get('arcData'): m['arc'] = n['arcData']
    lay = m.get('layout')
    m['children'] = [c for c in (model(c, lay) for c in n['_children']) if c]
    plain = not (m.get('fills') or m.get('layout') or m.get('effects') or m.get('stroke'))
    if t not in ('TEXT',) and plain and m['children'] and all_vector(m): m['icon'] = True
    elif t in VECTORISH and t not in ('RECTANGLE', 'ROUNDED_RECTANGLE', 'LINE'): m['icon'] = True
    if m.get('figjam') is not None: m['icon'] = True; m['children'] = []
    return m

def all_vector(m):
    for c in m['children']:
        if c['type'] in VECTORISH: continue
        if c['type'] in ('FRAME', 'INSTANCE', 'SYMBOL') and c['children'] and not c.get('layout') and not c.get('fills') and all_vector(c): continue
        if c['type'] in ('FRAME', 'INSTANCE', 'SYMBOL') and not c['children']: continue
        return False
    return any(c['type'] in VECTORISH for c in walk_all(m))

def walk_all(m):
    for c in m['children']:
        yield c; yield from walk_all(c)

# ---------------------------------------------------------------- SVG
fmt = lambda v: f'{v:.3f}'.rstrip('0').rstrip('.') if isinstance(v, float) else str(v)

def svg_paint(ps, defs=None):
    for p in reversed(ps or []):  # topmost paint
        if p['type'] == 'solid': return p['color']
        if defs is not None and p['type'] in ('linear', 'radial') and p.get('stops'):
            gid = f'__ID__g{len(defs)}'
            stops = ''.join(f'<stop offset="{fmt(float(st["pos"]))}" stop-color="{st["color"]}"/>' for st in p['stops'])
            if p['type'] == 'linear':
                (x1, y1), (x2, y2) = p['p0'], p['p1']
                defs.append(f'<linearGradient id="{gid}" gradientUnits="userSpaceOnUse" x1="{fmt(x1)}" y1="{fmt(y1)}" x2="{fmt(x2)}" y2="{fmt(y2)}">{stops}</linearGradient>')
            else:
                (cx, cy), (rx, ry) = p['c'], p['r']
                defs.append(f'<radialGradient id="{gid}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate({fmt(cx)} {fmt(cy)}) scale({fmt(rx)} {fmt(ry)})">{stops}</radialGradient>')
            return f'url(#{gid})'
    return 'none'

def arc_path(a, w, h):
    """Figma arcData: angles in radians from 3 o'clock, clockwise; innerRadius as a fraction of the radius."""
    cx, cy, rx, ry = w / 2, h / 2, w / 2, h / 2
    s0, s1, ir = a.get('startingAngle', 0), a.get('endingAngle', 2 * math.pi), a.get('innerRadius', 0) or 0
    sweep = s1 - s0
    pt = lambda ang, k: f'{fmt(cx + rx * k * math.cos(ang))} {fmt(cy + ry * k * math.sin(ang))}'
    ring = lambda k: f'M{pt(0, k)}A{fmt(rx * k)} {fmt(ry * k)} 0 1 1 {pt(math.pi, k)}A{fmt(rx * k)} {fmt(ry * k)} 0 1 1 {pt(0, k)}Z'
    if abs(sweep) >= 2 * math.pi - 1e-4: return ring(1) + (ring(ir) if ir else '')
    large = 1 if abs(sweep) > math.pi else 0
    outer = f'M{pt(s0, 1)}A{fmt(rx)} {fmt(ry)} 0 {large} 1 {pt(s1, 1)}'
    if not ir: return f'{outer}L{fmt(cx)} {fmt(cy)}Z'
    return f'{outer}L{pt(s1, ir)}A{fmt(rx * ir)} {fmt(ry * ir)} 0 {large} 0 {pt(s0, ir)}Z'

def rounded_rect_path(w, h, r):
    tl, tr_, br, bl = (min(v, w / 2, h / 2) for v in r)
    return (f'M{fmt(tl)} 0H{fmt(w - tr_)}A{fmt(tr_)} {fmt(tr_)} 0 0 1 {fmt(w)} {fmt(tr_)}V{fmt(h - br)}'
            f'A{fmt(br)} {fmt(br)} 0 0 1 {fmt(w - br)} {fmt(h)}H{fmt(bl)}A{fmt(bl)} {fmt(bl)} 0 0 1 0 {fmt(h - bl)}'
            f'V{fmt(tl)}A{fmt(tl)} {fmt(tl)} 0 0 1 {fmt(tl)} 0Z')

def svg_children(children, defs):
    i = next((k for k, c in enumerate(children) if c.get('mask')), None)
    if i is None: return ''.join(svg_node(c, defs) for c in children)
    mk = children[i]; mid = f'__ID__m{len(defs)}'
    shape = re.sub(r'\s(fill|stroke)="(?!none")[^"]*"', r' \1="#fff"', svg_node({**mk, 'mask': None}, defs))
    defs.append(f'<clipPath id="{mid}">{shape}</clipPath>' if mk['mask'] == 'OUTLINE' else f'<mask id="{mid}" maskUnits="userSpaceOnUse">{shape}</mask>')
    attr = 'clip-path' if mk['mask'] == 'OUTLINE' else 'mask'
    return ''.join(svg_node(c, defs) for c in children[:i]) + f'<g {attr}="url(#{mid})">{svg_children(children[i + 1:], defs)}</g>'

def svg_node(m, defs, top=False):
    """SVG markup for a vector-ish node, in its parent's coordinate space."""
    if top: tf = ''
    else:
        tf = (f' transform="matrix({" ".join(fmt(v) for v in m["matrix"])} {fmt(m["x"])} {fmt(m["y"])})"' if m.get('matrix')
              else f' transform="translate({fmt(m["x"])} {fmt(m["y"])})"')
    op = f' opacity="{fmt(m["opacity"])}"' if m.get('opacity') is not None else ''
    t = m['type']; w, h = m['w'], m['h']
    fill = svg_paint(m.get('fills'), defs); st = m.get('stroke')
    sattr = ''
    if st:
        sw = st['weight']
        sattr = f' stroke="{svg_paint(st["paints"], defs)}" stroke-width="{fmt(sw)}"'
        if st.get('cap') and st['cap'] != 'NONE': sattr += f' stroke-linecap="{ {"ROUND": "round", "SQUARE": "square"}.get(st["cap"], "butt") }"'
        if st.get('join'): sattr += f' stroke-linejoin="{st["join"].lower()}"'
        if st.get('dash'): sattr += f' stroke-dasharray="{" ".join(fmt(x) for x in st["dash"])}"'
    if m.get('figjam') is not None:
        return f'<g{tf}{op}>{m["figjam"]}</g>'
    if t == 'VECTOR':
        out = []
        for p in m.get('paths', []):
            if fill != 'none': out.append(f'<path d="{p["d"]}" fill="{fill}" fill-rule="{p["rule"]}"/>')
        if st and m.get('strokePath'): out.append(f'<path d="{m["strokePath"]}" fill="none"{sattr}/>')
        return f'<g{tf}{op}>' + ''.join(out) + '</g>'
    if t == 'ELLIPSE':
        if m.get('arc'): return f'<path{tf}{op} d="{arc_path(m["arc"], w, h)}" fill="{fill}" fill-rule="evenodd"{sattr}/>'
        return f'<ellipse{tf}{op} cx="{fmt(w / 2)}" cy="{fmt(h / 2)}" rx="{fmt(w / 2)}" ry="{fmt(h / 2)}" fill="{fill}"{sattr}/>'
    if t in ('RECTANGLE', 'ROUNDED_RECTANGLE'):
        rr = m.get('radius') or [0] * 4
        if len(set(rr)) > 1: return f'<path{tf}{op} d="{rounded_rect_path(w, h, rr)}" fill="{fill}"{sattr}/>'
        return f'<rect{tf}{op} width="{fmt(w)}" height="{fmt(h)}" rx="{fmt(rr[0])}" fill="{fill}"{sattr}/>'
    if t == 'LINE':
        return f'<line{tf}{op} x1="0" y1="0" x2="{fmt(w)}" y2="0"{sattr or " stroke=\"#000\""}/>'
    if t in ('STAR', 'REGULAR_POLYGON'):
        pts, k = [], m.get('points', 5)
        for i in range(k * (2 if t == 'STAR' else 1)):
            a = -math.pi / 2 + i * math.pi / (k if t == 'STAR' else k / 2)
            r = (m['innerRadius'] if t == 'STAR' and i % 2 else 1)
            pts.append(f'{fmt(w / 2 + math.cos(a) * w / 2 * r)},{fmt(h / 2 + math.sin(a) * h / 2 * r)}')
        return f'<polygon{tf}{op} points="{" ".join(pts)}" fill="{fill}"{sattr}/>'
    inner = svg_children(m['children'], defs)
    if t == 'BOOLEAN_OPERATION' and m['boolean'] in ('SUBTRACT', 'INTERSECT') and len(m['children']) > 1:
        mid = f'__ID__b{len(defs)}'
        first = svg_node(m['children'][0], defs)
        rest = ''.join(svg_node(c, defs) for c in m['children'][1:])
        if m['boolean'] == 'SUBTRACT':
            rest = re.sub(r'\s(fill|stroke)="(?!none")[^"]*"', r' \1="#000"', rest)
            rest = re.sub(r'\s(opacity|fill-opacity|stroke-opacity)="[^"]*"', '', rest)
            defs.append(f'<mask id="{mid}" maskUnits="userSpaceOnUse"><rect x="-1e4" y="-1e4" width="2e4" height="2e4" fill="#fff"/><g fill="#000" stroke="#000">{rest}</g></mask>')
            return f'<g{tf}{op} mask="url(#{mid})">{first}</g>'
        defs.append(f'<clipPath id="{mid}">{rest}</clipPath>')
        return f'<g{tf}{op} clip-path="url(#{mid})">{first}</g>'
    if t == 'BOOLEAN_OPERATION' and fill != 'none':
        inner = re.sub(r'fill="[^"]*"', f'fill="{fill}"', inner)
    return f'<g{tf}{op}>{inner}</g>'

def svg_doc(m):
    defs = []
    body = svg_node(m, defs, top=True)
    d = f'<defs>{"".join(defs)}</defs>' if defs else ''
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{fmt(m["w"])}" height="{fmt(m["h"])}" '
           f'viewBox="0 0 {fmt(m["w"])} {fmt(m["h"])}" fill="none" overflow="visible">{d}{body}</svg>')
    return svg.replace('__ID__', f'i{hashlib.sha1(svg.encode()).hexdigest()[:6]}-') if '__ID__' in svg else svg

def icon_file(m):
    svg = svg_doc(m)
    name = re.sub(r'[^a-z0-9]+', '-', (m.get('component') or m['name']).lower()).strip('-') or 'icon'
    hsh = hashlib.sha1(svg.encode()).hexdigest()[:6]
    fn = f'{name}.svg' if ICONS.get(f'{name}.svg', svg) == svg else f'{name}-{hsh}.svg'
    ICONS[fn] = svg
    return fn, svg

# ---------------------------------------------------------------- HTML / CSS
CSS, HTML_FONTS = [], {}
seq = [0]

OUTLINE = {}   # id(model) -> outline declaration for uniform solid strokes
SIDES = {}     # id(model) -> ::after declarations for per-side solid strokes
PAINTED = {}   # token -> colour as painted in this frame (authoritative over the variable's default mode)
def color_css(p):
    if p['type'] == 'solid' and p.get('token'): PAINTED.setdefault(p['token'], p['color'])
    if p['type'] == 'solid': return f"var({css_var(p['token'])}, {p['color']})" if p.get('token') and PAINTED[p['token']] == p['color'] else p['color']
    return p.get('css', 'transparent')

def bg_css(fills):
    layers = []
    for p in reversed(fills):  # Figma: last paint is on top; CSS: first layer is on top
        if p['type'] == 'solid': layers.append(f"linear-gradient({color_css(p)}, {color_css(p)})")
        elif p['type'] == 'image':
            size = {'FILL': 'cover', 'FIT': 'contain', 'TILE': 'auto', 'STRETCH': '100% 100%'}.get(p['scale'], 'cover')
            layers.append(f"url(assets/images/{p['hash']}.png) center / {size} {'repeat' if p['scale'] == 'TILE' else 'no-repeat'}")
        elif 'css' in p: layers.append(p['css'])
    if len(fills) == 1 and fills[0]['type'] == 'solid': return f"background: {color_css(fills[0])};"
    return f"background: {', '.join(layers)};" if layers else ''

def lh_css(lh, size):
    if not lh: return 'normal'
    if lh.get('units') == 'PIXELS': return f"{fmt(lh['value'])}px"
    if lh.get('units') == 'PERCENT': return 'normal' if abs(lh['value'] - 100) < .01 else f"{fmt(lh['value'] / 100 * size)}px"
    return fmt(lh.get('value', 1.2))

def ls_css(ls):
    if not ls or not ls.get('value'): return None
    return f"{fmt(ls['value'] / 100)}em" if ls.get('units') == 'PERCENT' else f"{fmt(ls['value'])}px"

def run_css(r, base=None):
    out = []
    if not base or r['family'] != base['family']: out.append(f"font-family: '{r['family']}', sans-serif")
    if not base or r['weight'] != base['weight']: out.append(f"font-weight: {r['weight']}")
    if r['italic'] and (not base or not base['italic']): out.append('font-style: italic')
    if not base or r['size'] != base['size']: out.append(f"font-size: {fmt(r['size'])}px")
    if not base or r['lineHeight'] != base['lineHeight']: out.append(f"line-height: {lh_css(r['lineHeight'], r['size'])}")
    ls = ls_css(r['letterSpacing'])
    if ls and (not base or r['letterSpacing'] != base['letterSpacing']): out.append(f'letter-spacing: {ls}')
    if r.get('decoration') in ('UNDERLINE', 'STRIKETHROUGH') and (not base or r['decoration'] != base['decoration']):
        out.append('text-decoration: ' + ('underline' if r['decoration'] == 'UNDERLINE' else 'line-through'))
    case = {'UPPER': 'uppercase', 'LOWER': 'lowercase', 'TITLE': 'capitalize'}.get(r.get('case'))
    if case and (not base or r['case'] != base['case']): out.append(f'text-transform: {case}')
    if r['fills'] and (not base or r['fills'] != base['fills']):
        f = r['fills'][-1]
        if f['type'] == 'solid': out.append(f'color: {color_css(f)}')
        else: out.append(f"background: {f.get('css', 'none')}; -webkit-background-clip: text; background-clip: text; color: transparent")
    HTML_FONTS.setdefault(r['family'], set()).add((r['weight'], r['italic']))
    return out

def shadow_css(m):
    sh = []
    st = m.get('stroke')
    if st and m['type'] not in ('TEXT', 'LINE') and not m.get('icon'):
        if st['paints'][-1]['type'] != 'solid': return [e for e in effects_shadow(m)]
        c = color_css(st['paints'][-1])
        w = st['weight']
        if st.get('sides'):
            # per-side strokes as a border on an ::after layer: painted above the children like Figma's strokes (an inset
            # box-shadow is painted below them, so a child with a background hid it)
            k = {'INSIDE': 0, 'CENTER': .5, 'OUTSIDE': 1}.get(st['align'], 0)
            SIDES[id(m)] = ["content: ''", 'position: absolute', 'inset: ' + ' '.join(f'{fmt(-v * k)}px' for v in st['sides']),
                            'border-style: solid', 'border-width: ' + ' '.join(f'{fmt(v)}px' for v in st['sides']), f'border-color: {c}',
                            'border-radius: inherit', 'pointer-events: none'] + (['border-style: dashed'] if st.get('dash') else [])
        else:
            # uniform solid stroke -> outline: crisp, follows border-radius, takes no layout space, paints above children like Figma
            off = {'INSIDE': -w, 'CENTER': -w / 2, 'OUTSIDE': 0}.get(st['align'], -w)
            style = 'dashed' if st.get('dash') else 'solid'
            OUTLINE[id(m)] = f'outline: {fmt(w)}px {style} {c}; outline-offset: {fmt(off)}px'
    return sh + effects_shadow(m)

def effects_shadow(m):
    out = []
    for e in m.get('effects', []):
        if e['type'] in ('drop', 'inner'):
            if e.get('token'): PAINTED.setdefault(e['token'], e['color'])
            c = f"var({css_var(e['token'])}, {e['color']})" if e.get('token') else e['color']
            out.append(f"{'inset ' if e['type'] == 'inner' else ''}{fmt(e['x'])}px {fmt(e['y'])}px {fmt(e['blur'])}px {fmt(e['spread'])}px {c}")
    return out

JUST = {'MIN': 'flex-start', 'CENTER': 'center', 'MAX': 'flex-end', 'SPACE_EVENLY': 'space-between', 'SPACE_BETWEEN': 'space-between'}
ALIGN = {'MIN': 'flex-start', 'CENTER': 'center', 'MAX': 'flex-end', 'BASELINE': 'baseline'}

def visual_decls(m):
    """Paint-related declarations only (used for :hover diffs)."""
    css = []
    if m['type'] == 'TEXT':
        r = m['text']['runs'][0] if m['text']['runs'] else m['text']
        css += [d for d in run_css(r) if d.startswith(('color', 'background'))]
        return css
    if m.get('fills'): css.append(bg_css(m['fills']).rstrip(';'))
    elif m.get('hover_base_had_fill'): css.append('background: transparent')
    sh = shadow_css(m)
    css.append('box-shadow: ' + (', '.join(sh) if sh else 'none'))
    if id(m) in OUTLINE: css.extend(OUTLINE[id(m)].split('; '))
    if m.get('opacity') is not None: css.append(f"opacity: {fmt(m['opacity'])}")
    return css

def build(m, parent=None):
    seq[0] += 1
    el = {'cls': f'n{seq[0]}', 'm': m, 'css': [], 'before': None, 'svg': None, 'icon': None, 'spans': None, 'children': [], 'hover': []}
    m['_cls'] = el['cls']
    css = el['css']
    pl = (parent or {}).get('layout')
    ch = m.get('child', {})
    in_flow = pl and not ch.get('absolute')
    mt = m.get('matrix') if parent is not None else None
    if parent is None:
        css += ['position: relative', f"width: {fmt(m['w'])}px", f"height: {fmt(m['h'])}px"]
    elif in_flow and mt:
        a, b, c, d = mt; w, h = m['w'], m['h']
        xs, ys = (0, a * w, c * h, a * w + c * h), (0, b * w, d * h, b * w + d * h)
        css += ['position: relative', 'flex: 0 0 auto', f'width: {fmt(w)}px', f'height: {fmt(h)}px',
                f'margin-right: {fmt(round(max(xs) - min(xs) - w, 3))}px', f'margin-bottom: {fmt(round(max(ys) - min(ys) - h, 3))}px',
                'transform-origin: 0 0', f'transform: translate({fmt(round(-min(xs), 3))}px, {fmt(round(-min(ys), 3))}px) matrix({", ".join(fmt(v) for v in mt)}, 0, 0)']
    elif in_flow:
        css.append('position: relative')
        row = pl['dir'] == 'row'
        prim, cross = ('width', 'height') if row else ('height', 'width')
        pv, cv = (m['w'], m['h']) if row else (m['h'], m['w'])
        css.append('flex: 1 1 0' if ch.get('grow') else 'flex: 0 0 auto')
        css.append(f'min-{prim}: 0' if ch.get('grow') else f'{prim}: {fmt(pv)}px')
        capped = ((m.get('maxSize') or {}).get('value') or {}).get('x' if row is False else 'y') is not None
        if ch.get('stretch') and capped: css.append(f'{cross}: 100%')   # fill up to max, keep parent's cross alignment
        elif ch.get('stretch'): css.append('align-self: stretch')
        else: css.append(f'{cross}: {fmt(cv)}px')
    else:
        css += ['position: absolute', f"left: {fmt(m['x'])}px", f"top: {fmt(m['y'])}px", f"width: {fmt(m['w'])}px", f"height: {fmt(m['h'])}px"]
    if m.get('_z'): css.append(f"z-index: {m['_z']}")
    if mt and not in_flow:   # absolute: the transform's translation is the left/top above
        css += ['transform-origin: 0 0', f'transform: matrix({", ".join(fmt(v) for v in mt)}, 0, 0)']
    if m.get('opacity') is not None: css.append(f"opacity: {fmt(m['opacity'])}")
    if m.get('_clip'): css.append(f"clip-path: {m['_clip']}")
    if m.get('blend'): css.append(f"mix-blend-mode: {m['blend']}")
    for k, prop in (('minSize', 'min'), ('maxSize', 'max')):
        v = (m.get(k) or {}).get('value') or {}
        if v.get('x') is not None: css.append(f"{prop}-width: {fmt(v['x'])}px")
        if v.get('y') is not None: css.append(f"{prop}-height: {fmt(v['y'])}px")

    if m.get('icon') and m['type'] != 'TEXT':
        el['icon'], el['svg'] = icon_file(m)
        m['_icon'] = el['icon']
        return el

    if m.get('fills'): css.append(bg_css(m['fills']).rstrip(';'))
    if m.get('radius'):
        r = m['radius']; css.append('border-radius: ' + (f'{fmt(r[0])}px' if len(set(r)) == 1 else ' '.join(f'{fmt(x)}px' for x in r)))
    sh = shadow_css(m)
    if sh and m['type'] == 'TEXT':
        ts = [f"{fmt(e['x'])}px {fmt(e['y'])}px {fmt(e['blur'])}px {e['color']}" for e in m.get('effects', []) if e['type'] == 'drop']
        if ts: css.append('text-shadow: ' + ', '.join(ts))
    elif sh: css.append('box-shadow: ' + ', '.join(sh))
    if id(m) in OUTLINE: css.extend(OUTLINE[id(m)].split('; '))
    el['after'] = SIDES.get(id(m))
    st = m.get('stroke')
    if st and st['paints'][-1]['type'] != 'solid' and 'css' in st['paints'][-1]:
        w_ = st['weight']; inset = {'INSIDE': 0, 'CENTER': -w_ / 2, 'OUTSIDE': -w_}.get(st['align'], 0)
        el['before'] = ["content: ''", 'position: absolute', f'inset: {fmt(inset)}px', 'border-radius: inherit', f'padding: {fmt(w_)}px',
                        f"background: {st['paints'][-1]['css']}", '-webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
                        '-webkit-mask-composite: xor', 'mask-composite: exclude', 'pointer-events: none']
    for e in m.get('effects', []):
        if e['type'] == 'blur': css.append(f"filter: blur({fmt(e['radius'] / 2)}px)")
        if e['type'] == 'bg-blur': css.append(f"backdrop-filter: blur({fmt(e['radius'] / 2)}px)")
    if m.get('clip'): css.append('overflow: hidden')
    if m['type'] == 'ELLIPSE': css.append('border-radius: 50%')
    if m['type'] == 'LINE' and m.get('stroke'):
        css += ['height: 0', f"border-top: {fmt(m['stroke']['weight'])}px solid {color_css(m['stroke']['paints'][-1])}"]
    lay = m.get('layout')
    if lay:
        css += ['display: flex', f"flex-direction: {'row' if lay['dir'] == 'row' else 'column'}",
                f"justify-content: {JUST.get(lay['justify'], 'flex-start')}", f"align-items: {ALIGN.get(lay['align'], 'flex-start')}"]
        if lay['justify'] not in ('SPACE_EVENLY', 'SPACE_BETWEEN') and lay['gap']: css.append(f"gap: {fmt(lay['gap'])}px")
        if lay['wrap']:
            css.append('flex-wrap: wrap')
            if lay.get('counterGap'): css.append(f"row-gap: {fmt(lay['counterGap'])}px" if lay['dir'] == 'row' else f"column-gap: {fmt(lay['counterGap'])}px")
        if any(lay['pad']): css.append('padding: ' + ' '.join(f'{fmt(p)}px' for p in lay['pad']))

    if m['type'] == 'TEXT':
        tx = m['text']
        base = tx['runs'][0] if tx['runs'] else tx
        css += ['display: flex', 'flex-direction: column', 'justify-content: ' + {'TOP': 'flex-start', 'CENTER': 'center', 'BOTTOM': 'flex-end'}[tx['alignV']]]
        css += run_css(base)
        css.append('text-align: ' + {'LEFT': 'left', 'CENTER': 'center', 'RIGHT': 'right', 'JUSTIFIED': 'justify'}[tx['alignH']])
        css.append('white-space: ' + ('pre' if tx['autoResize'] == 'WIDTH_AND_HEIGHT' else 'pre-wrap'))
        if tx['autoResize'] != 'WIDTH_AND_HEIGHT': css.append('overflow-wrap: break-word')   # Figma breaks a word longer than the line
        if tx['truncate']:
            css += ['overflow: hidden', 'text-overflow: ellipsis']
            if tx.get('maxLines'): css += ['display: -webkit-box', '-webkit-box-orient: vertical', f"-webkit-line-clamp: {tx['maxLines']}"]
        el['spans'] = [(r['text'], run_css(r, base)) for r in tx['runs']]
        el['para'] = tx.get('paragraphSpacing') or 0
    else:
        if lay and lay.get('reverseZ'):   # "first on top": earlier children paint above later ones
            for i, c in enumerate(m['children']): c['_z'] = len(m['children']) - i
            css.append('isolation: isolate')   # Figma orders layers within their parent: keep these z-indexes local
        mask = None
        for c in m['children']:
            if c.get('mask'): mask = c; continue
            if mask: c['_clip'] = mask_clip(mask, c)
            el['children'].append(build(c, m))
    if m.get('hover'):
        hover_rules(el, m, m['hover'])
        a = next((a for a in m.get('interactions', []) if a['event'] == 'ON_HOVER'), {})
        if a.get('duration'):
            ease = {'LINEAR': 'linear', 'EASE_IN': 'ease-in', 'EASE_OUT': 'ease-out', 'EASE_IN_AND_OUT': 'ease-in-out',
                    'EASE_IN_BACK': 'cubic-bezier(0.3,-0.05,0.7,-0.5)', 'EASE_OUT_BACK': 'cubic-bezier(0.45,1.45,0.8,1)'}.get(a.get('easing'), 'ease')
            el['transition'] = f"{round(a['duration'] * 1000)}ms {ease}"
    return el

def mask_clip(mk, c):
    """CSS clip-path, in sibling c's own box, for the mask layer mk (both in their parent's coordinates)."""
    l, t = mk['x'] - c['x'], mk['y'] - c['y']
    if mk['type'] == 'ELLIPSE':
        return f"ellipse({fmt(mk['w'] / 2)}px {fmt(mk['h'] / 2)}px at {fmt(l + mk['w'] / 2)}px {fmt(t + mk['h'] / 2)}px)"
    r = mk.get('radius') or [0]
    rnd = f" round {' '.join(f'{fmt(v)}px' for v in r)}" if any(r) else ''
    return f"inset({fmt(t)}px {fmt(c['w'] - l - mk['w'])}px {fmt(c['h'] - t - mk['h'])}px {fmt(l)}px{rnd})"

def hover_rules(root_el, base, hov):
    """Pair the default and hover variants node by node and emit paint changes as :hover rules."""
    def pair(a, b, chain):
        if not b: return
        if a.get('fills') and not b.get('fills'): b['hover_base_had_fill'] = True
        va, vb = visual_decls(a), visual_decls(b)
        if va != vb and a.get('_cls'):
            changed = [d for d in vb if d not in va]
            if changed: root_el['hover'].append((a['_cls'] if a is not base else None, changed))
        for ca, cb in zip(a.get('children', []), b.get('children', [])):
            if ca['name'] == cb['name'] and ca['type'] == cb['type']: pair(ca, cb, chain + [ca['name']])
    pair(base, hov, [])

def paragraphs(spans):
    """Runs split at line breaks into paragraphs: [[(text, decls), ...], ...]"""
    out = [[]]
    for t, d in spans:
        for i, part in enumerate(t.split('\n')):
            if i: out.append([])
            if part: out[-1].append((part, d))
    return out

def text_html(el, span, esc):
    """Inner markup of a text node. Paragraph spacing (space between paragraphs) needs one block per paragraph."""
    if not el.get('para'): return f'<span>{"".join(span(t, d) for t, d in el["spans"])}</span>'
    ps = paragraphs(el['spans'])
    return ''.join(f'<div style={esc(i, len(ps))}>{"".join(span(t, d) for t, d in p) or "&#8203;"}</div>' for i, p in enumerate(ps))

# ---- HTML renderer
def render_html(el, depth=0):
    m = el['m']
    attrs = f' class="{el["cls"]}" data-id="{m["id"]}" data-name="{html.escape(m["name"])}"'
    if m.get('component'): attrs += f' data-component="{html.escape(m["component"])}"'
    for a in m.get('interactions', []):
        if a['event'] != 'ON_HOVER': attrs += f' data-{a["event"].lower().replace("_", "-")}="{html.escape((a["nav"] or "").lower())}:{html.escape(a.get("target") or a.get("url") or "")}"'
    CSS.append(f"/* {m['name'].replace('*/', '* /').replace('<', '&lt;')} */ .{el['cls']} {{ {'; '.join(c for c in el['css'] if c)}; }}")
    if el['before']: CSS.append(f".{el['cls']}::before {{ {'; '.join(el['before'])}; }}")
    if el.get('after'): CSS.append(f".{el['cls']}::after {{ {'; '.join(el['after'])}; }}")
    for cls, decls in el['hover']:
        sel = f".{el['cls']}:hover" + (f" .{cls}" if cls else '')
        CSS.append(f"{sel} {{ {'; '.join(decls)}; }}")
    if el['hover']:
        tr = f"; transition: background {el['transition']}, color {el['transition']}, box-shadow {el['transition']}, outline-color {el['transition']}, opacity {el['transition']}" if el.get('transition') else ''
        targets = ', '.join([f".{el['cls']}"] + [f".{el['cls']} .{c}" for c, _ in el['hover'] if c])
        CSS.append(f"{targets} {{ cursor: pointer{tr}; }}")
    pad = '  ' * depth
    if el['svg'] is not None:
        return f'{pad}<div{attrs} data-icon="assets/icons/{el["icon"]}">{el["svg"]}</div>'
    if el['spans'] is not None:
        span = lambda t, d: f'<span style="{"; ".join(d)}">{html.escape(t)}</span>' if d else html.escape(t)
        gap = lambda i, n: f'"margin-bottom: {fmt(el["para"])}px"' if i < n - 1 else '""'
        return f'{pad}<div{attrs}>{text_html(el, span, gap)}</div>'
    if not el['children']: return f'{pad}<div{attrs}></div>'
    return f'{pad}<div{attrs}>\n' + '\n'.join(render_html(c, depth + 1) for c in el['children']) + f'\n{pad}</div>'

# ---- React + Tailwind renderer
TW_KEYWORD = {
    ('display', 'flex'): 'flex', ('display', '-webkit-box'): '[display:-webkit-box]', ('flex-direction', 'row'): 'flex-row', ('flex-direction', 'column'): 'flex-col',
    ('justify-content', 'flex-start'): 'justify-start', ('justify-content', 'center'): 'justify-center', ('justify-content', 'flex-end'): 'justify-end',
    ('justify-content', 'space-between'): 'justify-between', ('align-items', 'flex-start'): 'items-start', ('align-items', 'center'): 'items-center',
    ('align-items', 'flex-end'): 'items-end', ('align-items', 'baseline'): 'items-baseline', ('align-self', 'stretch'): 'self-stretch',
    ('position', 'relative'): 'relative', ('position', 'absolute'): 'absolute', ('overflow', 'hidden'): 'overflow-hidden',
    ('flex', '1 1 0'): 'flex-[1_1_0]', ('flex', '0 0 auto'): 'flex-none', ('flex-wrap', 'wrap'): 'flex-wrap',
    ('white-space', 'pre'): 'whitespace-pre', ('white-space', 'pre-wrap'): 'whitespace-pre-wrap', ('text-align', 'left'): 'text-left',
    ('text-align', 'center'): 'text-center', ('text-align', 'right'): 'text-right', ('text-align', 'justify'): 'text-justify',
    ('font-style', 'italic'): 'italic', ('text-transform', 'uppercase'): 'uppercase', ('text-transform', 'lowercase'): 'lowercase',
    ('text-transform', 'capitalize'): 'capitalize', ('text-decoration', 'underline'): 'underline', ('text-decoration', 'line-through'): 'line-through',
    ('transform-origin', '0 0'): 'origin-top-left', ('text-overflow', 'ellipsis'): 'text-ellipsis', ('cursor', 'pointer'): 'cursor-pointer',
    ('pointer-events', 'none'): 'pointer-events-none', ('box-shadow', 'none'): 'shadow-none', ('isolation', 'isolate'): 'isolate',
}
TW_PREFIX = {'width': 'w', 'height': 'h', 'min-width': 'min-w', 'max-width': 'max-w', 'min-height': 'min-h', 'max-height': 'max-h',
             'left': 'left', 'top': 'top', 'gap': 'gap', 'row-gap': 'gap-y', 'column-gap': 'gap-x', 'padding': 'p', 'border-radius': 'rounded',
             'opacity': 'opacity', 'z-index': 'z', 'font-size': 'text', 'line-height': 'leading', 'letter-spacing': 'tracking',
             'font-weight': 'font', 'box-shadow': 'shadow', 'inset': 'inset', 'outline-offset': 'outline-offset'}
def tw_val(v): return v.replace('_', '\\_').replace(' ', '_')
def tw(decls, variant=''):
    out = []
    for d in decls:
        if not d: continue
        prop, _, val = d.partition(':'); prop, val = prop.strip(), val.strip()
        if (prop, val) in TW_KEYWORD: out.append(variant + TW_KEYWORD[(prop, val)]); continue
        if prop == 'color': out.append(f'{variant}text-[color:{tw_val(val)}]'); continue
        if prop == 'background' and (val.startswith(('#', 'rgba', 'var(')) and ',' not in val.split('(')[0]) and 'gradient' not in val and 'url(' not in val:
            out.append(f'{variant}bg-[{tw_val(val)}]'); continue
        if prop == 'transform' and val.startswith('rotate('): out.append(f'{variant}rotate-[{val[7:-1]}]'); continue
        if prop in TW_PREFIX and not (prop == 'font-weight' and not val.isdigit()):
            out.append(f'{variant}{TW_PREFIX[prop]}-[{tw_val(val)}]'); continue
        out.append(f'{variant}[{prop}:{tw_val(val)}]')
    return ' '.join(out)

SVG_ATTR = re.compile(r'\s([a-z]+(?:-[a-z]+)+)=')
def svg_jsx(svg):
    svg = SVG_ATTR.sub(lambda mm: ' ' + re.sub(r'-([a-z])', lambda x: x.group(1).upper(), mm.group(1)) + '=', svg)
    return svg.replace(' class=', ' className=')

def jsx_text(t): return '{' + json.dumps(t, ensure_ascii=False) + '}'
# quoted JSX attributes take XML entities, not JS escapes
def jsx_attr(t): return t.replace('&', '&amp;').replace('"', '&quot;').replace('\n', '&#10;')

def render_jsx(el, depth, group=None):
    m = el['m']
    cls = tw(el['css'])
    if el['before']: cls += ' ' + tw(el['before'], 'before:')
    if el.get('after'): cls += ' ' + tw(el['after'], 'after:')
    gname = None
    if el['hover']:
        gname = el['cls']
        cls += f' group/{gname} cursor-pointer'
        if el.get('transition'):
            dur, ease = el['transition'].split(' ', 1)
            cls += f' transition-all [transition-duration:{dur}] [transition-timing-function:{tw_val(ease)}]'
        for c, decls in el['hover']:
            if c is None: cls += ' ' + tw(decls, 'hover:')
    if group:
        for c, decls in group[1]:
            if c == el['cls']: cls += ' ' + tw(decls, f'group-hover/{group[0]}:')
    grp = (gname, el['hover']) if gname else group
    pad = '  ' * depth
    attrs = f' className="{cls}" data-name="{jsx_attr(m["name"])}"'
    if el['svg'] is not None:
        return f'{pad}<div{attrs}>{svg_jsx(el["svg"])}</div>'
    if el['spans'] is not None:
        span = lambda t, d: f'<span className="{tw(d)}">{jsx_text(t)}</span>' if d else jsx_text(t)
        gap = lambda i, n: f'{{{{ marginBottom: {fmt(el["para"])} }}}}' if i < n - 1 else '{{}}'
        return f'{pad}<div{attrs}>{text_html(el, span, gap)}</div>'
    if not el['children']: return f'{pad}<div{attrs} />'
    return f'{pad}<div{attrs}>\n' + '\n'.join(render_jsx(c, depth + 1, grp) for c in el['children']) + f'\n{pad}</div>'

# ---------------------------------------------------------------- tree.txt
def tree_line(m):
    b = [f"{fmt(round(m['w'], 2))}x{fmt(round(m['h'], 2))}"]
    if m['x'] or m['y']: b.append(f"@{fmt(round(m['x'], 2))},{fmt(round(m['y'], 2))}")
    if m['rotation']: b.append(f"rot={fmt(m['rotation'])}°")
    l = m.get('layout')
    if l:
        al = [l['dir']]
        if l['gap'] and l['justify'] not in ('SPACE_EVENLY', 'SPACE_BETWEEN'): al.append(f"gap={fmt(l['gap'])}")
        if any(l['pad']): al.append('pad=' + ' '.join(fmt(p) for p in l['pad']))
        if l['justify'] != 'MIN': al.append('justify=' + JUST.get(l['justify'], l['justify']).replace('flex-', ''))
        if l['align'] != 'MIN': al.append('align=' + ALIGN.get(l['align'], l['align']).replace('flex-', ''))
        if l['wrap']: al.append('wrap')
        sz = {'FIXED': 'fixed'}.get(l['primarySizing'], 'hug') + '/' + {'FIXED': 'fixed'}.get(l['counterSizing'], 'hug')
        al.append(f'size={sz}')
        b.append('[' + ' '.join(al) + ']')
    ch = m.get('child', {})
    for k in ('grow', 'stretch', 'absolute'):
        if ch.get(k): b.append({'grow': 'fill-main', 'stretch': 'fill-cross', 'absolute': 'absolute'}[k])
    pf = lambda p: (f"{p['color']}({p['token']})" if p.get('token') else p['color']) if p['type'] == 'solid' else (p.get('css') or f"image:{p.get('hash')}" if p['type'] != 'image' else f"image:{p['hash']}({p['scale'].lower()})")
    if m.get('fills'): b.append('bg=' + ','.join(pf(p) for p in m['fills']))
    st = m.get('stroke')
    if st:
        sides = f"sides={'/'.join(fmt(x) for x in st['sides'])}" if st.get('sides') else f"{fmt(st['weight'])}"
        b.append(f"border={sides} {st['align'].lower()} {','.join(pf(p) for p in st['paints'])}" + (' dashed' if st.get('dash') else ''))
    if m.get('radius'): b.append('radius=' + ('/'.join(fmt(x) for x in m['radius']) if len(set(m['radius'])) > 1 else fmt(m['radius'][0])))
    for e in m.get('effects', []):
        if e['type'] in ('drop', 'inner'): b.append(f"{'inner-' if e['type'] == 'inner' else ''}shadow={fmt(e['x'])},{fmt(e['y'])} blur={fmt(e['blur'])} spread={fmt(e['spread'])} {e['color']}" + (f"({e['token']})" if e.get('token') else ''))
        else: b.append(f"{e['type']}={fmt(e['radius'])}")
    if m.get('opacity') is not None: b.append(f"opacity={fmt(m['opacity'])}")
    if m.get('clip'): b.append('clip')
    if m['type'] == 'TEXT':
        t = m['text']; r = t['runs'][0] if t['runs'] else t
        b.append(f"font={r['family']} {r['weight']}{' italic' if r['italic'] else ''} {fmt(r['size'])}/{lh_css(r['lineHeight'], r['size'])}")
        ls = ls_css(r['letterSpacing'])
        if ls: b.append(f'ls={ls}')
        if t['alignH'] != 'LEFT': b.append('text-align=' + t['alignH'].lower())
        if t['alignV'] != 'TOP': b.append('v-align=' + t['alignV'].lower())
        b.append('resize=' + {'WIDTH_AND_HEIGHT': 'hug', 'HEIGHT': 'fixed-w', 'NONE': 'fixed'}.get(t['autoResize'], t['autoResize']))
        if r['fills']: b.append('color=' + ','.join(pf(p) for p in r['fills']))
        if len(t['runs']) > 1: b.append(f"runs={len(t['runs'])}")
        b.append(json.dumps(t['characters'][:300], ensure_ascii=False))
    if m.get('styles'): b.append('style{' + ', '.join(f'{k}="{v}"' for k, v in m['styles'].items()) + '}')
    for a in m.get('interactions', []):
        tgt = a.get('targetName') or a.get('target') or a.get('url') or ''
        tr = f" {a['transition'].lower()} {round((a.get('duration') or 0) * 1000)}ms {(a.get('easing') or '').lower()}" if a.get('transition') else ''
        b.append(f"on:{a['event'].lower().replace('on_', '')}→{(a['nav'] or '').lower()}({tgt}{tr})")
    if m.get('hover'): b.append(f"hover→{m['hover'].get('component') or m['hover']['name']}")
    for a in m.get('annotations', []): b.append(f"annotation={json.dumps(a['label'], ensure_ascii=False)}" + (f"[{','.join(a['properties'])}]" if a['properties'] else ''))
    return ' '.join(b)

def tree(m, depth=0, out=None):
    out = out if out is not None else []
    label = f"<{m['name']}> instance of “{m['component']}”" if m.get('component') else f"{m['type'].lower()} “{m['name']}”"
    extra = f" icon→assets/icons/{m['_icon']}" if m.get('_icon') else ''
    out.append('  ' * depth + f"{label} {tree_line(m)}{extra}")
    if not m.get('icon'):
        for c in m['children']: tree(c, depth + 1, out)
    return out

# ---------------------------------------------------------------- run
if ROOT not in byid: sys.exit(f'node {ROOT} is not in the captured data')
root = resolve(ensure_styles(byid[ROOT]))
root['visible'] = True
M = model(root)
os.makedirs(f'{OUT}/assets/icons', exist_ok=True); os.makedirs(f'{OUT}/assets/images', exist_ok=True)
TREE = build(M)
body = render_html(TREE)
for fn, svg in ICONS.items(): open(f'{OUT}/assets/icons/{fn}', 'w').write(svg)


missing = []
urls = META.get('imageHashes', {})
IMAGE_HOSTS = re.compile(r'(?:[\w-]+\.)*figma\.com|figma-alpha-api\.s3\.[\w-]+\.amazonaws\.com')
def figma_image_url(u):
    p = urllib.parse.urlsplit(u) if isinstance(u, str) else None
    return bool(p and p.scheme == 'https' and IMAGE_HOSTS.fullmatch(p.hostname or '') and not re.search(r'[\s"\\]', u))
# Images are content-addressed (hash): keep one copy per file so other frames of the file reuse it without a download.
SHARED = os.path.join(os.path.expanduser('~/.figma-local/out'), META['fileKey'], '_images') if META.get('fileKey') else None
todo = []
for hsh in sorted(IMAGES):
    dst = f'{OUT}/assets/images/{hsh}.png'
    if os.path.exists(dst): continue
    if SHARED and os.path.exists(f'{SHARED}/{hsh}.png'):
        shutil.copyfile(f'{SHARED}/{hsh}.png', dst); continue
    if hsh not in urls and not urls.get('__api_done'):
        # Fallback: REST "image fills" is Tier 2 (per-minute quota even on View seats), unlike GET file (Tier 1).
        urls['__api_done'] = True
        tok = os.environ.get('FIGMA_API_KEY') or os.environ.get('FIGMA_ACCESS_TOKEN')
        # The response maps every image of the file (MBs, ~8s): cache it per file; its signed URLs last for days.
        api_cache = f'{SHARED}/image-fills.json' if SHARED else None
        if api_cache and os.path.exists(api_cache) and time.time() - os.path.getmtime(api_cache) < 12 * 3600:
            urls.update(json.load(open(api_cache)))
        elif tok and META.get('fileKey'):
            try:
                req = urllib.request.Request(f"https://api.figma.com/v1/files/{META['fileKey']}/images", headers={'X-Figma-Token': tok})
                fills = json.load(urllib.request.urlopen(req, timeout=30)).get('meta', {}).get('images', {})
                urls.update(fills)
                if api_cache: os.makedirs(SHARED, exist_ok=True); json.dump(fills, open(api_cache, 'w'))
            except Exception as e: missing.append(f'image-fills API: {e}')
    if hsh in urls and figma_image_url(urls[hsh]): todo.append((hsh, dst))
    else: missing.append(hsh)

# curl --parallel: one process, connections reused; Python's urllib pays ~1-6s of TLS setup per image here
if todo:
    cfg = ''.join(f'url = "{urls[h]}"\noutput = "{d.replace(chr(92), "/")}"\n' for h, d in todo)   # curl's config treats a backslash as an escape
    subprocess.run(['curl', '-sSfL', '--parallel', '--parallel-max', '8', '--retry', '2', '--max-time', '60', '-K', '-'], input=cfg, text=True, capture_output=True)
    for hsh, dst in todo:
        if os.path.exists(dst):
            with open(dst, 'rb') as fh: head = fh.read(12)
            if not head.startswith((b'\x89PNG', b'\xff\xd8\xff', b'GIF8')) and head[8:12] != b'WEBP': os.remove(dst)
        if not os.path.exists(dst): missing.append(f'{hsh}: download failed')
        elif SHARED: os.makedirs(SHARED, exist_ok=True); shutil.copyfile(dst, f'{SHARED}/{hsh}.png')

tokens = {name: {'type': v.get('variableResolvedType'), 'css': css_var(name), 'values': var_value(v)} for name, v in sorted(USED_TOKENS.items())}
json.dump(tokens, open(f'{OUT}/tokens.json', 'w'), indent=1, ensure_ascii=False)
for name, col in PAINTED.items():
    if name in tokens: tokens[name]['painted'] = col
json.dump(tokens, open(f'{OUT}/tokens.json', 'w'), indent=1, ensure_ascii=False)
root_vars = '\n'.join(f"  {css_var(n)}: {c};" for n, c in sorted(PAINTED.items()))

fonts = []
for fam, ws in HTML_FONTS.items():
    if not fam: continue
    spec = ';'.join(sorted({f"{int(i)},{w}" for w, i in ws}))
    fonts.append(f"family={urllib.parse.quote_plus(fam)}:ital,wght@{spec}")
font_link = f'<link rel="stylesheet" href="https://fonts.googleapis.com/css2?{"&".join(fonts)}&display=block">' if fonts else ''

page = f"""<!doctype html>
<html><head><meta charset="utf-8">
<title>{html.escape(M['name'])}</title>
{font_link}
<style>
:root {{
{root_vars}
}}
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ background: transparent; -webkit-font-smoothing: antialiased; }}
svg {{ display: block; overflow: visible; }}
{chr(10).join(CSS)}
</style></head>
<body>
{body}
</body></html>
"""
open(f'{OUT}/index.html', 'w').write(page)

comp = re.sub(r'[^A-Za-z0-9]+', ' ', M['name']).title().replace(' ', '') or 'FigmaFrame'
if comp[0].isdigit(): comp = 'Frame' + comp
root_style = '{{' + ', '.join(f"{json.dumps(css_var(n))}: {json.dumps(c)}" for n, c in sorted(PAINTED.items())) + '}}'
jsx = render_jsx(TREE, 2)
jsx = jsx.replace('className="', f'style={root_style} className="antialiased [&_svg]:block [&_svg]:overflow-visible ', 1)
tsx = f"""// Generated by refigma-mcp from Figma node {' '.join(str(M['id']).split())} ("{' '.join(M['name'].split())}").
// Exact values from the design; Tailwind arbitrary values keep them 1:1. Token CSS variables are set on the root.
// Fonts: {font_link.split('href="')[1].split('"')[0] if font_link else 'none'}
export default function {comp}() {{
  return (
{jsx}
  );
}}
"""
open(f'{OUT}/{comp}.tsx', 'w').write(tsx)
json.dump(M, open(f'{OUT}/model.json', 'w'), ensure_ascii=False)
open(f'{OUT}/tree.txt', 'w').write('\n'.join(tree(M)) + '\n')
print(json.dumps({'component': f'{comp}.tsx', 'nodes': sum(1 for _ in walk_all(M)) + 1, 'icons': len(ICONS), 'images': len(IMAGES), 'images_missing': missing,
                  'tokens': len(tokens), 'fonts': sorted(HTML_FONTS), 'w': M['w'], 'h': M['h']}))
