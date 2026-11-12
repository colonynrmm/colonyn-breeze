"""
Colonyn Bridge client — reference implementation for the Odoo module.

Only the Python standard library is used, so the same code can be dropped into
an Odoo 18 addon (e.g. colonyn_rmm/models/bridge_client.py).

    client = BridgeClient("https://bridge.my.colonyn.com", token, hmac_secret)
    client.provision("odoo-sub-42", "PT ABC", "Budi", "budi@abc.co.id", "starter", 1, 50)

CLI (for testing):
    python3 bridge_client.py <base_url> <token> <secret> GET /v1/tenants/odoo-sub-42
"""
import hashlib
import hmac
import json
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlsplit


class BridgeError(Exception):
    def __init__(self, status, code, message, details=None):
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.details = details


class BridgeClient:
    def __init__(self, base_url, token, hmac_secret, timeout=20):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.secret = hmac_secret.encode()
        self.timeout = timeout

    # -- signing -------------------------------------------------------------
    def _sign(self, method, path, body):
        ts = str(int(time.time()))
        canonical = f"{ts}\n{method.upper()}\n{path}\n{body}".encode()
        digest = hmac.new(self.secret, canonical, hashlib.sha256).hexdigest()
        return ts, f"sha256={digest}"

    def request(self, method, path, payload=None):
        body = "" if payload is None else json.dumps(payload, separators=(",", ":"))
        url = self.base_url + path
        signed_path = urlsplit(url).path + (("?" + urlsplit(url).query) if urlsplit(url).query else "")
        ts, signature = self._sign(method, signed_path, body)
        req = urllib.request.Request(url, data=body.encode() if body else None, method=method.upper())
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("X-Colonyn-Timestamp", ts)
        req.add_header("X-Colonyn-Signature", signature)
        if body:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return res.status, json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as err:
            raw = err.read() or b"{}"
            try:
                data = json.loads(raw)
            except ValueError:
                data = {"error": {"code": "HTTP_ERROR", "message": raw.decode(errors="replace")}}
            e = data.get("error", {})
            raise BridgeError(err.code, e.get("code"), e.get("message"), e.get("details")) from None

    # -- API -----------------------------------------------------------------
    @staticmethod
    def _ref(ref):
        return quote(ref, safe="")

    @staticmethod
    def _modules(body, features, max_technicians):
        # features=None leaves the tenant's modules untouched; a list (possibly empty) sets them.
        if features is not None:
            body["features"] = list(features)
            body["max_technicians"] = max_technicians
        return body

    def provision(self, ref, company, admin_name, admin_email, plan, max_orgs, max_devices,
                  features=None, max_technicians=None):
        return self.request("POST", "/v1/tenants", self._modules({
            "subscription_ref": ref,
            "company_name": company,
            "admin_name": admin_name,
            "admin_email": admin_email,
            "plan": plan,
            "max_organizations": max_orgs,
            "max_devices": max_devices,
        }, features, max_technicians))

    def get(self, ref):
        return self.request("GET", f"/v1/tenants/{self._ref(ref)}")

    def set_plan(self, ref, plan, max_orgs, max_devices, features=None, max_technicians=None):
        return self.request("PATCH", f"/v1/tenants/{self._ref(ref)}/plan", self._modules(
            {"plan": plan, "max_organizations": max_orgs, "max_devices": max_devices}, features, max_technicians))

    def suspend(self, ref, reason=None):
        return self.request("POST", f"/v1/tenants/{self._ref(ref)}/suspend", {"reason": reason} if reason else {})

    def reactivate(self, ref, reason=None):
        return self.request("POST", f"/v1/tenants/{self._ref(ref)}/reactivate", {"reason": reason} if reason else {})

    def cancel(self, ref, reason=None):
        return self.request("POST", f"/v1/tenants/{self._ref(ref)}/cancel", {"reason": reason} if reason else {})

    def resend_invite(self, ref, admin_email=None, admin_name=None):
        payload = {}
        if admin_email:
            payload["admin_email"] = admin_email
        if admin_name:
            payload["admin_name"] = admin_name
        return self.request("POST", f"/v1/tenants/{self._ref(ref)}/invite", payload)


def verify_event(secret, timestamp, signature, path, body, max_skew=300):
    """Verify an event the bridge POSTs to Odoo (same scheme, method POST)."""
    if not timestamp or not signature or abs(time.time() - int(timestamp)) > max_skew:
        return False
    canonical = f"{timestamp}\nPOST\n{path}\n{body}".encode()
    expected = "sha256=" + hmac.new(secret.encode(), canonical, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


if __name__ == "__main__":
    if len(sys.argv) < 6:
        print(__doc__)
        sys.exit(2)
    base, token, secret, method, path = sys.argv[1:6]
    payload = json.loads(sys.argv[6]) if len(sys.argv) > 6 else None
    try:
        status, data = BridgeClient(base, token, secret).request(method, path, payload)
        print(status, json.dumps(data, indent=2))
    except BridgeError as exc:
        print(exc.status, exc.code, exc.message if hasattr(exc, "message") else str(exc), exc.details or "")
        sys.exit(1)
