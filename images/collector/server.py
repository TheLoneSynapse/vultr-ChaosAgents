import json
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._log("GET", self.path, None, self.headers)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8", "replace") if length else None
        self._log("POST", self.path, body, self.headers)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def _log(self, method, path, body, headers):
        rec = {
            "method": method,
            "path": path,
            "peer": self.client_address[0],
            "headers": {k: v for k, v in headers.items()},
            "body": body,
        }
        print(json.dumps(rec), flush=True)

if __name__ == "__main__":
    addr = ("0.0.0.0", 8080)
    print(f"collector listening on {addr[0]}:{addr[1]}", flush=True)
    HTTPServer(addr, Handler).serve_forever()
