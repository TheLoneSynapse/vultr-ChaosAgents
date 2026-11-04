import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

PAGE = open("/page.html", encoding="utf-8").read()
APP = "/app"

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/data.csv" and os.path.exists(os.path.join(APP, "data.csv")):
            self._serve_file(os.path.join(APP, "data.csv"), "text/csv; charset=utf-8")
            return
        self._serve_file("/page.html", "text/html; charset=utf-8")

    def _serve_file(self, filepath, content_type):
        try:
            data = open(filepath, "rb").read()
        except OSError:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        print(fmt % args, file=sys.stderr, flush=True)

if __name__ == "__main__":
    addr = ("0.0.0.0", 8080)
    print(f"docs listening on {addr[0]}:{addr[1]}", flush=True)
    HTTPServer(addr, Handler).serve_forever()
