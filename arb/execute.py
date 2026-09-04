"""Order execution with multi-leg reconciliation.

There is no atomic multi-leg order on either venue. Legs fill independently, so
the honest model is: fire every leg immediate-or-cancel, see what came back, and
then *force the position back into balance*.

An arbitrage basket only pays $1 if you hold exactly the same number of
contracts on every leg. Holding 40 of one and 25 of another is not a hedged
book -- it is a 15-contract naked directional bet that nobody decided to take.
So after firing, we level down to the minimum fill across legs and sell back
every excess contract, accepting a small realised loss on the unwind rather
than carrying unhedged exposure. Levelling down is always possible; levelling
up means chasing a book that just moved away from us.

Live trading is gated twice (ARB_DRY_RUN=false *and* ARB_LIVE=1) and requires
credentials. Without all three this module reports what it would have done.
"""
import base64
import time
import uuid

import requests

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    _HAS_CRYPTO = True
except BaseException as _crypto_err:  # noqa: BLE001
    # Signing is only needed for live trading, so a missing *or broken* install
    # must still leave paper mode fully usable. This catches BaseException on
    # purpose: a cryptography built against mismatched bindings raises a pyo3
    # PanicException, which does not derive from Exception and would otherwise
    # take the whole scanner down before it reads a single book.
    if isinstance(_crypto_err, (KeyboardInterrupt, SystemExit)):
        raise
    _HAS_CRYPTO = False


class ExecutionError(Exception):
    pass


# --- Kalshi request signing ------------------------------------------------
def sign_request(private_key_pem, timestamp_ms, method, path):
    """RSA-PSS signature over timestamp+method+path, base64 encoded.

    ``path`` is the request path with no query string, including the
    /trade-api/v2 prefix.
    """
    if not _HAS_CRYPTO:
        raise ExecutionError(
            f"cryptography unavailable, required for live Kalshi trading "
            f"(pip install -r arb/requirements.txt): {_crypto_err}")
    key = serialization.load_pem_private_key(
        private_key_pem.encode() if isinstance(private_key_pem, str)
        else private_key_pem, password=None)
    message = f"{timestamp_ms}{method}{path}".encode()
    signature = key.sign(
        message,
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()),
                    salt_length=padding.PSS.DIGEST_LENGTH),
        hashes.SHA256(),
    )
    return base64.b64encode(signature).decode()


def build_order(leg, contracts, action="buy", client_order_id=None):
    """Build a Kalshi order body for one leg.

    Buys are priced at the leg's worst touched level so a single order can
    sweep the ladder without ever paying above what the opportunity was priced
    at. expiration_ts=0 requests immediate-or-cancel: we want the fill now or
    not at all, because a resting order is a free option for everyone else.
    """
    side = leg.quote.side
    price_key = "yes_price" if side == "yes" else "no_price"
    return {
        "ticker": leg.quote.market_id,
        "client_order_id": client_order_id or f"arb_{uuid.uuid4().hex[:16]}",
        "action": action,
        "side": side,
        "count": int(contracts),
        "type": "limit",
        price_key: int(leg.limit_c),
        "expiration_ts": 0,
    }


