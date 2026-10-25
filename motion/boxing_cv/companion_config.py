"""Explicit website pairing for the loopback companion; no wildcard origins."""
import json
from pathlib import Path
from urllib.parse import urlsplit


def website_origin(value):
    u=urlsplit(value)
    local=u.hostname in ('localhost','127.0.0.1')
    if (u.scheme not in ('https','http') or (u.scheme=='http' and not local) or
            not u.hostname or u.username or u.password or u.query or u.fragment or
            u.path not in ('','/') or '*' in value):
        raise ValueError('Website must be one exact HTTPS origin (HTTP allowed only for localhost development)')
    # Validate the port even if it is not used by the caller.
    port=u.port
    host=u.hostname.encode('idna').decode('ascii').lower()
    if ':' in host: host='['+host+']'
    suffix='' if port is None or (u.scheme,port) in (('https',443),('http',80)) else ':'+str(port)
    return f'{u.scheme}://{host}{suffix}'


def load_pairing(path):
    data=json.loads(Path(path).read_text())
    origin=website_origin(data['origin'])
    token=data['token']
    if not isinstance(token,str) or not 32 <= len(token) <= 128 or not token.isascii():
        raise ValueError('Invalid companion pairing token')
    return origin,token
