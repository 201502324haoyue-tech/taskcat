"""后端本地配置回归，不监听端口、不访问生产数据。"""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class ServerConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / '.tools')
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / 'new-data'
        self.env = patch.dict(os.environ, {
            'TASKCAT_DATA_DIR': str(self.data), 'TASKCAT_FEISHU_APP_ID': ''})
        self.env.start()
        self.addCleanup(self.env.stop)
        spec = importlib.util.spec_from_file_location('taskcat_server', ROOT / 'scripts/taskcat-server.py')
        self.server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.server)

    def test_first_start_persists_secret_before_database_init(self):
        self.assertEqual(Path(self.server.BASE_DIR), self.data)
        self.assertTrue(Path(self.server.JWT_SECRET_FILE).is_file())
        self.assertEqual(self.server._load_jwt_secret(), self.server.JWT_SECRET)
        self.server.init_db()
        self.assertTrue(Path(self.server.DB_FILE).is_file())

    def test_existing_secret_survives_restart(self):
        self.assertEqual(self.server._load_jwt_secret(), self.server._load_jwt_secret())

    def test_unconfigured_event_routes_are_disabled(self):
        with patch.object(self.server, '_json_resp') as response:
            self.server._handle_feishu_event(object())
            self.assertEqual(response.call_args.args[1], 503)
            self.server._handle_feishu_events(object(), {})
            self.assertEqual(response.call_args.args[1], 503)


if __name__ == '__main__':
    unittest.main()
