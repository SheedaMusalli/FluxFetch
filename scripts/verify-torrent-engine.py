"""Real local-peer transfer test; no public torrent or tracker is contacted."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
import libtorrent as lt

root = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("fluxfetch_engine", root / "integrations/torrent-engine/engine.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

base = str(root.resolve())
assert module.content_location(base, []) == (None, base)
assert module.content_location(base, [{"path": "single.bin"}]) == (str(root / "single.bin"), base)
assert module.content_location(base, [{"path": "Game/data1.bin"}, {"path": "Game/data2.bin"}]) == (str(root / "Game"), str(root / "Game"))
try:
    module.content_location(base, [{"path": "../outside.bin"}])
except ValueError:
    pass
else:
    raise AssertionError("Escaping content path accepted")


def wait_for(predicate, description, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(.1)
    raise AssertionError(description)


with tempfile.TemporaryDirectory(prefix="fluxfetch-torrent-transfer-") as temporary:
    class Tracker(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(lt.bencode({"failure reason": "Fixture tracker unavailable"}))
        def log_message(self, *args):
            pass
    tracker = HTTPServer(("127.0.0.1", 0), Tracker)
    threading.Thread(target=tracker.serve_forever, daemon=True).start()
    directory = Path(temporary)
    source = directory / "seed"
    source.mkdir()
    payload = bytes(range(256)) * 8192
    (source / "fixture.bin").write_bytes(payload)
    storage = lt.file_storage()
    storage.add_file("fixture.bin", len(payload))
    metainfo = lt.create_torrent(storage, 16384)
    metainfo.add_tracker(f"http://127.0.0.1:{tracker.server_port}/announce")
    lt.set_piece_hashes(metainfo, str(source))
    encoded = lt.bencode(metainfo.generate())
    engine = module.TorrentEngine(directory / "session", offline=True)
    assert engine.session.get_settings()["connections_limit"] == 500
    assert engine.session.get_settings()["max_out_request_queue"] == 1024
    assert engine.session.get_settings()["announce_to_all_tiers"] is True
    assert engine.session.get_settings()["announce_to_all_trackers"] is True
    assert engine.session.get_settings()["prioritize_partial_pieces"] is False
    seeder = module.TorrentEngine(directory / "seed-session", offline=True)
    try:
        seed_id = seeder.dispatch("add", {"data": base64.b64encode(encoded).decode(), "destination": str(source)})
        wait_for(lambda: seeder.jobs[seed_id]["handle"].status().is_seeding, "seed did not hash existing data")
        destination = directory / "download"
        key = engine.dispatch("add", {"data": base64.b64encode(encoded).decode(), "destination": str(destination)})
        handle = engine.jobs[key]["handle"]
        handle.connect_peer(("127.0.0.1", seeder.session.listen_port()))

        def completed():
            engine.tick()
            seeder.tick()
            row = engine.dispatch("list", {})[0]
            return row if row["downloadedBytes"] == len(payload) and row["status"] == "seeding" else None

        row = wait_for(completed, "actual peer transfer never completed", 45)
        def reported_tracker_error():
            engine.tick()
            return any("Fixture tracker unavailable" in item["status"] for item in engine.dispatch("list", {})[0]["trackers"])
        wait_for(reported_tracker_error, "tracker failure was not reported")
        handle.flush_cache()
        wait_for(lambda: hashlib.sha256((destination / "fixture.bin").read_bytes()).digest() == hashlib.sha256(payload).digest(), "downloaded bytes did not match the seed")
        assert row["files"][0]["size"] == len(payload)
        assert row["engine"].startswith("libtorrent")
        assert row["infoHash"] == key
        assert row["contentPath"] == str(destination.resolve() / "fixture.bin")
        assert row["contentDirectory"] == str(destination.resolve())
        assert row["sequentialDownload"] is False
        assert not any("has no attribute" in message for message in engine.messages), engine.messages
        # Simulate a sequential flag retained by an older client's resume state.
        handle.set_flags(lt.torrent_flags.sequential_download)
        engine.dispatch("pause", {"gid": key})
        assert engine.dispatch("list", {})[0]["status"] == "paused"
        engine.dispatch("resume", {"gid": key})
        engine.checkpoint()
        wait_for(lambda: (engine.alerts() or (directory / "session" / (key + ".fastresume")).exists()), "resume data was not persisted")
        engine.dispatch("shutdown", {})
        del engine.session
        engine = module.TorrentEngine(directory / "session", offline=True)
        wait_for(lambda: engine.dispatch("list", {})[0]["downloadedBytes"] == len(payload), "completed torrent did not restore")
        assert engine.dispatch("list", {})[0]["sequentialDownload"] is False
        engine.dispatch("remove", {"gid": key, "deleteFiles": False})
        wait_for(lambda: (engine.alerts() or key in engine.removed), "keep-files removal never completed")
        assert (destination / "fixture.bin").read_bytes() == payload
        key = engine.dispatch("add", {"data": base64.b64encode(encoded).decode(), "destination": str(destination)})
        wait_for(lambda: engine.dispatch("list", {})[0]["downloadedBytes"] == len(payload), "retained files were not rechecked")
        engine.dispatch("remove", {"gid": key, "deleteFiles": True})
        wait_for(lambda: (engine.alerts() or not (destination / "fixture.bin").exists()), "torrent data was not deleted")
        assert engine.dispatch("list", {}) == []
        unknown = engine.dispatch("add", {"source": "magnet:?xt=urn:btih:" + "1" * 40 + "&dn=Metadata-test", "destination": str(destination), "limit": 32768})
        assert engine.jobs[unknown]["handle"].download_limit() == 32768
        assert engine.dispatch("list", {})[0]["status"] == "metadata"
        assert engine.dispatch("list", {})[0]["contentPath"] is None
        engine.dispatch("remove", {"gid": unknown, "deleteFiles": False})
        assert engine.dispatch("list", {}) == []
        assert json.loads((directory / "session/jobs.json").read_text()) == []
        folder_storage = lt.file_storage()
        folder_storage.add_file("Visible folder/first.bin", 4)
        folder_storage.add_file("Visible folder/second.bin", 4)
        folder_meta = lt.create_torrent(folder_storage, 16384, lt.create_torrent.v1_only)
        folder_meta.set_hash(0, hashlib.sha1(b"testtest").digest())
        folder_key = engine.dispatch("add", {"data": base64.b64encode(lt.bencode(folder_meta.generate())).decode(), "destination": str(destination)})
        assert (destination / "Visible folder").is_dir(), "content folder not visible before downloading"
        engine.dispatch("remove", {"gid": folder_key, "deleteFiles": False})
        assert (destination / "Visible folder").is_dir(), "keep-files removal deleted the folder"
        print("PASS: real 2 MiB local-peer transfer, byte verification, tracker errors, details, pause/resume, restart, deletion and metadata-only removal.")
    finally:
        engine.dispatch("shutdown", {})
        seeder.dispatch("shutdown", {})
        del engine.session
        del seeder.session
        tracker.shutdown()
        tracker.server_close()
