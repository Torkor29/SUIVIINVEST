"""Test hors ligne du sidecar Trade Republic contre un faux websocket ``pytr``.

Reproduit le protocole réel : un abonnement renvoie un NUMÉRO, les données
arrivent ensuite par ``recv()`` (avec des messages d'autres abonnements
intercalés). Lancer avec le Python qui a ``pytr`` :

    /opt/sidecar-venv/bin/python sidecar/trade-republic/test_sidecar.py
"""
import asyncio, importlib.util, json, pathlib
from pytr.api import TradeRepublicApi
spec = importlib.util.spec_from_file_location("sc", pathlib.Path(__file__).with_name("sidecar.py"))
sc = importlib.util.module_from_spec(spec); spec.loader.exec_module(sc)

RESP = {
  "compactPortfolioByType": {"categories": [{"categoryType": "stocksAndETFs", "positions": [
      {"isin": "IE00B5BMR087", "netSize": "10.5", "averageBuyIn": "480.0"},
      {"isin": "US0378331005", "netSize": "2", "averageBuyIn": "150"}]}]},
  "cash": [{"accountNumber": "x", "currencyId": "EUR", "amount": 1.37}],
  "instrument": {"IE00B5BMR087": {"shortName": "Core S&P 500 USD (Acc)", "exchangeIds": ["LSX"], "typeId": "fund"},
                 "US0378331005": {"shortName": "Apple", "exchangeIds": [], "typeId": "stock"}},
  "ticker": {"IE00B5BMR087.LSX": {"last": {"price": "600.10"}}},
  "timelineTransactions": {None: {"items": [
      {"id": "t1", "timestamp": "2026-09-01T10:00:00.000+0000", "title": "Virement", "subtitle": "Reçu", "eventType": "INCOMING_TRANSFER", "amount": {"value": 500, "currency": "EUR"}},
      {"id": "t2", "timestamp": "2026-09-02T10:00:00.000+0000", "title": "Core S&P 500", "subtitle": "Plan d'épargne exécuté", "eventType": "SAVINGS_PLAN_EXECUTED", "amount": {"value": -100, "currency": "EUR"}}],
      "cursors": {}}},
  "timelineDetailV2": {},
  "savingsPlans": {"savingsPlans": [{"id": "p1", "instrumentId": "IE00B5BMR087", "amount": 100, "interval": "monthly"}]},
}

class Fake(TradeRepublicApi):
    def __init__(self):
        self.subscriptions = {}; self._previous_responses = {}; self.queue = asyncio.Queue(); self.n = 0
        self._sec_acc_no = "1"; self.log = __import__("logging").getLogger("x")
    async def subscribe(self, payload):
        self.n += 1; sid = str(self.n); self.subscriptions[sid] = payload
        t = payload["type"]; r = RESP.get(t)
        if t == "instrument": r = RESP["instrument"].get(payload["id"])
        elif t == "ticker": r = RESP["ticker"].get(payload["id"])
        elif t == "timelineTransactions": r = RESP["timelineTransactions"].get(payload.get("after"))
        elif t == "timelineDetailV2": r = None  # pas de détail : doit rester robuste
        # une réponse parasite d'un autre abonnement, comme en vrai
        await self.queue.put(("999", {"type": "noise"}, {}))
        if r is not None: await self.queue.put((sid, payload, r))
        return sid
    async def recv(self):
        while True:
            sid, sub, r = await self.queue.get()
            if sid in self.subscriptions: return sid, sub, r
    async def unsubscribe(self, sid): self.subscriptions.pop(sid, None)

sc.RECV_TIMEOUT = 0.5

portfolio = sc.HANDLERS["portfolio"](Fake(), {})
warnings = portfolio.pop("_warnings")
assert portfolio["accounts"][1]["balance"] == 1.37, portfolio
etf, apple = portfolio["positions"]
assert (etf["name"], etf["quantity"], etf["price"], etf["kind"]) == ("Core S&P 500 USD (Acc)", 10.5, 600.1, "etf"), etf
assert apple["price"] == 150.0 and warnings, "sans cours : prix de revient moyen + avertissement"

cash = sc.HANDLERS["cash"](Fake(), {})
assert cash["balances"][0]["cash"] == 1.37, cash

movements = sc.HANDLERS["transactions"](Fake(), {})["transactions"]
assert [(m["category"], m["type"], m["amount"]) for m in movements] == [
    ("CASH", "TRANSFER_INBOUND", 500.0),
    ("TRADING", "BUY", -100.0),
], movements

plans = sc.HANDLERS["savingsplans"](Fake(), {})["savingsPlans"]
assert plans[0]["amount"] == 100.0, plans
print("OK : portefeuille, espèces, mouvements et plans d'épargne lus via recv().")
