"""Read-only Chrome-compatible Claude transport, ported from 提kyc链接 2.
Credentials use stdin, never argv/logs. One process per account check.
"""
import ipaddress
import json
import re
import sys
import uuid
from curl_cffi.requests import Session

ROUTE = re.compile(r"(?:/edge-api/bootstrap|/api/(?:account|bootstrap|organizations(?:/[0-9a-f-]{36}/kyc_status(?:\?refresh_session=true)?)?))")
ALIASES = {"sessionKeyLC", "sessionKeyV3LC", "sessionKey"}


def main():
    config = json.loads(sys.stdin.readline())
    key = config["sessionKey"]
    if not re.fullmatch(r"[A-Za-z0-9._~-]{20,4096}", key):
        return
    with Session(impersonate="chrome", trust_env=False, proxy=config.get("proxy") or None) as client:
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Origin": "https://claude.ai", "Referer": "https://claude.ai/",
            "anthropic-device-id": str(uuid.uuid4()),
            "x-activity-session-id": str(uuid.uuid4()),
            "anthropic-client-version": "1.0.0",
            "anthropic-client-capabilities": "mfa_sms_v1",
            "anthropic-client-platform": "web_claude_ai",
        }
        for line in sys.stdin:
            try:
                request = json.loads(line)
                if request.get("op") == "egress":
                    if not config.get("proxy"):
                        raise ValueError("proxy required")
                    client.cookies.clear()
                    response = client.get("https://api64.ipify.org?format=json",
                        headers={"Accept": "application/json"}, timeout=10, allow_redirects=False)
                    if response.status_code != 200 or len(response.content) > 1024:
                        raise ValueError("invalid egress response")
                    ip = str(ipaddress.ip_address(response.json()["ip"]))
                    print(json.dumps({"ip": ip, "source": "ipify"}), flush=True)
                    continue
                if not ROUTE.fullmatch(request["path"]) or request["cookie"] not in ALIASES:
                    raise ValueError("unsupported request")
                # Never combine credential aliases, including response cookies.
                client.cookies.clear()
                response = client.get("https://claude.ai" + request["path"],
                    headers={**headers, "Cookie": request["cookie"] + "=" + key},
                    timeout=10, allow_redirects=False)
                content_type = response.headers.get("content-type", "")
                payload = None
                if "application/json" in content_type and len(response.content) <= 1024 * 1024:
                    try:
                        payload = response.json()
                    except ValueError:
                        pass
                result = {"status": response.status_code, "type": content_type,
                    "challenge": response.headers.get("cf-mitigated") == "challenge", "payload": payload}
            except Exception as error:
                # Network exception strings may contain proxy credentials.
                reason = "network_unavailable"
                if config.get("proxy"):
                    code = getattr(error, "code", None)
                    if "407" in str(error) or code == 97:
                        reason = "proxy_auth"
                    elif code == 28:
                        reason = "proxy_timeout"
                    elif code in (5, 7):
                        reason = "proxy_connection_failed"
                result = {"error": reason}
            print(json.dumps(result, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
