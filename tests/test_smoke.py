from server import PORT, overpass_query


def test_server_module_imports():
    assert PORT == 8766
    assert "out:json" in overpass_query()
