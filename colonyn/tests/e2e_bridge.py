"""End-to-end check of a running bridge (use a STAGING Breeze, it creates tenants).

    BRIDGE_URL=... BRIDGE_TOKEN=... BRIDGE_SECRET=... python3 colonyn/tests/e2e_bridge.py
"""
import os, sys, json, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from bridge_client import BridgeClient, BridgeError
URL, TOKEN, SECRET = os.environ["BRIDGE_URL"], os.environ["BRIDGE_TOKEN"], os.environ["BRIDGE_SECRET"]
RUN = os.environ.get("RUN_ID", str(int(time.time())))
c = BridgeClient(URL, TOKEN, SECRET)
ok = 0; fail = 0
def check(name, cond, info=""):
    global ok, fail
    if cond: ok += 1; print("PASS", name)
    else: fail += 1; print("FAIL", name, info)

s, r = c.provision(f"e2e-{RUN}-1", "PT Uji Satu", "Budi", f"Budi.{RUN}@Example.com", "starter", 1, 50)
t = r["tenant"]
check("provision 201", s == 201, s)
check("plan/quota set", (t["plan"], t["max_organizations"], t["max_devices"]) == ("starter", 1, 50), t)
check("status active", t["status"] == "active", t["status"])
check("admin invited + email lowercased", t["admin"]["status"] == "invited" and t["admin"]["email"] == f"budi.{RUN}@example.com", t["admin"])
check("usage default org+site, admin seat", t["usage"] == {"organizations": 1, "sites": 1, "devices": 0, "technicians": 1}, t["usage"])
check("no modules recorded -> unrestricted", t["features"] is None and t["max_technicians"] is None, t)
check("invite sent or link returned", r["invite"]["sent"] or "/accept-invite?token=" in r["invite"].get("invite_url", ""), r["invite"])
invite_url = r["invite"].get("invite_url")

s, r2 = c.provision(f"e2e-{RUN}-1", "PT Uji Satu", "Budi", f"budi.{RUN}@example.com", "starter", 1, 50)
check("idempotent replay 200 same partner", s == 200 and r2["created"] is False and r2["tenant"]["partner_id"] == t["partner_id"], (s, r2.get("created")))

try:
    c.provision(f"e2e-{RUN}-2", "PT Lain", "X", f"budi.{RUN}@example.com", "starter", 1, 50); check("email in use 409", False)
except BridgeError as e: check("email in use 409", e.status == 409 and e.code == "EMAIL_IN_USE", e)

try:
    c.provision("odoo sub bad", "PT", "X", "x@example.com", "gold", -1, 5); check("validation 422", False)
except BridgeError as e: check("validation 422", e.status == 422 and len(e.details) >= 2, e.details)

s, r = c.set_plan(f"e2e-{RUN}-1", "pro", 5, 250)
check("plan update", (r["tenant"]["plan"], r["tenant"]["max_organizations"], r["tenant"]["max_devices"]) == ("pro", 5, 250), r["tenant"])
s, r = c.set_plan(f"e2e-{RUN}-1", "pro", None, None)
check("plan unlimited (null)", r["tenant"]["max_devices"] is None and r["tenant"]["max_organizations"] is None, r["tenant"])
c.set_plan(f"e2e-{RUN}-1", "pro", 5, 250)

s, r = c.suspend(f"e2e-{RUN}-1", "unpaid H+7")
check("suspend", r["changed"] and r["tenant"]["status"] == "suspended", r)
s, r = c.suspend(f"e2e-{RUN}-1")
check("suspend idempotent", r["changed"] is False, r)
s, r = c.reactivate(f"e2e-{RUN}-1", "paid")
check("reactivate", r["changed"] and r["tenant"]["status"] == "active", r)

