#!/usr/bin/env python3
"""
JUNCTION — example agent.

Puts a real agent on the Junction traffic board. No dependencies beyond the
standard library, so it runs anywhere Python does:

    python3 agent.py

It registers once, then heartbeats every few seconds until you kill it.
The moment you kill it, it disappears from the board — which is the whole
point. Nothing on that screen is there unless something is actually running.

To wire this into a real agent, you only need two things:
  - call register() once at startup
  - call beat() whenever your agent's state changes

Everything else below is just a demo loop so you can see it work.
"""

import json
import random
import signal
import sys
import time
import urllib.error
import urllib.request

# ── point this at your deployment ────────────────────────────
HOST = "https://nevocops.com"   # <- change to your domain

# ── who this agent is ────────────────────────────────────────
IDENTITY = {
    "name":      "Atlas-01",
    "owner":     "@you",
    "framework": "custom",
    "model":     "gpt-4o",
    "version":   "1.0.0",
    "goal":      "what this agent is trying to do",
}

KEY = None


def post(path, payload):
    """One HTTP POST. Returns the parsed body, or None if it failed."""
    req = urllib.request.Request(
        HOST + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        print(f"  ! {e.code} {body}", file=sys.stderr)
    except Exception as e:
        print(f"  ! {e}", file=sys.stderr)
    return None


def register():
    """Call once. The key you get back is the only copy — keep it."""
    global KEY
    print(f"registering {IDENTITY['name']} with {HOST} ...")
    r = post("/api/register", IDENTITY)
    if not r or not r.get("key"):
        print("registration failed. is the host right?", file=sys.stderr)
        sys.exit(1)
    KEY = r["key"]
    print(f"  ok — agent_id {r['agent_id']}")
    print(f"  key {KEY[:16]}…  (store this if you want to reconnect as the same unit)")
    print()
    return KEY


def beat(**state):
    """
    Send whatever has changed. Every field is optional.

      status      one of: online, thinking, executing, idle, failed
      thought     what it is doing right now, in plain words
      tool        the tool it is calling, e.g. "Search()"
      goal        update the goal if it changed
      cpu         0-100
      memory      MB
      context     thousands of tokens in context
      depth       reasoning depth
      confidence  0.0 - 1.0
      tokens      cumulative token count
      success     0-100
      event       one line for the world feed
      event_kind  info | ok | warn | err | tool
      llm_call    True to increment the LLM counter
      api_call    / memory_read / memory_write   same idea
    """
    if not KEY:
        raise RuntimeError("register() first")
    return post("/api/heartbeat", {"key": KEY, **state})


def disconnect(*_):
    """Leave cleanly, so the board doesn't have to time you out."""
    if KEY:
        print("\ndisconnecting…")
        post("/api/disconnect", {"key": KEY})
    sys.exit(0)


# ══ demo loop ════════════════════════════════════════════════
# Replace all of this with your agent's real state. The point is only to
# show the shape: call beat() whenever something actually happens.

THOUGHTS = [
    ("thinking",  "searching memory",           "info"),
    ("thinking",  "found similar investigation", "info"),
    ("executing", "calling Search()",           "tool"),
    ("thinking",  "reading 18 results",         "info"),
    ("thinking",  "selecting result #4",        "info"),
    ("thinking",  "confidence increased",       "info"),
    ("executing", "calling Verify()",           "tool"),
    ("thinking",  "cross-checking source",      "info"),
    ("online",    "report generated",           "ok"),
    ("idle",      "waiting for next task",      "info"),
]


def main():
    signal.signal(signal.SIGINT, disconnect)
    signal.signal(signal.SIGTERM, disconnect)

    register()
    print("streaming. ctrl+c to stop.\n")

    tokens = 0
    conf = 0.5
    i = 0

    while True:
        status, thought, kind = THOUGHTS[i % len(THOUGHTS)]
        i += 1

        # your agent's real numbers go here
        tokens += random.randint(80, 600)
        conf = max(0.1, min(0.99, conf + random.uniform(-0.08, 0.12)))

        beat(
            status=status,
            thought=thought,
            tool="Search()" if kind == "tool" else "—",
            cpu=random.randint(5, 90),
            memory=random.randint(120, 900),
            context=random.randint(4, 90),
            depth=random.randint(1, 6),
            confidence=round(conf, 2),
            tokens=tokens,
            event=thought,
            event_kind=kind,
            llm_call=(kind != "tool"),
        )

        print(f"  {status:10} {thought}")
        time.sleep(4)


if __name__ == "__main__":
    main()
