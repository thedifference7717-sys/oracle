"""Append-only JSONL ledger of everything the scanner found and did.

Paper results and live results share a schema, so a paper run produces exactly
the record set a live run would. That is the point: you cannot judge whether
this is worth funding without a few weeks of records showing how often edges
appear, how big they are, and how many survive contact with execution.
"""
import json
import os
import time


def record(path, kind, payload):
    """Append one event. Ledger writes must never take down a scan."""
    row = {"ts": time.time(), "kind": kind, **payload}
    try:
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, separators=(",", ":")) + "\n")
    except OSError as e:
        print(f"[ledger error] {e}")
    return row


def opportunity_row(opp):
    return {
        "key": opp.key, "opp_kind": opp.kind, "title": opp.title,
        "venues": list(opp.venues), "contracts": opp.contracts,
        "cost_c": opp.cost_c, "payout_c": opp.payout_c,
        "profit_c": opp.profit_c, "roi": round(opp.roi, 6),
        "verified": opp.verified_pair, "notes": opp.notes,
        "legs": [{"venue": l.quote.venue, "market": l.quote.market_id,
                  "side": l.quote.side, "label": l.quote.label,
                  "contracts": l.contracts, "vwap_c": round(l.vwap_c, 3),
                  "limit_c": l.limit_c, "fee_c": l.fee_c}
                 for l in opp.legs],
    }


def read_all(path):
    rows = []
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        rows.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
    except FileNotFoundError:
        pass
    return rows


def summarise(path):
    """Aggregate the ledger into the numbers that answer 'is this worth it'."""
    rows = read_all(path)
    found = [r for r in rows if r.get("kind") == "opportunity"]
    fills = [r for r in rows if r.get("kind") == "execution"]
    booked = [f for f in fills if f.get("status") in ("filled", "partial", "paper")]

    # Capital tied up matters more than profit here: an edge you cannot fund,
    # or that locks cash for six months, is not the same as one that recycles.
    deployed_c = sum(f.get("cost_c", 0) for f in booked)
    profit_c = sum(f.get("profit_c", 0) for f in booked)
    return {
        "scans": len({r.get("scan_id") for r in rows if r.get("scan_id")}),
        "opportunities_found": len(found),
        "executions": len(fills),
        "booked": len(booked),
        "no_fill": len([f for f in fills if f.get("status") == "no_fill"]),
        "partial": len([f for f in fills if f.get("status") == "partial"]),
        "failed": len([f for f in fills if f.get("status") == "failed"]),
        "capital_deployed_usd": round(deployed_c / 100.0, 2),
        "profit_usd": round(profit_c / 100.0, 2),
        "return_on_deployed": round(profit_c / deployed_c, 6) if deployed_c else 0.0,
        "unhedged_incidents": len([f for f in fills
                                   if any("UNHEDGED" in e for e in f.get("errors", []))]),
    }
