import importlib.util
import json
from pathlib import Path
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import unittest

ROOT=Path(__file__).resolve().parents[2]
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/file)
    loaded=importlib.util.module_from_spec(spec);spec.loader.exec_module(loaded);return loaded

migration=module('migration','migration-check.py')
monitor=module('monitor','monitor.py')

class ToolTests(unittest.TestCase):
    def test_migration_balances_links_and_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source.csv'
            header='source,entity,external_id,parent_external_id,amount_cents,status\n'
            row='origem-ficticia,invoice,123,contrato-1,9990,open\n'
            source.write_text(header+row)
            records=migration.load(source)
            self.assertTrue(migration.compare(records,records)['ok'])
            # Equal totals alone cannot hide an invoice moved to another contract.
            other={key:('contrato-errado',9990,'open') for key in records}
            self.assertFalse(migration.compare(records,other)['ok'])
            self.assertEqual(migration.compare(records,{})['missing'],1)
            source.write_text(header+row+row)
            with self.assertRaises(ValueError):migration.load(source)
            source.write_text(header+row.replace('9990','99.90'))
            with self.assertRaises(ValueError):migration.load(source)

    def test_monitor_requires_health_and_complete_backup(self):
        class Health(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200);self.end_headers()
                self.wfile.write(b'{"ok":true,"db":"ok"}')
            def log_message(self,*args):pass
        server=HTTPServer(('127.0.0.1',0),Health)
        thread=threading.Thread(target=server.serve_forever);thread.start()
        try:
            url=f'http://127.0.0.1:{server.server_port}/api/health'
            with tempfile.TemporaryDirectory() as directory:
                self.assertFalse(monitor.check(url,2,directory)['ok'])
                dump=Path(directory)/'snapshot.dump';dump.write_bytes(b'ficticio')
                Path(str(dump)+'.sha256').write_text('checksum')
                self.assertFalse(monitor.check(url,2,directory)['ok'])
                Path(str(dump)+'.manifest.json').write_text('{}')
                self.assertTrue(monitor.check(url,2,directory,min_free=.001)['ok'])
            with self.assertRaises(ValueError):monitor.check('http://public.example/api/health',2)
            with self.assertRaises(ValueError):monitor.check('https://user:password@example.com/api/health',2)
        finally:
            server.shutdown();thread.join();server.server_close()

if __name__=='__main__':unittest.main()
