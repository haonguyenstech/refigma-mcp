"""Turn a decoded Figma clipboard message (msg.json) into a compact, code-oriented layout tree."""
import json, sys, copy
msg = json.load(open(sys.argv[1])); ROOT = sys.argv[2]
N = msg['nodeChanges']
g = lambda x: f"{x['sessionID']}:{x['localID']}"
byid = {g(n['guid']): n for n in N}
kids = {}
for n in N:
    p = n.get('parentIndex')
    if p: kids.setdefault(g(p['guid']), []).append(n)
for v in kids.values(): v.sort(key=lambda c: c['parentIndex']['position'])
varname = {n['key']: n['name'] for n in N if n.get('type') == 'VARIABLE' and n.get('key')}
for n in N:
    if n.get('type') == 'VARIABLE': varname[g(n['guid'])] = n['name']

def alias(v):
    a = (v or {}).get('value', {}).get('alias', {})
    if 'assetRef' in a: return varname.get(a['assetRef']['key'])
    if 'guid' in a: return varname.get(g(a['guid']))

hx = lambda c, o=1: '#%02X%02X%02X' % tuple(round(c[k] * 255) for k in 'rgb') + ('' if c.get('a', 1) * o >= 0.999 else f"/{c.get('a',1)*o:.2f}")
def paints(ps):
    out = []
    for p in ps or []:
        if not p.get('visible', True): continue
        if p['type'] == 'SOLID':
            s = hx(p['color'], p.get('opacity', 1)); a = alias(p.get('colorVar'))
            out.append(f"{s}({a})" if a else s)
        elif p['type'] == 'IMAGE': out.append('image')
        else: out.append(p['type'].lower())
    return ','.join(out)

key = lambda n: g(n.get('overrideKey') or n['guid'])

def apply(n, ov):
    if not ov: return n
    n = copy.copy(n)
    for k, v in ov.items():
        if k not in ('guidPath',): n[k] = v
    return n

def ovmap(entries):
    m = {}
    for e in entries or []:
        path = tuple(g(x) for x in e.get('guidPath', {}).get('guids', []))
        if path: m.setdefault(path, {}).update(e)
    return m

out = []
def props(n):
    t = n.get('type'); s = n.get('size', {}); tr = n.get('transform', {})
    bits = [f"{round(s.get('x',0))}x{round(s.get('y',0))}"]
    if tr.get('m02') or tr.get('m12'): bits.append(f"@{round(tr.get('m02',0))},{round(tr.get('m12',0))}")
    if n.get('stackMode') in ('HORIZONTAL', 'VERTICAL'):
        al = [n['stackMode'].lower()[0] == 'h' and 'row' or 'col']
        if n.get('stackSpacing'): al.append(f"gap={round(n['stackSpacing'])}")
        pad = [n.get(f'stack{k}Padding', n.get('stackHorizontalPadding' if k in ('Left','Right') else 'stackVerticalPadding', 0)) for k in ('Top','Right','Bottom','Left')]
        pad = [n.get('stackVerticalPadding',0), n.get('stackPaddingRight', n.get('stackHorizontalPadding',0)), n.get('stackPaddingBottom', n.get('stackVerticalPadding',0)), n.get('stackHorizontalPadding',0)]
        if any(pad): al.append('pad=' + ' '.join(str(round(x)) for x in pad))
        if n.get('stackPrimaryAlignItems'): al.append('justify=' + n['stackPrimaryAlignItems'].lower())
        if n.get('stackCounterAlignItems'): al.append('align=' + n['stackCounterAlignItems'].lower())
        bits.append('[' + ' '.join(al) + ']')
    if n.get('stackChildPrimaryGrow'): bits.append('grow')
    if n.get('stackChildAlignSelf') == 'STRETCH': bits.append('stretch')
    f = paints(n.get('fillPaints'))
    if f and t != 'TEXT': bits.append('bg=' + f)
    st = paints(n.get('strokePaints'))
    if st and n.get('strokeWeight'): bits.append(f"border={round(n['strokeWeight'],1)} {st}")
    r = n.get('cornerRadius') or n.get('rectangleTopLeftCornerRadius')
    if r: bits.append(f"radius={round(r)}")
    for e in n.get('effects') or []:
        if e.get('visible', True) and 'SHADOW' in e.get('type',''): bits.append('shadow'); break
    if n.get('opacity', 1) < 0.999: bits.append(f"opacity={n['opacity']:.2f}")
    if t == 'TEXT':
        fn = n.get('fontName', {}); lh = n.get('lineHeight', {})
        bits.append(f"font={fn.get('family')} {fn.get('style')} {round(n.get('fontSize',0))}" + (f"/{round(lh['value'])}" if lh.get('units') == 'PIXELS' else ''))
        if f: bits.append('color=' + f)
        txt = (n.get('textData') or {}).get('characters', '').replace('\n', '⏎')
        bits.append(json.dumps(txt[:200], ensure_ascii=False))
    return ' '.join(bits)

def propvals(n):
    vals = {}
    for a in n.get('componentPropAssignments') or []:
        v = a.get('value') or {}
        vals[g(a['defID'])] = v
    return vals

def apply_props(n, pv):
    # Component properties (boolean/text/instance-swap) bound via componentPropRefs.
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

def walk(n, depth, ov, pv=None):
    if not n.get('visible', True): return
    t = n.get('type')
    label = n.get('name', '')
    if t == 'INSTANCE':
        sym_id = g((n.get('symbolData') or {}).get('symbolID') or n['guid'])
        if n.get('overriddenSymbolID'): sym_id = g(n['overriddenSymbolID'])
        sym = byid.get(sym_id, {})
        out.append('  ' * depth + f"<{label}> instance of “{sym.get('name','?')}” " + props(n))
        inner = ovmap((n.get('symbolData') or {}).get('symbolOverrides'))
        for path, e in ovmap(n.get('derivedSymbolData')).items():
            d = inner.setdefault(path, {})
            for k in ('size', 'transform'):
                if k in e and k not in d: d[k] = e[k]
        for path, e in ov.items(): inner.setdefault(path, {}).update(e)  # outer overrides win
        ipv = {g(d['id']): d['initialValue'] for d in sym.get('componentPropDefs') or [] if d.get('initialValue')}
        ipv.update(propvals(n))
        for c in kids.get(sym_id, []): walk_child(c, depth + 1, inner, ipv)
        return
    out.append('  ' * depth + f"{t.lower()} “{label}” " + props(n))
    if t in ('VECTOR', 'BOOLEAN_OPERATION'): return
    for c in kids.get(g(n['guid']), []): walk_child(c, depth + 1, ov, pv)

def walk_child(c, depth, ov, pv=None):
    # guidPath only lists instance boundaries, so frames pass the same map down; only instances consume a path step.
    k = key(c)
    c = apply_props(apply(c, ov.get((k,))), pv)
    if c.get('type') == 'INSTANCE':
        walk(c, depth, {p[1:]: e for p, e in ov.items() if len(p) > 1 and p[0] == k})
    else:
        walk(c, depth, ov, pv)

walk(byid[ROOT], 0, {})
print('\n'.join(out))
