"""Execução de uma operação entregue: validar, persistir, revalidar, aplicar, verificar e relatar.
Regra central: se o efeito pode ter ocorrido, CONSULTAR antes de repetir (ADR-014).

O fluxo é o mesmo para qualquer tipo de recurso; o que muda por família (conta PPPoE, ONU) é como ler o estado,
como decidir se a intenção já está aplicada e quais etapas executar."""
import time
import json
import logging
from datetime import datetime, timezone
from typing import Callable, Optional

from .drivers.base import AccountState, AckLost, Driver
from .drivers.olt_base import OnuState
from .envelope import Envelope, EnvelopeError, verify_envelope
from .store import Store

log = logging.getLogger("nexo.executor")


SESSION_SETTLE_TRIES, SESSION_SETTLE_S = 3, 1.0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ------------------------------------------------------------------ família: conta PPPoE

def observation(st: AccountState) -> dict:
    return {"policy": st.policy if st.exists else "absent", "profile": st.profile, "session": st.session, "at": _now()}


def block_profile(p) -> Optional[str]:
    """Perfil de bloqueio quando a suspensão é por perfil; None na suspensão por rejeição e na conta ativa."""
    return p.suspension.profile if p.policy == "suspended" and p.suspension and p.suspension.mode == "profile" else None


def effective_profile(p) -> str:
    """Perfil que o RADIUS deve entregar: o do plano, ou o de bloqueio durante a suspensão por perfil."""
    return block_profile(p) or p.profile


def expected_attrs(p) -> dict:
    """Atributos opcionais que devem estar gravados. Suspensa por perfil, velocidade e pool são os do perfil de bloqueio."""
    blocked = block_profile(p) is not None
    out = {"rate_limit": None if blocked else p.rate_limit, "address_pool": None if blocked else p.address_pool,
           "simultaneous_use": p.simultaneous_use, "acct_interim": p.acct_interim,
           "delegated_ipv6_prefix": p.delegated_ipv6_prefix if p.policy == "active" and not blocked else None}
    return {k: v for k, v in out.items() if v is not None}


def authorization_matches(st: AccountState, env: Envelope) -> bool:
    p = env.parameters
    return (st.exists and st.applied_version == env.desired_version and st.policy == p.policy and st.profile == effective_profile(p)
            and st.framed_ip == p.framed_ip and st.mac == p.mac and st.attrs == expected_attrs(p))


def needs_disconnect(st: AccountState, env: Envelope) -> bool:
    """Sessão existente precisa ser tratada? Suspensão: derrubar. Liberação: derrubar só se o perfil da sessão ficou diferente."""
    if not st.session:
        return False
    p = env.parameters
    if p.reconnect:
        # desconexão pedida: só a sessão que já existia antes desta operação cai; a que reconectou depois é o resultado esperado
        return bool(st.session.get("predates_authorization"))
    if p.policy == "suspended":
        if not (p.suspension and p.suspension.session == "disconnect"):
            return False
        bp = block_profile(p)
        # por perfil: a sessão só precisa cair se ainda usa o perfil de antes; reconectada no perfil de bloqueio, é o estado desejado
        return st.session.get("profile") not in (None, bp) if bp else True
    if p.framed_ip and st.session.get("ip") not in (None, p.framed_ip):
        return True   # IP fixo novo só vale na próxima conexão: a sessão atual ainda usa o endereço antigo
    return st.session.get("profile") not in (None, p.profile)


def session_unknown(st: AccountState) -> bool:
    """O NAS não respondeu: não se sabe se existe sessão, nem com que perfil/endereço. Diferente de "não há sessão"."""
    return bool(st.session and st.session.get("unknown"))


def fully_applied(st: AccountState, env: Envelope) -> bool:
    """Autorização local na versão pedida E nenhuma sessão conhecida (ou possível) ainda com o que valia antes."""
    return authorization_matches(st, env) and not session_unknown(st) and not needs_disconnect(st, env)


