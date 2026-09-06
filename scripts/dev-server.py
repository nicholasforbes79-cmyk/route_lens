"""Static dev server for Route Lens.

Identical to `python -m http.server` except that it forbids caching. With no
build step there is no content hashing, so a cached ES module will happily
outlive several edits and you will spend an evening debugging a bug you have
already fixed. Never use this to serve anything publicly.
"""

import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Keep the noise down; 404s still matter.
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8420
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)
    # Threading matters: a single-threaded server deadlocks as soon as the
    # browser holds a connection open, and the page's module imports hang
    # forever with no error to show for it.
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(("", port), NoCacheHandler) as httpd:
        print(f"Route Lens dev server: {root} on http://localhost:{port}", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
