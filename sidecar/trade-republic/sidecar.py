#!/usr/bin/env python3
"""Sidecar Trade Republic — STRICTEMENT EN LECTURE SEULE (``pytr``).

Processus isolé : reçoit une requête JSON sur l'entrée standard et répond du JSON
sur la sortie standard (protocole décrit dans ``docs/connectors/sidecars.md``).

Opérations exposées : ``test``, ``portfolio``, ``cash``, ``positions``,
``transactions``, ``income``, ``savingsplans``.

GARANTIES
---------
* **Aucune fonction d'ordre.** ``pytr`` expose ``market_order`` / ``limit_order`` /
  ``stop_market_order`` : elles ne sont JAMAIS appelées. Seules les méthodes de
  lecture figurent dans ``READ_ONLY_METHODS``.
* **Aucun mot de passe conservé en clair.** Le mot de passe (PIN) n'est utilisé
  qu'au moment de la connexion. La session est ensuite portée par le fichier de
  cookies que ``pytr`` écrit lui-même (``~/.pytr/cookies.<téléphone>.txt``) : aux
  appels suivants, ``resume_websession()`` rouvre la session SANS identifiants.
  C'est ce fichier local (et lui seul) qui permet la REPRISE après validation.
* **MFA jamais contournée.** Si l'approbation dans l'application mobile est
  requise et non encore donnée, le sidecar renvoie ``MFA_REQUIRED`` avec
  ``requiresUserAction: true`` et le message « Validation Trade Republic requise ».
* La bibliothèque est optionnelle : sans elle, le script reste importable et
  répond ``NOT_SUPPORTED`` au lieu de planter.

⚠️ ``pytr`` utilise une API privée non officielle (WAF AWS, version d'application
épinglée) : elle peut casser à tout moment et son usage relève des conditions
d'utilisation de Trade Republic (voir ``sidecar/README.md``).
"""

from __future__ import annotations

import asyncio
import json
import sys
import threading
from datetime import date, datetime, timezone
from typing import Any, Callable

SIDECAR_NAME = "trade-republic"
READ_ONLY_OPERATIONS = (
    "test",
    "portfolio",
    "cash",
    "positions",
    "transactions",
    "income",
    "savingsplans",
)

#: Message EXACT attendu par l'application pour la validation mobile.
MFA_MESSAGE = "Validation Trade Republic requise"

#: Liste blanche des méthodes de ``pytr`` autorisées (lecture seule uniquement).
READ_ONLY_METHODS = frozenset(
    {
        "portfolio",
        "compact_portfolio",
        "cash",
        "available_cash_for_payout",
        "timeline",
        "timeline_transactions",
        "timeline_detail",
        "timeline_detail_v2",
        "savings_plan_overview",
        "instrument_details",
        "stock_details",
        "order_overview",
        "settings",
        "ticker",
        "timeline_transactions",
    }
)

#: Nombre maximal de mouvements de timeline enrichis (bornage raisonnable).
MAX_TIMELINE_ITEMS = 200