class PppoeFamily:
    result_key = "observed"

    @staticmethod
    def read(driver: Driver, env: Envelope) -> AccountState:
        return driver.read(env.parameters.username)

    applied = staticmethod(fully_applied)
    payload = staticmethod(observation)

    @staticmethod
    def remember(store: Store, env: Envelope):
        store.upsert_resource(env.resource_id, env.device_id, env.parameters.username)

    @staticmethod
    def execute(driver: Driver, env: Envelope, go: dict, step, checkpoint) -> bool:
        """Aplica as etapas e devolve True se a leitura final confirma a intenção."""
        p = env.parameters
        st = driver.read(p.username)
        fresh = not st.exists   # conta que não existia antes desta operação não pode ter sessão com configuração antiga
        if authorization_matches(st, env):
            step("autorização local", "ok", "já aplicada nesta versão")
        else:
            try:
                step("autorização local", "ok", driver.apply_authorization(p.username, secret=go.get("secret"), profile=p.profile, policy=p.policy, version=env.desired_version, framed_ip=p.framed_ip,
                                                                       block_profile=block_profile(p), mac=p.mac, extra=expected_attrs(p)))
            except AckLost as e:
                step("autorização local", "incerto", f"{e}; será verificado por consulta")
        checkpoint("EXECUTING")

        st = driver.read(p.username)
        dropped = needs_disconnect(st, env)
        if dropped:
            try:
                step("tratamento da sessão", "ok", driver.disconnect(p.username))
            except AckLost as e:
                step("tratamento da sessão", "incerto", str(e))
        else:
            step("tratamento da sessão", "ok", "nenhuma sessão a tratar")

        checkpoint("VERIFYING")
        st = driver.read(p.username)
        for _ in range(SESSION_SETTLE_TRIES if dropped else 0):   # o NAS pode levar um instante para tirar a sessão da lista
            if not needs_disconnect(st, env):
                break
            time.sleep(SESSION_SETTLE_S)
            st = driver.read(p.username)
        # Mesmo critério para suspender e para liberar/trocar plano: a sessão em uso também precisa refletir a intenção.
        # Sem resposta do NAS a sessão é desconhecida e a operação não é dada como concluída (exceto conta recém-criada).
        unknown = session_unknown(st)
        ok = authorization_matches(st, env) and not needs_disconnect(st, env) and (fresh or not unknown)
        step("verificação", "ok" if ok else "falha", {"policy": st.policy, "profile": st.profile, "applied_version": st.applied_version,
                                                          "session": "desconhecida (NAS sem resposta)" if unknown else "online" if st.session else "sem sessão",
                                                          **({"framed_ip": st.framed_ip} if st.framed_ip or p.framed_ip else {})})
        return ok


# ------------------------------------------------------------------ família: ONU (expansão OLT/ONU)

def onu_observation(st: OnuState) -> dict:
    return {"state": "authorized" if st.authorized else "absent", "online": st.online, "rx_dbm": st.rx_dbm, "tx_dbm": st.tx_dbm,
            "detail": {"pon_port": st.pon_port, "line_profile": st.line_profile, "service_vlan": st.service_vlan, **st.extra}, "at": _now()}


def onu_applied(st: OnuState, env: Envelope) -> bool:
    p = env.parameters
    if p.state == "removed":
        return not st.authorized
    return (st.authorized and st.description == p.description and st.applied_version == env.desired_version and st.pon_port == p.pon_port
            and st.line_profile == p.line_profile and st.service_vlan == p.service_vlan
            and (p.service_profile is None or st.service_profile == p.service_profile))


