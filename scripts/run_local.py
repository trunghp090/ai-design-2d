"""Run the complete local app on loopback, preserving the usual scheduler."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

class LocalServer(server.ThreadingHTTPServer):
    def __init__(self, address, handler):
        super().__init__(("127.0.0.1", address[1]), handler)

if __name__ == '__main__':
    server.ThreadingHTTPServer = LocalServer
    server.main()