s, r = c.resend_invite(f"e2e-{RUN}-1", admin_email=f"budi.baru.{RUN}@example.com", admin_name="Budi Baru")
check("resend invite with new email", r["admin_email"] == f"budi.baru.{RUN}@example.com", r)
s, r = c.get(f"e2e-{RUN}-1")
check("admin email changed", r["tenant"]["admin"]["email"] == f"budi.baru.{RUN}@example.com" and r["tenant"]["admin"]["name"] == "Budi Baru", r["tenant"]["admin"])

try: c.get(f"e2e-{RUN}-404"); check("404 unknown", False)
except BridgeError as e: check("404 unknown", e.status == 404 and e.code == "TENANT_NOT_FOUND", e)

bad = BridgeClient(URL, TOKEN, "wrong_secret_wrong_secret_wrong_secret")
try: bad.get(f"e2e-{RUN}-1"); check("bad signature 401", False)
except BridgeError as e: check("bad signature 401", e.status == 401 and e.code == "BAD_SIGNATURE", e)
bad2 = BridgeClient(URL, "nope", SECRET)
try: bad2.get(f"e2e-{RUN}-1"); check("bad token 401", False)
except BridgeError as e: check("bad token 401", e.status == 401 and e.code == "UNAUTHORIZED", e)

# ---- plan modules and technician seats
s, r = c.set_plan(f"e2e-{RUN}-1", "pro", 5, 250, features=["psa", "ai"], max_technicians=3)
t = r["tenant"]
check("modules set", t["features"] == ["psa", "ai"] and t["max_technicians"] == 3, t)
check("ai for office follows ai", t["ai_for_office_enabled"] is True, t)
check("service desk native with psa", t["service_management_mode"] == "native", t)
s, r = c.set_plan(f"e2e-{RUN}-1", "pro", 5, 250)
check("plan update without features keeps modules", r["tenant"]["features"] == ["psa", "ai"], r["tenant"])
s, r = c.set_plan(f"e2e-{RUN}-1", "starter", 1, 50, features=[], max_technicians=1)
t = r["tenant"]
check("downgrade: psa off -> service desk off", t["features"] == [] and t["service_management_mode"] == "off", t)
check("downgrade: ai for office off", t["ai_for_office_enabled"] is False, t)
check("no over-limit warning at 1 of 1", t["warnings"] == [], t)
s, r = c.set_plan(f"e2e-{RUN}-1", "pro", 5, 250, features=["psa", "backup"], max_technicians=None)
t = r["tenant"]
check("upgrade: service desk restored", t["service_management_mode"] == "native" and t["features"] == ["psa", "backup"], t)
check("unlimited technicians", t["max_technicians"] is None, t)
try:
    c.set_plan(f"e2e-{RUN}-1", "pro", 5, 250, features=["psa", "gold"]); check("unknown module 422", False)
except BridgeError as e: check("unknown module 422", e.status == 422, e)
s, r = c.provision(f"e2e-{RUN}-4", "PT Empat", "Rina", f"rina.{RUN}@example.com", "starter", 1, 50,
                   features=["security_plus"], max_technicians=2)
t = r["tenant"]
check("provision with modules", t["features"] == ["security_plus"] and t["max_technicians"] == 2 and t["service_management_mode"] == "off", t)

# provision a second tenant for cancel test
s, r = c.provision(f"e2e-{RUN}-3", "CV Tiga", "Sari", f"sari.{RUN}@example.com", "starter", 1, 50)
s, r = c.cancel(f"e2e-{RUN}-3", "customer stopped")
check("cancel -> offboarding", r["tenant"]["status"] == "offboarding", r["tenant"]["status"])
try: c.suspend(f"e2e-{RUN}-3"); check("suspend after cancel 409", False)
except BridgeError as e: check("suspend after cancel 409", e.status == 409, e)
s, r = c.reactivate(f"e2e-{RUN}-3", "came back")
check("reactivate from offboarding", r["tenant"]["status"] == "active", r["tenant"]["status"])

print(json.dumps({"pass": ok, "fail": fail}))
sys.exit(1 if fail else 0)