class OnuFamily:
    result_key = "onu_observed"

    @staticmethod
    def read(driver, env: Envelope) -> OnuState:
        return driver.read_onu(env.parameters.serial)

    applied = staticmethod(onu_applied)
    payload = staticmethod(onu_observation)

    @staticmethod
    def remember(store: Store, env: Envelope):
        store.upsert_onu(env.resource_id, env.device_id, env.parameters.serial)

    @staticmethod
    def execute(driver, env: Envelope, go: dict, step, checkpoint) -> bool:
        p = env.parameters
        st = driver.read_onu(p.serial)
        if st.authorized and (not st.description or st.description.rsplit(":v", 1)[0] != p.description.rsplit(":v", 1)[0]):
            raise ValueError("ONU existente não pertence a este recurso; adoção/remoção automática recusada")
        uncertain = False
        if onu_applied(st, env):
            step("configuração na OLT", "ok", "já aplicada nesta versão")
        else:
            try:
                if p.state == "authorized":
                    if st.authorized:  # autorizada com outra configuração/versão: remove antes de recriar
                        step("remoção da configuração anterior", "ok", driver.deauthorize(p.serial))
                    step("autorização da ONU", "ok", driver.authorize(p.serial, pon_port=p.pon_port, line_profile=p.line_profile,
                                                                     service_vlan=p.service_vlan, description=p.description, service_profile=p.service_profile))
                else:
                    step("desautorização da ONU", "ok", driver.deauthorize(p.serial))
            except AckLost as e:
                uncertain = True
                step("configuração na OLT", "incerto", f"{e}; será verificado por consulta")
        checkpoint("VERIFYING")
        st = driver.read_onu(p.serial)
        ok = onu_applied(st, env)
        if uncertain and not ok:
            raise AckLost("readback ainda não confirma o resultado; manter intenção desconhecida sem reenviar")
        step("verificação", "ok" if ok else "falha", {"authorized": st.authorized, "pon_port": st.pon_port, "line_profile": st.line_profile,
                                                       "service_vlan": st.service_vlan, "applied_version": st.applied_version, "online": st.online})
        return ok


def family_of(env: Envelope):
    return OnuFamily if env.action.startswith("onu.") else PppoeFamily


# ------------------------------------------------------------------ executor

