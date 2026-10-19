"""ACS sintético do laboratório v0: nenhuma conexão com roteador físico."""
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import parse_qs, unquote, urlparse
import json


def start(port):
    devices = {}
    tasks = []
    for model, serial in [('tr098', 'V0ACS098'), ('tr181', 'V0ACS181')]:
        value = lambda item: {'_value': item}
        info = {'ModelName': value('Roteador sintético ' + model), 'SoftwareVersion': value('0.0-validation'), 'UpTime': value(3600)}
        device = {'_id': serial, '_lastInform': datetime.now(timezone.utc).isoformat(), '_deviceId': {'_Manufacturer': 'Laboratório v0', '_SerialNumber': serial, '_ProductClass': model}}
        if model == 'tr098':
            device['InternetGatewayDevice'] = {'DeviceInfo': info, 'LANDevice': {'1': {'WLANConfiguration': {'1': {'SSID': value('WiFi sintético 098'), 'Enable': value(True), 'KeyPassphrase': value('original-sintetica')}}}}, 'WANDevice': {'1': {'WANConnectionDevice': {'1': {'WANPPPConnection': {'1': {'Username': value('acs-validation'), 'ExternalIPAddress': value('192.0.2.98'), 'ConnectionStatus': value('Connected')}}}}}}}
        else:
            device['Device'] = {'DeviceInfo': info, 'PPP': {'Interface': {'1': {'Username': value('acs-validation')}}}, 'WiFi': {'SSID': {'1': {'SSID': value('WiFi sintético 181'), 'Enable': value(True)}}, 'AccessPoint': {'1': {'Security': {'KeyPassphrase': value('original-sintetica')}}}}, 'IP': {'Interface': {'1': {'Status': value('Up'), 'IPv4Address': {'1': {'IPAddress': value('192.0.2.181')}}}}}}
        devices[serial] = device

    def at(obj, path):
        for key in path.split('.'):
            obj = obj.get(key) if isinstance(obj, dict) else None
        return obj

    def matches(device, query):
        if '$or' in query:
            return any(matches(device, item) for item in query['$or'])
        return all(at(device, key) == expected or at(device, key + '._value') == expected for key, expected in query.items())

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, data):
            raw = json.dumps(data).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path == '/_fixture/tasks':
                return self.reply(200, tasks)
            if parsed.path.rstrip('/') == '/devices':
                query = json.loads(parse_qs(parsed.query).get('query', ['{}'])[0])
                return self.reply(200, [device for device in devices.values() if matches(device, query)])
            if parsed.path.rstrip('/') == '/faults':
                return self.reply(200, [])
            return self.reply(404, {})

        def do_POST(self):
            parsed = urlparse(self.path)
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
            parts = parsed.path.split('/')
            if len(parts) != 4 or parts[1] != 'devices' or parts[3] != 'tasks':
                return self.reply(404, {})
            device = devices.get(unquote(parts[2]))
            if not device:
                return self.reply(404, {})
            tasks.append({'device': device['_id'], 'payload': body})
            # TR-181 deliberately queues; TR-098 applies synchronously.
            queued = device['_id'] == 'V0ACS181'
            if body.get('name') == 'setParameterValues' and not queued:
                for path, value, _ in body['parameterValues']:
                    obj = device
                    for key in path.split('.')[:-1]:
                        obj = obj.setdefault(key, {})
                    obj[path.split('.')[-1]] = {'_value': value}
            return self.reply(202 if queued else 200, {'_id': 'task-validation-' + str(len(tasks))})

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    Thread(target=server.serve_forever, daemon=True).start()
    return server
