"""Confirmación humana de calibración; el PLC aplica en reposo y conserva evidencia."""
from datetime import datetime, timezone
import json
import re
from threading import Event, Lock, Thread
from urllib.request import Request, urlopen


def validate_command(value: object, fingerprint: str) -> dict | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError('confirmación OCIO inválida')
    identifier, revision = value.get('confirmationId'), value.get('revision')
    if not isinstance(identifier,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9:._-]{0,159}',identifier):
        raise ValueError('identificador de calibración inválido')
    if type(revision) is not int or revision < 1 or value.get('fingerprint') != fingerprint:
        raise ValueError('configuración de calibración no coincide con el PLC')
    at = datetime.fromisoformat(str(value.get('calibratedAt')).replace('Z','+00:00'))
    if at.tzinfo is None or at.timestamp() <= 0 or (at-datetime.now(timezone.utc)).total_seconds() > 300:
        raise ValueError('fecha de calibración inválida')
    return {'confirmationId':identifier,'revision':revision,'fingerprint':fingerprint,'calibratedAt':at.isoformat()}


class OcioCalibrationCoordinator:
    def __init__(self, config, sensor_key, *, site_id, session_id, reader, on_error=None):
        self.config, self.sensor_key = config, sensor_key
        self.site_id, self.session_id, self.reader = site_id, session_id, reader
        self.on_error = on_error
        self._stop, self._lock = Event(), Lock()
        self._thread = None
        self._pending = None

    def start(self):
        self._thread = Thread(target=self._run,name='fuel-ocio-calibration',daemon=True)
        self._thread.start()

    def close(self):
        self._stop.set()
        if self._thread:
            self._thread.join(5)
            if self._thread.is_alive():
                raise RuntimeError('sincronización OCIO no se detuvo')

    def refresh(self):
        body = {'siteId':self.site_id,'fingerprint':self.reader.signal_calibration_id,
                'pending':self.reader.ocio_calibration_pending,'telemetrySessionId':self.session_id}
        request = Request(self.config.base_url+'/api/system-settings/ocio-calibration/current',
            data=json.dumps(body).encode(),method='POST',headers={
                'Content-Type':'application/json','X-Edge-Sensor-Key':self.sensor_key})
        with urlopen(request,timeout=self.config.request_timeout_seconds) as response:
            decoded = json.loads(response.read(8193))
        if not isinstance(decoded,dict):
            raise ValueError('respuesta de calibración inválida')
        command = validate_command(decoded.get('command'), self.reader.signal_calibration_id)
        with self._lock:
            self._pending = command

    def apply_if_idle(self, store, *, idle: bool) -> bool:
        with self._lock:
            command = self._pending
        if not idle or not command:
            return False
        if command['fingerprint'] != self.reader.signal_calibration_id:
            raise ValueError('el escalado cambió durante la confirmación')
        certificate, changed = store.apply_ocio_calibration(self.site_id,command)
        self.reader.confirm_calibration(certificate['confirmationId'])
        with self._lock:
            if self._pending == command:
                self._pending = None
        return changed

    def _run(self):
        while not self._stop.is_set():
            try:
                self.refresh()
            except (OSError,ValueError,TypeError) as error:
                if self.on_error:
                    self.on_error(error)
            self._stop.wait(5)


def restore_calibration(store, site_id, reader):
    certificate = store.ocio_calibration(site_id)
    if certificate:
        if certificate['fingerprint'] == reader.signal_calibration_id:
            reader.confirm_calibration(certificate['confirmationId'])
        else:
            reader.ocio_calibration_pending = True
