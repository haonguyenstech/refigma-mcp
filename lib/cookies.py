"""Print the figma.com cookies of the user's real Microsoft Edge profile as JSON (decrypted via the Keychain).
macOS shows a Keychain prompt for "Microsoft Edge Safe Storage" the first time."""
import hashlib, json, os, shutil, sqlite3, subprocess, sys, tempfile
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

PROFILE = os.environ.get('REFIGMA_EDGE_PROFILE', os.path.expanduser('~/Library/Application Support/Microsoft Edge/Default'))
pw = subprocess.run(['security', 'find-generic-password', '-ws', 'Microsoft Edge Safe Storage'], capture_output=True, text=True).stdout.strip().encode()
if not pw: sys.exit('could not read "Microsoft Edge Safe Storage" from the Keychain (prompt denied?)')
key = hashlib.pbkdf2_hmac('sha1', pw, b'saltysalt', 1003, 16)

def dec(b):
    if not b: return ''
    if b[:3] not in (b'v10', b'v11'):
        try: return b.decode()
        except Exception: return ''
    c = Cipher(algorithms.AES(key), modes.CBC(b' ' * 16)).decryptor()
    p = c.update(b[3:]) + c.finalize()
    if p: p = p[:-p[-1]]
    try: return p.decode()
    except UnicodeDecodeError: return p[32:].decode(errors='replace')   # Chromium 130+: 32-byte domain hash prefix

fd, tmp = tempfile.mkstemp(suffix='.db'); os.close(fd)   # private 0600 file, no name race
out = []
try:
    shutil.copyfile(os.path.join(PROFILE, 'Cookies'), tmp)
    rows = sqlite3.connect(tmp).execute(
        "select host_key,name,encrypted_value,path,is_secure,is_httponly,expires_utc,samesite from cookies "
        "where host_key in ('figma.com', '.figma.com') or host_key like '%.figma.com'").fetchall()
finally:
    os.remove(tmp)
for h, n, v, path, sec, ho, exp, ss in rows:
    val = dec(v)
    if not val: continue
    c = {'name': n, 'value': val, 'path': path, 'secure': bool(sec), 'httpOnly': bool(ho),
         'sameSite': {0: 'None', 1: 'Lax', 2: 'Strict'}.get(ss)}
    if n.startswith('__Host-'): c['url'] = 'https://' + h.lstrip('.') + '/'
    else: c['domain'] = h
    if exp: c['expires'] = exp / 1_000_000 - 11644473600
    out.append({k: v for k, v in c.items() if v is not None})
print(json.dumps(out))