class SidecarError(Exception):
    def __init__(self, code: str, message: str, requires_user_action: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.requires_user_action = requires_user_action


# --------------------------------------------------------------------------- utils


def _fail(code: str, message: str, requires_user_action: bool = False) -> dict:
    return {
        "ok": False,
        "code": code,
        "message": message,
        "requiresUserAction": bool(requires_user_action),
    }


def _as_dict(obj: Any) -> dict:
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    if hasattr(obj, "__dict__"):
        return {k: v for k, v in vars(obj).items() if not k.startswith("_")}
    return {}


def _to_float(value: Any) -> float | None:
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _iso_date(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.strftime("%Y-%m-%d")
    text = str(value).strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).strftime("%Y-%m-%d")
    except ValueError:
        return text[:10]


def _first(d: dict, *names: str) -> Any:
    for name in names:
        if name in d and d[name] is not None:
            return d[name]
    return None


# ------------------------------------------------------------------------- login


def _load_library() -> Any:
    try:
        from pytr.api import TradeRepublicApi
    except ImportError as exc:
        raise SidecarError(
            "NOT_SUPPORTED",
            "La bibliothèque Python « pytr » n'est pas installée : installez-la avec "
            "`uv pip install pytr` (voir sidecar/README.md). "
            f"Détail : {exc}",
        ) from exc
    return TradeRepublicApi


def normalize_phone(raw: str) -> str:
    """Numéro au format international attendu par Trade Republic (+33612345678).

    Accepte « 06 12 34 56 78 », « 0033 6… », « 33612345678 » ou « +33 6-12… ».
    Sans indicatif, un numéro à 10 chiffres commençant par 0 est supposé français.
    """
    digits = "".join(ch for ch in raw.strip() if ch.isdigit() or ch == "+")
    if digits.startswith("00"):
        digits = "+" + digits[2:]
    if digits.startswith("+"):
        return "+" + digits[1:].replace("+", "")
    if len(digits) == 10 and digits.startswith("0"):
        return "+33" + digits[1:]
    if len(digits) == 11 and digits.startswith("33"):
        return "+" + digits
    return digits


def _http_status(exc: Exception) -> int | None:
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    return status if isinstance(status, int) else None


def _login_refused(exc: Exception) -> SidecarError:
    """Échec de l'envoi du numéro et du PIN : aucune demande n'a pu partir vers l'application."""
    status = _http_status(exc)
    text = str(exc)
    if status == 429 or "429" in text or "too many" in text.lower():
        return SidecarError(
            "RATE_LIMITED",
            "Trade Republic bloque temporairement les connexions (trop de tentatives). Réessayez dans 15 à 30 minutes.",
        )
    if status in (400, 401, 403, 404, 422):
        return SidecarError(
            "AUTH_REQUIRED",
            f"Trade Republic refuse le numéro ou le PIN (HTTP {status}) : aucune demande n'a été envoyée à "
            "l'application. Vérifiez le numéro au format international (+33612345678) et le PIN à 4 chiffres.",
        )
    if "awselb" in text.lower() or status == 405:
        return SidecarError(
            "PROVIDER_BROKEN",
            "Trade Republic a bloqué la demande de connexion (protection anti-robot). Réessayez plus tard.",
        )
    return _classify_exception(exc)


def _classify_exception(exc: Exception) -> SidecarError:
    name = type(exc).__name__
    text = str(exc)
    lowered = text.lower()
    if "rejected" in lowered or "already been used" in lowered:
        return SidecarError(
            "AUTH_REQUIRED",
            "La connexion a été refusée dans l'application Trade Republic : relancez la synchronisation et acceptez-la.",
            requires_user_action=True,
        )
    if "expired" in lowered and "login request" in lowered:
        return SidecarError("MFA_REQUIRED", MFA_MESSAGE, requires_user_action=True)
    if name in ("TimeoutError",) or "not confirmed in time" in lowered or "still waiting" in lowered:
        return SidecarError("MFA_REQUIRED", MFA_MESSAGE, requires_user_action=True)
    if "authenticator" in lowered or "weblogin" in lowered or "confirm the login" in lowered:
        return SidecarError("MFA_REQUIRED", MFA_MESSAGE, requires_user_action=True)
    if "429" in lowered or "too_many_requests" in lowered or "too many requests" in lowered:
        return SidecarError("RATE_LIMITED", "Trade Republic limite temporairement les accès (HTTP 429).")
    if "validation code" in lowered or "code" in lowered and "invalid" in lowered:
        return SidecarError("MFA_REQUIRED", MFA_MESSAGE, requires_user_action=True)
    if "pin" in lowered or "credentials" in lowered or "phone" in lowered:
        return SidecarError("AUTH_REQUIRED", "Identifiants Trade Republic refusés : vérifiez-les.")
    if "login failed" in lowered:
        return SidecarError("AUTH_REQUIRED", f"Connexion Trade Republic refusée ({text[:120]}).")
    if "401" in lowered or "unauthor" in lowered or "session" in lowered:
        return SidecarError(
            "SESSION_EXPIRED",
            "Session Trade Republic expirée : relancez la synchronisation et acceptez la connexion dans l'application.",
        )
    if any(token in lowered for token in ("connection", "timeout", "timed out", "ssl", "dns", "awselb")):
        return SidecarError("PROVIDER_DOWN", "Service Trade Republic injoignable : réessayez plus tard.")
    return SidecarError("PROVIDER_BROKEN", f"Échec Trade Republic inattendu : {text[:300]}")


def _complete_weblogin_bounded(tr: Any, timeout_seconds: float) -> None:
    """Attend l'approbation dans l'application, sans bloquer indéfiniment."""
    result: dict[str, Any] = {}

    def run() -> None:
        try:
            tr.complete_weblogin()
            result["ok"] = True
        except Exception as exc:  # noqa: BLE001
            result["error"] = exc

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(max(1.0, timeout_seconds))
    if thread.is_alive():
        # L'approbation n'est pas encore donnée : l'utilisateur doit agir, la
        # session sera reprise au prochain appel une fois le cookie écrit.
        raise SidecarError("MFA_REQUIRED", MFA_MESSAGE, requires_user_action=True)
    if "error" in result:
        raise _classify_exception(result["error"])
    if not result.get("ok"):
        raise SidecarError("MFA_REQUIRED", MFA_MESSAGE, requires_user_action=True)


def _ensure_session_dir() -> None:
    import os
    from pathlib import Path

    session_dir = Path.home() / ".pytr"
    session_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(session_dir, 0o700)


def _open_api(secrets: dict, params: dict) -> Any:
    """Ouvre (ou reprend) une session de lecture seule et renvoie le client ``pytr``."""
    TradeRepublicApi = _load_library()
    phone = normalize_phone(secrets.get("phone") or "")
    pin = (secrets.get("pin") or "").strip()
    verify_code = (secrets.get("verify_code") or secrets.get("two_factor_code") or "").strip()
    if not phone:
        raise SidecarError(
            "AUTH_REQUIRED",
            "Numéro de téléphone Trade Republic requis : renseignez-le dans SuiviInvest "
            "(chiffré en base, transmis ici sans être écrit sur disque).",
        )
    # Moins de 100 s : au-delà, Cloudflare coupe la requête avant la réponse.
    approval_timeout = float(params.get("approvalTimeoutSeconds") or 75)
    # pytr enregistre la session dans ~/.pytr sans créer ce dossier : sans lui,
    # la connexion approuvée dans l'application serait perdue aussitôt.
    _ensure_session_dir()
    try:
        # save_cookies=True : pytr écrit ~/.pytr/cookies.<phone>.txt, SEUL état de
        # session persisté ; aucun mot de passe n'y figure.
        tr = TradeRepublicApi(phone_no=phone, pin=pin, save_cookies=True, use_v2_login=True)
    except ValueError as exc:
        raise SidecarError(
            "AUTH_REQUIRED",
            f"Identifiants Trade Republic incomplets : {str(exc)[:200]}",
        ) from exc

    try:
        if tr.resume_websession():
            return tr
        if not pin:
            raise SidecarError(
                "AUTH_REQUIRED",
                "PIN Trade Republic requis pour la première connexion (ou une session déjà "
                "validée dans ~/.pytr).",
            )
        try:
            tr.initiate_weblogin()
        except Exception as exc:  # noqa: BLE001
            raise _login_refused(exc) from exc
        if getattr(tr, "weblogin_needs_authenticator", False):
            if not verify_code:
                raise SidecarError("MFA_REQUIRED", MFA_MESSAGE, requires_user_action=True)
            tr.complete_weblogin(verify_code=verify_code)
        else:
            _complete_weblogin_bounded(tr, approval_timeout)
    except SidecarError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _classify_exception(exc) from exc
    return tr


def _run(coro: Any) -> Any:
    return asyncio.new_event_loop().run_until_complete(coro)


# ------------------------------------------------------------ lecture websocket
#
# Dans ``pytr``, ``await tr.compact_portfolio()`` (comme ``cash()``,
# ``timeline_transactions()``…) ne renvoie PAS les données : il ouvre un
# abonnement et renvoie son numéro. Les réponses arrivent ensuite par
# ``tr.recv()``. Les fonctions ci-dessous attendent ces réponses.

#: Délai d'attente d'une réponse Trade Republic (secondes).
RECV_TIMEOUT = 20.0


async def _fetch_one(tr: Any, subscribe: Any, timeout: float = RECV_TIMEOUT) -> Any:
    """S'abonne, attend LA réponse de cet abonnement, puis se désabonne."""
    return await tr._receive_one(subscribe, timeout=timeout)


async def _fetch_many(tr: Any, subscribes: dict, timeout: float = RECV_TIMEOUT) -> dict:
    """Plusieurs abonnements en parallèle : {clé: réponse} (clés sans réponse absentes)."""
    pending: dict = {}
    for key, subscribe in subscribes.items():
        pending[await subscribe] = key
    results: dict = {}
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while pending:
        remaining = deadline - loop.time()
        if remaining <= 0:
            break
        try:
            sub_id, _subscription, response = await asyncio.wait_for(tr.recv(), remaining)
        except asyncio.TimeoutError:
            break
        except Exception:  # noqa: BLE001 - réponse en erreur pour un seul élément
            continue
        key = pending.pop(sub_id, None)
        if key is None:
            continue
        results[key] = response
        try:
            await tr.unsubscribe(sub_id)
        except Exception:  # noqa: BLE001
            pass
    for sub_id in list(pending):
        try:
            await tr.unsubscribe(sub_id)
        except Exception:  # noqa: BLE001
            pass
    return results


# ------------------------------------------------------------------ portefeuille


def _kind_from_type(type_id: Any) -> str | None:
    text = str(type_id or "").lower()
    if not text:
        return None
    if "crypto" in text:
        return "crypto"
    if "fund" in text or "etf" in text:
        return "etf"
    if "stock" in text or "share" in text:
        return "stock"
    if "bond" in text:
        return "bond"
    return text


async def _portfolio_positions(tr: Any) -> tuple[list[dict], list[str]]:
    """Positions du portefeuille, valorisées au dernier cours Trade Republic."""
    warnings: list[str] = []
    portfolio = _as_dict(await _fetch_one(tr, tr.compact_portfolio()))
    rows: list[dict] = []
    for category in portfolio.get("categories") or []:
        category = _as_dict(category)
        for row in category.get("positions") or []:
            row = dict(_as_dict(row))
            row.setdefault("_category", category.get("categoryType"))
            rows.append(row)
    if not rows and isinstance(portfolio.get("positions"), list):
        rows = [dict(_as_dict(row)) for row in portfolio["positions"]]

    isins = [str(_first(row, "isin", "instrumentId")) for row in rows if _first(row, "isin", "instrumentId")]
    details = await _fetch_many(tr, {isin: tr.instrument_details(isin) for isin in isins})
    tickers: dict = {}
    for isin in isins:
        exchanges = _as_dict(details.get(isin)).get("exchangeIds") or []
        if exchanges:
            tickers[isin] = tr.ticker(isin, exchange=exchanges[0])
    quotes = await _fetch_many(tr, tickers, timeout=10.0)

    positions = []
    for row in rows:
        isin = _first(row, "isin", "instrumentId")
        detail = _as_dict(details.get(isin))
        quantity = _to_float(_first(row, "netSize", "quantity", "shares")) or 0.0
        if quantity <= 0:
            continue
        price = _to_float(_as_dict(_as_dict(quotes.get(isin)).get("last")).get("price"))
        if price is None:
            price = _to_float(_first(row, "averageBuyIn", "averagePrice"))
            if price is not None:
                warnings.append(
                    f"Cours indisponible pour {detail.get('shortName') or isin} : valorisé au prix de revient moyen."
                )
        name = detail.get("shortName") or detail.get("name") or _first(row, "name") or isin
        # Obligations : cours exprimé en pourcentage du nominal.
        if price is not None and _kind_from_type(detail.get("typeId")) == "bond":
            price = price / 100
        positions.append(
            {
                "accountId": "securities",
                "isin": isin,
                "name": name or "Titre Trade Republic",
                "quantity": quantity,
                "price": price,
                "currency": "EUR",
                "kind": _kind_from_type(detail.get("typeId") or row.get("_category")),
            }
        )
    return positions, warnings


def _cash_total(response: Any) -> float | None:
    """Espèces en euros : la réponse est une liste de comptes {currencyId, amount}."""
    entries = response if isinstance(response, list) else [response]
    total = None
    for entry in entries:
        entry = _as_dict(entry)
        currency = str(_first(entry, "currencyId", "currency") or "EUR").upper()
        amount = _to_float(_first(entry, "amount", "value"))
        if amount is None or currency != "EUR":
            continue
        total = (total or 0.0) + amount
    return total


# ------------------------------------------------------------------ mouvements

#: Types (vocabulaire de ``pytr.event``) -> (catégorie, type) du relevé Trade Republic.
EVENT_TYPE_MAP = {
    "BUY": ("TRADING", "BUY"),
    "SELL": ("TRADING", "SELL"),
    "DIVIDEND": ("CASH", "DIVIDEND"),
    "INTEREST": ("CASH", "INTEREST_PAYMENT"),
    "DEPOSIT": ("CASH", "TRANSFER_INBOUND"),
    "TRANSFER_IN": ("CASH", "TRANSFER_INBOUND"),
    "REMOVAL": ("CASH", "TRANSFER_OUTBOUND"),
    "TRANSFER_OUT": ("CASH", "TRANSFER_OUTBOUND"),
    "SPLIT": ("CORPORATE_ACTION", "SPLIT"),
    "TAXES": ("CASH", "TAXES"),
    "TAX_REFUND": ("CASH", "TAX_REFUND"),
    "FEES": ("CASH", "FEES"),
}


async def _timeline_items(tr: Any, since: str | None) -> list[dict]:
    items: list[dict] = []
    cursor = None
    while len(items) < MAX_TIMELINE_ITEMS:
        response = _as_dict(await _fetch_one(tr, tr.timeline_transactions(cursor)))
        batch = [_as_dict(item) for item in response.get("items") or []]
        if not batch:
            break
        items.extend(batch)
        if since and any((item.get("timestamp") or "")[:10] < since for item in batch):
            break
        cursor = _as_dict(response.get("cursors")).get("after")
        if not cursor:
            break
    if since:
        items = [item for item in items if (item.get("timestamp") or "")[:10] >= since]
    return items[:MAX_TIMELINE_ITEMS]


def _event_type_name(event: Any, value: float | None) -> str | None:
    kind = getattr(event, "event_type", None)
    if kind is None:
        return None
    name = getattr(kind, "name", str(kind))
    # Types « conditionnels » de pytr : achat/vente selon le sens du montant.
    if name in ("TRADE_INVOICE", "PRIVATE_MARKETS_ORDER"):
        return "SELL" if (value or 0) > 0 else "BUY"
    if name == "SAVEBACK":
        return "BUY"
    return name


def _movement_from_event(item: dict) -> dict | None:
    from pytr.event import Event

    try:
        event = Event.from_dict(item)
    except Exception:  # noqa: BLE001 - un événement illisible ne bloque pas le lot
        return None
    value = _to_float(getattr(event, "value", None))
    type_name = _event_type_name(event, value)
    if type_name is None or value is None:
        return None
    category, tr_type = EVENT_TYPE_MAP.get(type_name, ("CASH", type_name))
    shares = _to_float(getattr(event, "shares", None))
    price = abs(value) / shares if shares else None
    return {
        "id": str(item.get("id") or "") or None,
        "date": _iso_date(item.get("timestamp")) or date.today().isoformat(),
        "category": category,
        "type": tr_type,
        "description": " — ".join(part for part in (item.get("title"), item.get("subtitle")) if part)
        or "Mouvement Trade Republic",
        "name": item.get("title"),
        "isin": getattr(event, "isin", None),
        "quantity": shares,
        "price": price,
        "amount": value,
        "currency": _as_dict(item.get("amount")).get("currency") or "EUR",
        "fees": abs(_to_float(getattr(event, "fees", None)) or 0.0),
        "taxes": abs(_to_float(getattr(event, "taxes", None)) or 0.0),
    }


def _fetch_movements(tr: Any, since: str | None) -> list[dict]:
    async def gather() -> list[dict]:
        items = await _timeline_items(tr, since)
        details: dict = {}
        ids = [item["id"] for item in items if item.get("id")]
        for start in range(0, len(ids), 25):
            chunk = ids[start : start + 25]
            details.update(await _fetch_many(tr, {item_id: tr.timeline_detail_v2(item_id) for item_id in chunk}))
        movements: list[dict] = []
        for item in items:
            if item.get("id") in details:
                item = {**item, "details": details[item["id"]]}
            movement = _movement_from_event(item)
            if movement:
                movements.append(movement)
        return movements

    return _run(gather())


# -------------------------------------------------------------------- opérations


def operation_test(_tr: Any, _params: dict) -> dict:
    return {"library": "pytr", "readOnly": True}


def operation_portfolio(tr: Any, _params: dict) -> dict:
    async def gather() -> tuple[list[dict], list[str], Any]:
        # Une seule boucle d'événements pour toutes les lectures d'une opération.
        positions, warnings = await _portfolio_positions(tr)
        cash = await _fetch_one(tr, tr.cash())
        return positions, warnings, cash

    positions, warnings, cash = _run(gather())
    accounts = [
        {
            "id": "securities",
            "name": "Portefeuille Trade Republic",
            "currency": "EUR",
            "type": "SECURITIES",
            "balance": None,
        },
        {
            "id": "cash",
            "name": "Compte espèces Trade Republic",
            "currency": "EUR",
            "type": "CASH",
            "balance": _cash_total(cash),
        },
    ]
    return {"accounts": accounts, "positions": positions, "_warnings": warnings}


def operation_cash(tr: Any, _params: dict) -> dict:
    cash_value = _cash_total(_run(_fetch_one(tr, tr.cash())))
    return {
        "balances": [
            {
                "accountId": "cash",
                "date": date.today().isoformat(),
                "cash": cash_value if cash_value is not None else 0.0,
                "currency": "EUR",
            }
        ]
    }


def operation_positions(tr: Any, _params: dict) -> dict:
    positions, warnings = _run(_portfolio_positions(tr))
    return {"positions": positions, "_warnings": warnings}


def operation_transactions(tr: Any, params: dict) -> dict:
    movements = _fetch_movements(tr, _iso_date(params.get("since")))
    return {"transactions": movements, "cursor": None}


def operation_income(tr: Any, params: dict) -> dict:
    movements = _fetch_movements(tr, _iso_date(params.get("since")))
    income_types = {"DIVIDEND": "DIVIDEND", "INTEREST_PAYMENT": "INTEREST"}
    income = [
        {
            "accountId": "cash",
            "id": movement["id"],
            "date": movement["date"],
            "type": income_types[movement["type"]],
            "description": movement["description"],
            "amount": movement["amount"],
            "currency": movement["currency"],
            "withholdingTax": movement["taxes"],
        }
        for movement in movements
        if movement.get("type") in income_types
    ]
    return {"income": income}


def operation_savingsplans(tr: Any, _params: dict) -> dict:
    response = _as_dict(_run(_fetch_one(tr, tr.savings_plan_overview())))
    plans = []
    for plan in response.get("savingsPlans", []) or []:
        plan = _as_dict(plan)
        isin = _first(plan, "instrumentId", "isin")
        plans.append(
            {
                "id": str(_first(plan, "id") or "") or None,
                "isin": isin,
                "name": _first(plan, "name") or isin,
                "amount": _to_float(_first(plan, "amount")) or 0.0,
                "interval": _first(plan, "interval"),
                "currency": _first(plan, "currency") or "EUR",
                "active": not bool(_first(plan, "paused")),
            }
        )
    return {"savingsPlans": plans}


HANDLERS: dict[str, Callable[[Any, dict], dict]] = {
    "test": operation_test,
    "portfolio": operation_portfolio,
    "cash": operation_cash,
    "positions": operation_positions,
    "transactions": operation_transactions,
    "income": operation_income,
    "savingsplans": operation_savingsplans,
}


def handle(operation: str, params: dict, secrets: dict) -> dict:
    if operation not in READ_ONLY_OPERATIONS:
        return _fail(
            "NOT_SUPPORTED",
            f"Opération Trade Republic inconnue : « {operation} ». "
            f"Opérations disponibles : {', '.join(READ_ONLY_OPERATIONS)}.",
        )
    try:
        tr = _open_api(secrets, params)
        data = HANDLERS[operation](tr, params)
        warnings = data.pop("_warnings", []) if isinstance(data, dict) else []
        return {"ok": True, "data": data, "warnings": warnings}
    except SidecarError as exc:
        return _fail(exc.code, exc.message, exc.requires_user_action)
    except Exception as exc:  # noqa: BLE001 - dernier filet
        classified = _classify_exception(exc) if not isinstance(exc, SidecarError) else exc
        return _fail(classified.code, classified.message, classified.requires_user_action)


def main() -> None:
    raw = sys.stdin.read()
    try:
        request = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        sys.stdout.write(json.dumps(_fail("DATA", "Requête JSON illisible sur stdin.")))
        return
    operation = str(request.get("operation") or "")
    params = request.get("params") or {}
    secrets = request.get("secrets") or {}
    if not isinstance(params, dict):
        params = {}
    if not isinstance(secrets, dict):
        secrets = {}
    result = handle(operation, params, secrets)
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