class Executor:
    def __init__(self, store: Store, client, driver_for: Callable[[str], Optional[Driver]], identity: Callable[[], dict]):
        self.store, self.client, self.driver_for, self.identity = store, client, driver_for, identity

    # ---- envio de resultados (outbox local: sobrevive a perda de confirmação e reinício) ----
    def flush_outbox(self):
        for row in self.store.unreported():
            self.client.result(row["attempt_id"], json.loads(row["outcome"]))  # servidor é idempotente
            self.store.mark_reported(row["attempt_id"])

    def _finish(self, attempt_id: str, outcome: dict, steps: list):
        outcome = {**outcome, "steps": steps}
        self.store.finish(attempt_id, outcome, steps)  # durável primeiro
        try:
            self.client.result(attempt_id, outcome)
            self.store.mark_reported(attempt_id)
        except Exception as e:  # fica na outbox; será reenviado
            log.warning("resultado de %s não confirmado pela nuvem (%s); reenvio posterior", attempt_id, e)

    # ---- recuperação após reinício: tentativas interrompidas com possível efeito ----
    def recover_interrupted(self):
        for row in self.store.interrupted():
            env = Envelope.model_validate(json.loads(row["envelope"]))
            driver = self.driver_for(env.device_id)
            if driver is None:
                continue
            fam = family_of(env)
            steps = json.loads(row["steps"]) + [{"name": "recuperação após reinício", "status": "info", "at": _now()}]
            try:
                st = fam.read(driver, env)
            except Exception:
                self.store.set_status(row["attempt_id"], "EXECUTING", steps)
                continue
            if fam.applied(st, env):
                steps.append({"name": "consulta do estado aplicado", "status": "ok", "at": _now(), "detail": "efeito confirmado sem repetir o comando"})
                self._finish(row["attempt_id"], {"outcome": "SUCCEEDED", "recovered": True, fam.result_key: fam.payload(st)}, steps)
            else:
                if fam is OnuFamily:
                    steps.append({"name": "consulta sem confirmação", "status": "incerto", "at": _now(), "detail": "ausência momentânea não autoriza repetir comando OLT"})
                    self.store.set_status(row["attempt_id"], "EXECUTING", steps)
                    continue
                steps.append({"name": "consulta do estado aplicado", "status": "ok", "at": _now(), "detail": "efeito não encontrado ou incompleto"})
                self._finish(row["attempt_id"], {"outcome": "NOT_APPLIED", "recovered": True, fam.result_key: fam.payload(st)}, steps)
        self.store.abandon_received()

    # ---- operação entregue pelo poll ----
    def handle(self, delivery: dict):
        attempt_id = delivery["attempt_id"]
        ident = self.identity()
        try:
            env = verify_envelope(delivery["envelope"], delivery["signature"], ident["public_key"], agent_id=ident["agent_id"],
                                  tenant_id=ident["tenant_id"], device_ids=ident["device_ids"])
        except EnvelopeError as e:
            log.error("envelope rejeitado: %s", e)
            self.client.result(attempt_id, {"outcome": "FAILED", "error": f"envelope rejeitado pelo agente: {e}", "steps": []})
            return

        prior = self.store.finished_outcome(env.operation_id)
        if prior:  # reentrega legítima: devolve a evidência já registrada
            self.client.result(attempt_id, {**prior, "recovered": True})
            return

        driver = self.driver_for(env.device_id)
        fam = family_of(env)
        if driver is None or (fam is OnuFamily) != hasattr(driver, "read_onu"):
            self.client.result(attempt_id, {"outcome": "FAILED", "error": "driver do equipamento indisponível ou incompatível com a operação", "steps": []})
            return

        had_effect = delivery.get("recover") or self.store.may_have_effect(env.operation_id)
        uncertain_onu = fam is OnuFamily and (delivery.get("recover") or self.store.unresolved_effect(env.operation_id))
        self.store.record_attempt(attempt_id, env, delivery["envelope"])  # se falhar aqui, nada é escrito no equipamento
        if fam is OnuFamily and self.store.unresolved_resource(env.resource_id, env.operation_id):
            self._finish(attempt_id, {"outcome": "FAILED", "error": "recurso OLT possui operação anterior com resultado desconhecido; resolver antes de nova mutação"}, [])
            return
        fam.remember(self.store, env)
        steps: list = []

        def step(name: str, status: str, detail=None):
            steps.append({"name": name, "status": status, "at": _now(), **({"detail": detail} if detail else {})})

        def checkpoint(status: str):
            self.store.set_status(attempt_id, status, steps)
            if status == "VERIFYING":
                try:
                    self.client.progress(attempt_id, "VERIFYING", steps)
                except Exception:
                    pass

        if had_effect:
            st = fam.read(driver, env)
            if fam.applied(st, env):
                step("consulta antes de repetir", "ok", "efeito já presente; comando não foi repetido")
                self._finish(attempt_id, {"outcome": "SUCCEEDED", "recovered": True, fam.result_key: fam.payload(st)}, steps)
                return
            step("consulta antes de repetir", "ok", "efeito ausente ou incompleto; revalidando intenção")
            if uncertain_onu:
                step("resultado OLT desconhecido", "incerto", "manter consulta; não reenviar mutação nem remover efeito parcial")
                self.store.set_status(attempt_id, "EXECUTING", steps)
                return

        go = self.client.begin(attempt_id)  # revalida intenção atual, prazo e precondições na nuvem
        if not go.get("go"):
            log.info("operação %s não iniciada: %s", env.operation_id, go.get("reason"))
            self.store.finish(attempt_id, None, steps)
            return

        self.store.set_status(attempt_id, "EXECUTING", steps)  # durável ANTES da primeira escrita
        try:
            ok = fam.execute(driver, env, go, step, checkpoint)
            st = fam.read(driver, env)
            if ok:
                self._finish(attempt_id, {"outcome": "SUCCEEDED", fam.result_key: fam.payload(st)}, steps)
            else:
                self._finish(attempt_id, {"outcome": "FAILED", "error": "leitura do estado aplicado não confirmou a mudança", fam.result_key: fam.payload(st)}, steps)
        except AckLost:
            step("resultado desconhecido", "incerto", "comando pode ter sido aplicado; aguardar readback sem reenviar")
            self.store.set_status(attempt_id, "EXECUTING", steps)
        except Exception as e:  # falha definida (ex.: sem conexão com o equipamento)
            log.exception("falha executando %s", env.operation_id)
            step("erro", "falha", str(e)[:300])
            try:
                st = fam.read(driver, env)
                outcome = {"outcome": "SUCCEEDED" if fam.applied(st, env) else "FAILED", "error": str(e)[:300], fam.result_key: fam.payload(st)}
            except Exception:
                outcome = None  # nem a consulta funcionou: permanece interrompida; a nuvem marcará UNCERTAIN e pedirá verificação
            if outcome:
                self._finish(attempt_id, outcome, steps)
            else:
                self.store.set_status(attempt_id, "EXECUTING", steps)
