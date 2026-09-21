#!/usr/bin/env python3
"""Sidecar DEGIRO — STRICTEMENT EN LECTURE SEULE.

Processus isolé : reçoit une requête JSON sur l'entrée standard et répond du JSON
sur la sortie standard (protocole décrit dans ``docs/connectors/sidecars.md``).

    requête : {"operation": "...", "params": {...}, "secrets": {...}, "timeoutMs": 1234}
    succès  : {"ok": true, "data": {...}, "warnings": [...]}
    échec   : {"ok": false, "code": "...", "message": "...", "requiresUserAction": bool}

Opérations exposées : ``test``, ``accounts``, ``balances``, ``positions``,
``transactions``, ``income``.

GARANTIES
---------
* **Aucune action d'ordre.** ``degiro-connector`` expose ``ActionConfirmOrder`` /
  ``ActionUpdateOrder`` / ``ActionDeleteOrder`` : elles ne sont JAMAIS chargées.
  Le client est instancié avec ``preload=False`` (donc sans ``setup_all_actions()``)
  et seules les méthodes dont le nom figure dans ``READ_ONLY_ACTIONS`` sont
  appelées. Toute autre méthode est refusée avant exécution.
* **Aucun secret sur disque.** Les identifiants arrivent dans la requête et ne sont
  conservés qu'en mémoire, le temps de l'appel. Aucun fichier de session/serveur
  n'est écrit (contrairement à ``pytr``) : DEGIRO réauthentifie à chaque appel.
* La bibliothèque est optionnelle : sans elle, le script reste importable et
  répond ``NOT_SUPPORTED`` au lieu de planter.

⚠️ ``degiro-connector`` utilise une API privée non officielle : la forme des
réponses peut changer sans préavis et l'usage automatique relève des conditions
d'utilisation de DEGIRO (voir ``sidecar/README.md``).
"""

from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta
from typing import Any, Callable

SIDECAR_NAME = "degiro"
READ_ONLY_OPERATIONS = ("test", "accounts", "balances", "positions", "transactions", "income")

#: Liste blanche STRICTE des actions de ``degiro-connector`` autorisées.
#: Volontairement limitée aux lectures ; toute action d'ordre est absente.
READ_ONLY_ACTIONS = frozenset(
    {
        "get_account_info",
        "get_client_details",
        "get_account_overview",
        "get_update",
        "get_position_report",
        "get_account_report",
        "get_transactions_history",
        "get_orders_history",
        "get_products_info",
        "get_upcoming_payments",
        "get_config",
    }
)


class SidecarError(Exception):
    """Échec normalisé, traduit en réponse ``{ok: false, ...}``."""

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
    """Convertit un modèle pydantic / objet en dictionnaire, sans lever."""
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    for name in ("model_dump", "dict"):
        fn = getattr(obj, name, None)
        if callable(fn):
            try:
                return fn()
            except Exception:  # pragma: no cover - dépend de pydantic
                pass
    if hasattr(obj, "__dict__"):
        return {k: v for k, v in vars(obj).items() if not k.startswith("_")}
    return {}


def _as_list(value: Any) -> list:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        # ``portfolio`` est un mapping productId -> position : on ne garde que les
        # valeurs qui ressemblent à des positions (évite « lastUpdated », etc.).
        return [v for v in value.values() if isinstance(v, dict)]
    return []


