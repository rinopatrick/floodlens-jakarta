import http.client
import threading
from contextlib import contextmanager

import server


@contextmanager
def running_server():
    httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd.server_address[1]
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2)


def get(port, path):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    connection.request("GET", path)
    response = connection.getresponse()
    body = response.read()
    connection.close()
    return response, body


def test_public_index_is_served():
    with running_server() as port:
        response, body = get(port, "/")

    assert response.status == 200
    assert b"FloodLens" in body


def test_repository_files_are_not_served():
    paths = ["/server.py", "/README.md", "/requirements-dev.txt", "/.git/config"]

    with running_server() as port:
        responses = [(path, *get(port, path)) for path in paths]

    for path, response, _body in responses:
        assert response.status == 404, path


def test_encoded_traversal_is_rejected():
    with running_server() as port:
        response, _body = get(port, "/%2e%2e/server.py")

    assert response.status == 404
