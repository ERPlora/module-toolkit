#!/usr/bin/env python3
"""Round trip against the REAL kernel — `erplora test --against-hub` (module-toolkit#110).

This battery is the fixture that proves the harness: it does not emulate the runtime, it TALKS to
one. `erplora test <this module> --against-hub` starts the published hub image with its own
Postgres, installs this module through `POST /api/modules/install`, and hands the url over in
`ERPLORA_HUB_BASE_URL`.

What it asserts is deliberately made of things a scratch-Postgres emulation cannot show:

  · `:new_id` and `:hub_id` are injected BY THE RUNTIME (`system_params`) — the SQL never receives
    them from the payload, and a hand-written harness that binds them itself proves nothing;
  · a `BIGINT` comes back over HTTP as a JSON **string**, because that is what the runtime does;
  · rows are scoped by `hub_id`: the same query under another `X-Hub-Id` sees NOTHING.

It refuses to skip. Without a hub it FAILS, because a battery that excuses itself is the green that
proves nothing this whole toolkit exists to remove.
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("ERPLORA_HUB_BASE_URL", "").rstrip("/")
HUB = os.environ.get("ERPLORA_HUB_ID", "local")

if not BASE:
    print("totals.hub: no hay runtime al otro lado (ERPLORA_HUB_BASE_URL vacía).")
    print("Se corre con `erplora test <dir> --against-hub`; sin hub esto NO es un skip, es un fallo.")
    sys.exit(1)


def call(path, body, hub_id=HUB):
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "x-hub-id": hub_id},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read().decode())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read().decode() or "{}")


def total(hub_id=HUB):
    status, body = call("/api/query", {"name": "kernel_fixture.items.total", "params": {}}, hub_id)
    assert status == 200, f"la query respondió {status}: {body}"
    return body["data"][0]["total_cents"]


failures = []

# 1 · the command writes through the runtime, which injects `:new_id` and `:hub_id` itself.
for name, cents in (("espresso", 150), ("cortado", 250)):
    status, body = call(
        "/api/command",
        {"name": "kernel_fixture.items.create", "payload": {"name": name, "amount_cents": cents}},
    )
    if status != 200 or not body.get("ok"):
        failures.append(f"kernel_fixture.items.create({name}) respondió {status}: {body}")

# 2 · the total, as the runtime serialises it: a BIGINT arrives as a JSON string.
got = total()
if got != "400":
    failures.append(f"total_cents esperado '400' (string, como lo serializa el runtime), llegó {got!r}")

# 3 · tenancy: the SAME query under another hub sees nothing. Only the kernel enforces this.
other = total("otro-hub")
if other != "0":
    failures.append(f"aislamiento por hub_id roto: otro hub ve {other!r} en vez de '0'")

# 4 · a command whose payload breaks its own JSON Schema is rejected BY THE RUNTIME.
status, body = call(
    "/api/command",
    {"name": "kernel_fixture.items.create", "payload": {"name": "", "amount_cents": -1}},
)
if status == 200:
    failures.append(f"el runtime ACEPTÓ un payload que su schema prohíbe: {body}")

if failures:
    print(f"✗ totals.hub: {len(failures)} fallo(s)")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)

print(f"✓ totals.hub: round trip contra {os.environ.get('ERPLORA_HUB_IMAGE', BASE)} correcto")
