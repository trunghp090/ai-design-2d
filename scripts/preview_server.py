"""Loopback UI preview with roundup APIs. Other production APIs and scheduler are off.
Generation/job/result routes retain server.py authentication and tab permission checks.
Use server.py for the full application, login, and normal administration.
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server
import roundup
import studio_assistant
class Preview(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=server.PUBLIC,**kwargs)
    json=server.Handler.json
    current_user=server.Handler.current_user
    get_cookie=server.Handler.get_cookie
    def do_GET(self):
        path=self.path.split('?',1)[0]
        if studio_assistant.route(server,self,path):return
        if roundup.route(server,self,path):return
        if path.startswith('/api/'):return self.json(404,{'error':'Bản xem giao diện. Chạy server.py để dùng các API khác.'})
        return super().do_GET()
    def do_POST(self):
        import json
        path=self.path.split('?',1)[0]
        if not path.startswith(('/api/roundup/','/api/studio-assistant/')):return self.json(404,{'error':'Chạy server.py để dùng chức năng này.'})
        try:
            n=int(self.headers.get('Content-Length','0'))
            if n<0 or n>17000000:return self.json(413,{'error':'Yêu cầu quá lớn.'})
            body=json.loads(self.rfile.read(n))
        except Exception:return self.json(400,{'error':'JSON không hợp lệ.'})
        if not studio_assistant.route(server,self,path,body):roundup.route(server,self,path,body)
if __name__=='__main__':
    port=int(sys.argv[1]) if len(sys.argv)>1 else 8766
    print('UI + secured roundup APIs: http://127.0.0.1:%d (scheduler off)'%port,flush=True)
    ThreadingHTTPServer(('127.0.0.1',port),Preview).serve_forever()