class KalshiExecutor:
    """Places and reconciles orders against Kalshi's portfolio endpoints."""

    def __init__(self, cfg, session=None):
        self.cfg = cfg
        self.base = cfg.kalshi_api_base.rstrip("/")
        self.s = session or requests.Session()

    def _headers(self, method, path):
        if self.cfg.kalshi_bearer:
            return {"Authorization": f"Bearer {self.cfg.kalshi_bearer}"}
        ts = str(int(time.time() * 1000))
        return {
            "KALSHI-ACCESS-KEY": self.cfg.kalshi_key_id,
            "KALSHI-ACCESS-TIMESTAMP": ts,
            "KALSHI-ACCESS-SIGNATURE": sign_request(
                self.cfg.kalshi_private_key, ts, method, path),
            "Content-Type": "application/json",
        }

    def _post(self, path, body):
        url = f"{self.base}{path}"
        r = self.s.post(url, json=body,
                        headers=self._headers("POST", _path_of(url)),
                        timeout=self.cfg.request_timeout)
        if not r.ok:
            raise ExecutionError(f"POST {path} -> {r.status_code} {r.text[:300]}")
        return r.json()

    def balance_c(self):
        url = f"{self.base}/portfolio/balance"
        r = self.s.get(url, headers=self._headers("GET", _path_of(url)),
                       timeout=self.cfg.request_timeout)
        if not r.ok:
            raise ExecutionError(f"balance -> {r.status_code} {r.text[:200]}")
        return int((r.json() or {}).get("balance", 0))

    def place(self, leg, contracts, action="buy"):
        """Fire one IOC leg. Returns (filled_contracts, order_id).

        Kalshi reports the taker fill count on the created order; treat an
        absent count as zero filled rather than assuming success, so an
        unexpected response shape can never be mistaken for a hedged leg.
        """
        body = build_order(leg, contracts, action=action)
        resp = self._post("/portfolio/orders", body)
        order = (resp or {}).get("order") or {}
        filled = order.get("taker_fill_count")
        if filled is None:
            filled = order.get("fill_count", 0)
        return int(filled or 0), order.get("order_id")


def execute_opportunity(opp, executor, dry_run=True):
    """Fire every leg, then level the basket down to a balanced position.

    Returns a result dict describing what filled, what was unwound and the
    realised outcome. Never raises on a leg failure: an exception mid-basket
    would strand a half-open position with nobody reconciling it.
    """
    result = {
        "key": opp.key, "title": opp.title, "requested": opp.contracts,
        "dry_run": dry_run, "legs": [], "unwound": [], "errors": [],
        "filled": 0, "status": "pending",
    }

    if dry_run:
        result.update(status="paper",
                      filled=opp.contracts,
                      legs=[{"market": l.quote.market_id, "side": l.quote.side,
                             "contracts": l.contracts, "limit_c": l.limit_c}
                            for l in opp.legs])
        return result

    # Thinnest leg first: it is the one most likely to fail, and failing it
    # early means the least capital is committed when we have to back out.
    order = sorted(opp.legs, key=lambda l: l.quote.depth)
    fills = {}
    for leg in order:
        try:
            filled, oid = executor.place(leg, opp.contracts)
            fills[id(leg)] = filled
            result["legs"].append({
                "market": leg.quote.market_id, "side": leg.quote.side,
                "requested": opp.contracts, "filled": filled,
                "limit_c": leg.limit_c, "order_id": oid,
            })
            if filled == 0:
                result["errors"].append(
                    f"{leg.quote.market_id} {leg.quote.side}: no fill")
                break
        except ExecutionError as e:
            fills[id(leg)] = 0
            result["errors"].append(f"{leg.quote.market_id}: {e}")
            break

    target = min((fills.get(id(l), 0) for l in opp.legs), default=0)
    result["filled"] = target

    # Anything above the balanced size is naked exposure -- sell it back now.
    for leg in opp.legs:
        excess = fills.get(id(leg), 0) - target
        if excess > 0:
            try:
                sold, oid = executor.place(leg, excess, action="sell")
                result["unwound"].append({
                    "market": leg.quote.market_id, "side": leg.quote.side,
                    "contracts": excess, "sold": sold, "order_id": oid})
                if sold < excess:
                    result["errors"].append(
                        f"{leg.quote.market_id}: {excess - sold} contracts "
                        f"left UNHEDGED - manual intervention required")
            except ExecutionError as e:
                result["errors"].append(
                    f"unwind {leg.quote.market_id} FAILED: {e} - "
                    f"{excess} contracts left UNHEDGED")

    if target == 0:
        result["status"] = "no_fill" if not result["errors"] else "failed"
    elif target < opp.contracts:
        result["status"] = "partial"
    else:
        result["status"] = "filled"
    return result


def _path_of(url):
    """Path component of a URL, without scheme, host or query string."""
    after_scheme = url.split("://", 1)[-1]
    path = "/" + after_scheme.split("/", 1)[1] if "/" in after_scheme else "/"
    return path.split("?", 1)[0]
