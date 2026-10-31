"""No hardware or production configuration is touched by these tests."""
import asyncio
import copy
import json
import unittest
from unittest.mock import patch, MagicMock

import zmq
from fastapi import FastAPI, HTTPException
from pydantic import ValidationError

from webapp.backend.auth import require_auth
from webapp.backend.routers import schedule, sdr_runtime


async def request(app, method, path, payload):
    body = json.dumps(payload).encode()
    sent = []
    async def receive():
        return {'type': 'http.request', 'body': body, 'more_body': False}
    async def send(message):
        sent.append(message)
    await app({'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
               'method': method, 'scheme': 'http', 'path': path, 'raw_path': path.encode(),
               'query_string': b'', 'root_path': '', 'headers': [(b'content-type', b'application/json')],
               'server': ('test', 80), 'client': ('test', 1000)}, receive, send)
    return next(m['status'] for m in sent if m['type'] == 'http.response.start')


class IntegrationContracts(unittest.TestCase):
    def test_routes_require_real_authentication(self):
        app = FastAPI()
        app.include_router(schedule.router)
        app.include_router(sdr_runtime.router)
        for method, path, body in [('PATCH','/api/schedule/once/a',{'enabled':False}),
                                   ('POST','/api/sdr/runtime',{'rf_gain_db':10})]:
            self.assertEqual(asyncio.run(request(app,method,path,body)),401)

    def test_toggle_preserves_identity_and_fired_state(self):
        original = {'once':[{'id':'a','command':'STATUS','fire_at':'2026-10-28T10:00:00Z','enabled':True,'fired':True}], 'recurring':[]}
        data=copy.deepcopy(original)
        with patch.object(schedule.headless_config,'read_schedule',return_value=data), patch.object(schedule.headless_config,'write_schedule') as write:
            row=schedule.update_entry('once','a',schedule.SchedulePatch(enabled=False))
            self.assertEqual(row,{**original['once'][0],'enabled':False})
            write.assert_called_once_with(data)

    def test_missing_schedule_does_not_write(self):
        with patch.object(schedule.headless_config,'read_schedule',return_value={'once':[]}), patch.object(schedule.headless_config,'write_schedule') as write:
            with self.assertRaises(HTTPException) as caught:
                schedule.update_entry('once','missing',schedule.SchedulePatch(enabled=False))
            self.assertEqual(caught.exception.status_code,404)
            write.assert_not_called()

    def test_invalid_window_rejected(self):
        row={'id':'a','command':'STATUS','window_start':'2026-10-28T10:00:00Z','window_end':'2026-10-28T11:00:00Z','interval_s':60,'enabled':False}
        with patch.object(schedule.headless_config,'read_schedule',return_value={'recurring':[row]}), patch.object(schedule.headless_config,'write_schedule') as write:
            with self.assertRaises(HTTPException):
                schedule.update_entry('recurring','a',schedule.SchedulePatch(window_end='2026-10-28T09:00:00Z'))
            write.assert_not_called()

    def test_runtime_rejects_unsafe_or_unimplemented_fields(self):
        for body in ({}, {'fft_size':2048}, {'rf_gain_db':float('nan')}, {'modulation_type':'GFSK'}, {'packet_length':256}, {'sync_word':[1,2,3,999]}):
            with self.assertRaises(ValidationError):
                sdr_runtime.RuntimeUpdate(**body)
        self.assertEqual(sdr_runtime.RuntimeUpdate(modulation_type='2GFSK').modulation_type,'2GFSK')

    def test_frequency_uses_hardware_tuning_command_and_ack_is_not_readback(self):
        socket=MagicMock();socket.recv_json.return_value={'status':'ok'}
        with patch.object(sdr_runtime.zmq.Context,'instance') as context:
            context.return_value.socket.return_value=socket
            response=sdr_runtime.send_receive_config({'center_freq_hz':437500000})
        socket.send_json.assert_called_once_with({'cmd':'SET_FREQ','value':437500000})
        self.assertEqual(response['status'],'acknowledged')
        self.assertFalse(response['hardware_verified'])
        socket.close.assert_called_once_with(0)

    def test_timeout_and_rejection_are_not_success(self):
        for reply in ('timeout', {'status':'error'}):
            socket=MagicMock()
            if reply=='timeout':socket.recv_json.side_effect=zmq.Again()
            else:socket.recv_json.return_value=reply
            with patch.object(sdr_runtime.zmq.Context,'instance') as context:
                context.return_value.socket.return_value=socket
                with self.assertRaises(HTTPException) as caught:
                    sdr_runtime.send_receive_config({'rf_gain_db':10})
            self.assertEqual(caught.exception.status_code,504 if reply=='timeout' else 502)
            socket.close.assert_called_once_with(0)

    def test_authenticated_toggle_route(self):
        app=FastAPI();app.include_router(schedule.router)
        app.dependency_overrides[require_auth]=lambda:None
        data={'once':[{'id':'a','command':'STATUS','enabled':True,'fired':False,'fire_at':'2026-10-28T10:00:00Z'}]}
        with patch.object(schedule.headless_config,'read_schedule',return_value=data),patch.object(schedule.headless_config,'write_schedule') as write:
            status=asyncio.run(request(app,'PATCH','/api/schedule/once/a',{'enabled':False}))
        self.assertEqual(status,200);write.assert_called_once();self.assertFalse(data['once'][0]['enabled'])


if __name__=='__main__':
    unittest.main()