def _iso_date(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.strftime("%Y-%m-%d")
    text = str(value).strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(text[: len(fmt.replace("%", "0"))], fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return text[:10]


def _to_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _first(d: dict, *names: str) -> Any:
    for name in names:
        if name in d and d[name] is not None:
            return d[name]
    return None


# ------------------------------------------------------------------------- login


def _load_library() -> tuple[Any, Any, Any, Any, Any]:
    """Importe ``degiro-connector`` (jamais au niveau module) ou lève NOT_SUPPORTED."""
    try:
        from degiro_connector.core.models.model_connection import ModelConnection
        from degiro_connector.trading.api import API
        from degiro_connector.trading.models.account import UpdateOption, UpdateRequest
        from degiro_connector.trading.models.credentials import Credentials
    except ImportError as exc:  # la bibliothèque n'est pas installée
        raise SidecarError(
            "NOT_SUPPORTED",
            "La bibliothèque Python « degiro-connector » n'est pas installée : "
            "installez-la avec `uv pip install degiro-connector` (voir sidecar/README.md). "
            f"Détail : {exc}",
        ) from exc
    return API, Credentials, UpdateOption, UpdateRequest, ModelConnection


def _build_credentials(credentials_cls: Any, secrets: dict, params: dict) -> Any:
    kwargs: dict[str, Any] = {}
    if secrets.get("username"):
        kwargs["username"] = secrets["username"]
    if secrets.get("password"):
        kwargs["password"] = secrets["password"]
    if secrets.get("totp_secret_key"):
        kwargs["totp_secret_key"] = secrets["totp_secret_key"]
    if secrets.get("one_time_password"):
        kwargs["one_time_password"] = secrets["one_time_password"]
    if secrets.get("in_app_token"):
        kwargs["in_app_token"] = secrets["in_app_token"]
    int_account = secrets.get("int_account") or params.get("intAccount")
    if int_account:
        try:
            kwargs["int_account"] = int(int_account)
        except (TypeError, ValueError):
            kwargs["int_account"] = int_account
    if not kwargs.get("username") or not kwargs.get("password"):
        # Sans identifiant, inutile d'appeler la bibliothèque : action requise.
        raise SidecarError(
            "AUTH_REQUIRED",
            "Identifiant et mot de passe DEGIRO requis : renseignez-les dans SuiviInvest "
            "(ils sont chiffrés en base et transmis ici sans être écrits sur disque).",
        )
    return credentials_cls(**kwargs)


def _classify_login_exception(exc: Exception) -> SidecarError:
    name = type(exc).__name__
    text = str(exc)
    lowered = text.lower()
    if name == "CaptchaRequiredError" or "captcha" in lowered:
        return SidecarError(
            "MFA_REQUIRED",
            "DEGIRO demande de résoudre un captcha dans le navigateur : connectez-vous une fois "
            "manuellement sur le site, puis relancez la synchronisation.",
            requires_user_action=True,
        )
    if name == "DeGiroConnectionError" or "degir" in lowered:
        # status 6 = TOTP requis, status 12 = approbation dans l'application.
        if "2fa" in lowered or "totp" in lowered:
            return SidecarError(
                "MFA_REQUIRED",
                "DEGIRO demande un code à deux facteurs : enregistrez la clé TOTP (ou validez "
                "dans l'application DEGIRO) puis relancez.",
                requires_user_action=True,
            )
        return SidecarError(
            "MFA_REQUIRED",
            "DEGIRO attend une validation dans l'application mobile : ouvrez l'application, "
            "approuvez la connexion, puis relancez la synchronisation.",
            requires_user_action=True,
        )
    if "429" in lowered or "too many" in lowered or "rate" in lowered:
        return SidecarError("RATE_LIMITED", "DEGIRO limite temporairement les accès (HTTP 429).")
    if "session" in lowered or "401" in lowered or "403" in lowered:
        return SidecarError("SESSION_EXPIRED", "Session DEGIRO invalide ou expirée : reconnectez-vous.")
    if any(token in lowered for token in ("connection", "timeout", "timed out", "ssl", "dns")):
        return SidecarError("PROVIDER_DOWN", "Service DEGIRO injoignable : réessayez plus tard.")
    return SidecarError("PROVIDER_BROKEN", f"Échec DEGIRO inattendu : {text[:300]}")


def _connect(secrets: dict, params: dict) -> Any:
    """Ouvre une session de lecture seule et renvoie l'instance ``API``."""
    API, credentials_cls, _update_option, _update_request, model_connection = _load_library()
    credentials = _build_credentials(credentials_cls, secrets, params)
    try:
        # preload=False : AUCUNE action n'est instanciée, à commencer par les ordres.
        api = API(credentials=credentials, preload=False, connection_storage=model_connection())
        connect_action = getattr(api, "connect")
        session_id = connect_action.get_session_id()
    except SidecarError:
        raise
    except Exception as exc:  # noqa: BLE001 - classement explicite juste après
        raise _classify_login_exception(exc) from exc
    if not session_id:
        raise SidecarError(
            "SESSION_EXPIRED",
            "DEGIRO n'a pas fourni de session : reconnectez-vous.",
        )
    return api


def _call(api: Any, action: str, **kwargs: Any) -> Any:
    """Appelle une action UNIQUEMENT si son nom figure dans la liste blanche."""
    if action not in READ_ONLY_ACTIONS:
        raise SidecarError(
            "NOT_SUPPORTED",
            f"Action DEGIRO « {action} » hors liste blanche en lecture seule : refusée.",
        )
    method: Callable[..., Any] = getattr(api, action)
    try:
        return method(**kwargs)
    except SidecarError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _classify_login_exception(exc) from exc


# ------------------------------------------------------------------ normalisation


def _client_and_accounts(api: Any) -> tuple[list[dict], dict, dict]:
    client = _as_dict(_call(api, "get_client_details"))
    info = _as_dict(_call(api, "get_account_info"))
    int_account = _first(client, "int_account", "intAccount") or _first(info, "int_account", "intAccount")
    currencies = _first(info, "currencies", "currency_list") or ["EUR"]
    if isinstance(currencies, dict):
        currencies = list(currencies.keys()) or ["EUR"]
    accounts = [
        {
            "id": str(int_account or "degiro"),
            "name": "Compte-titres DEGIRO",
            "currency": "EUR",
            "type": "SECURITIES",
            "balance": None,
        }
    ]
    for currency in currencies:
        code = str(currency)
        accounts.append(
            {
                "id": f"{int_account or 'degiro'}-cash-{code}",
                "name": f"Compte espèces {code}",
                "currency": code,
                "type": "CASH",
                "balance": None,
            }
        )
    return accounts, client, info


def _overview_cash_movements(api: Any, params: dict) -> list[dict]:
    from degiro_connector.trading.models.account import OverviewRequest  # local : optionnel

    to_date = date.today()
    since = _iso_date(params.get("since")) if params.get("since") else None
    from_date = date.fromisoformat(since) if since else to_date - timedelta(days=365)
    overview = _as_dict(_call(api, "get_account_overview", request=OverviewRequest(from_date=from_date, to_date=to_date)))
    inner = _as_dict(overview.get("data")) if "data" in overview else overview
    return [_as_dict(m) for m in _as_list(inner.get("cash_movements") or inner.get("cashMovements"))]


# -------------------------------------------------------------------- opérations


def operation_test(api: Any, _params: dict) -> dict:
    api  # session ouverte = test réussi
    return {"library": "degiro-connector", "readOnly": True}


def operation_accounts(api: Any, _params: dict) -> dict:
    accounts, _client, _info = _client_and_accounts(api)
    return {"accounts": accounts}


def operation_balances(api: Any, params: dict) -> dict:
    _accounts, client, _info = _client_and_accounts(api)
    int_account = _first(client, "int_account", "intAccount") or "degiro"
    movements = _overview_cash_movements(api, params)
    latest: dict[str, dict] = {}
    for movement in movements:
        currency = str(_first(movement, "currency") or "EUR")
        if currency not in latest:
            latest[currency] = movement
    balances = []
    for currency, movement in latest.items():
        balance = _first(movement, "balance", "change")
        cash = _to_float(balance.get("value") if isinstance(balance, dict) else balance)
        balances.append(
            {
                "accountId": f"{int_account}-cash-{currency}",
                "date": _iso_date(_first(movement, "value_date", "valueDate", "date")) or date.today().isoformat(),
                "cash": cash if cash is not None else 0.0,
                "currency": currency,
            }
        )
    return {"balances": balances}


def operation_positions(api: Any, _params: dict) -> dict:
    from degiro_connector.trading.models.account import UpdateOption, UpdateRequest  # local

    _accounts, client, _info = _client_and_accounts(api)
    int_account = str(_first(client, "int_account", "intAccount") or "degiro")
    update = _as_dict(
        _call(
            api,
            "get_update",
            request_list=[UpdateRequest(option=UpdateOption.TOTAL_PORTFOLIO)],
        )
    )
    rows = _as_list(update.get("total_portfolio") or update.get("totalPortfolio") or update.get("portfolio"))
    positions = []
    for row in rows:
        row = _as_dict(row)
        product_id = _first(row, "product_id", "productId", "id")
        positions.append(
            {
                "accountId": int_account,
                "productId": product_id,
                "isin": _first(row, "isin"),
                "symbol": _first(row, "symbol"),
                "name": str(_first(row, "name", "description") or product_id or "Titre DEGIRO"),
                "quantity": _to_float(_first(row, "size", "quantity")) or 0.0,
                "price": _to_float(_first(row, "price", "breakEvenPrice")),
                "currency": _first(row, "currency") or "EUR",
                "kind": _first(row, "productType", "kind"),
            }
        )
    return {"positions": positions}


def operation_transactions(api: Any, _params: dict) -> dict:
    from degiro_connector.trading.models.account import UpdateOption, UpdateRequest  # local

    _accounts, client, _info = _client_and_accounts(api)
    int_account = str(_first(client, "int_account", "intAccount") or "degiro")
    update = _as_dict(
        _call(api, "get_update", request_list=[UpdateRequest(option=UpdateOption.TRANSACTIONS)])
    )
    raw = update.get("transactions") or {}
    rows = [v for v in raw.values() if isinstance(v, dict)] if isinstance(raw, dict) else list(raw or [])
    transactions = []
    for row in rows:
        row = _as_dict(row)
        total = _to_float(_first(row, "total", "totalInBaseCurrency"))
        quantity = _to_float(_first(row, "quantity", "size"))
        price = _to_float(_first(row, "price"))
        transaction_type = str(_first(row, "transactionTypeId", "buysell", "type") or "")
        transactions.append(
            {
                "accountId": int_account,
                "id": str(_first(row, "id", "orderId") or "") or None,
                "date": _iso_date(_first(row, "date", "valueDate")) or date.today().isoformat(),
                "type": transaction_type,
                "description": str(_first(row, "description", "product") or transaction_type or "Opération DEGIRO"),
                "product": _first(row, "product"),
                "isin": _first(row, "isin", "productIsin"),
                "quantity": quantity,
                "price": price,
                "amount": total if total is not None else 0.0,
                "currency": _first(row, "currency") or "EUR",
                "fees": _to_float(_first(row, "feeInBaseCurrency", "fees")) or 0.0,
                "taxes": _to_float(_first(row, "taxes")) or 0.0,
            }
        )
    return {"transactions": transactions, "cursor": None}


def operation_income(api: Any, _params: dict) -> dict:
    _accounts, client, _info = _client_and_accounts(api)
    int_account = str(_first(client, "int_account", "intAccount") or "degiro")
    payments = _as_list(_call(api, "get_upcoming_payments"))
    income = []
    for payment in payments:
        payment = _as_dict(payment)
        income.append(
            {
                "accountId": f"{int_account}-cash-{_first(payment, 'currency') or 'EUR'}",
                "id": str(_first(payment, "ca_id", "caId") or "") or None,
                "date": _iso_date(_first(payment, "pay_date", "payDate")),
                "type": _first(payment, "type") or "DIVIDEND",
                "description": _first(payment, "description") or _first(payment, "product") or "Revenu DEGIRO",
                "amount": _to_float(_first(payment, "amount")) or 0.0,
                "currency": _first(payment, "currency") or "EUR",
                "withholdingTax": 0.0,
            }
        )
    return {"income": income}


HANDLERS: dict[str, Callable[[Any, dict], dict]] = {
    "test": operation_test,
    "accounts": operation_accounts,
    "balances": operation_balances,
    "positions": operation_positions,
    "transactions": operation_transactions,
    "income": operation_income,
}


def handle(operation: str, params: dict, secrets: dict) -> dict:
    if operation not in READ_ONLY_OPERATIONS:
        return _fail(
            "NOT_SUPPORTED",
            f"Opération DEGIRO inconnue : « {operation} ». "
            f"Opérations disponibles : {', '.join(READ_ONLY_OPERATIONS)}.",
        )
    try:
        api = _connect(secrets, params)
        data = HANDLERS[operation](api, params)
        return {"ok": True, "data": data}
    except SidecarError as exc:
        return _fail(exc.code, exc.message, exc.requires_user_action)
    except Exception as exc:  # noqa: BLE001 - dernier filet
        return _fail("PROVIDER_BROKEN", f"Échec DEGIRO inattendu : {type(exc).__name__}: {str(exc)[:300]}")


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
