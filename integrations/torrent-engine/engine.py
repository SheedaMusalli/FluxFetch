"""FluxFetch's private libtorrent session. Commands travel only over the parent pipes.

The session/alert/resume-data design follows libtorrent's public API, also used by
qBittorrent. This module is an independent implementation; no qBittorrent UI or server
is launched. Never log to stdout: it carries one JSON response per request.
"""
import base64
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time
import libtorrent as lt

NETWORK_ERROR_ALERTS = tuple(
    alert_type for name in ("listen_failed_alert", "dht_error_alert")
    if isinstance(alert_type := getattr(lt, name, None), type)
)


def content_location(destination, files):
    """Use metadata paths rather than the torrent title (which may differ)."""
    base = os.path.abspath(destination)
    if not files:
        return None, base
    paths = [os.path.abspath(os.path.join(base, item["path"])) for item in files]
    if any(os.path.commonpath([base, path]) != base for path in paths):
        raise ValueError("Torrent content path escapes its destination.")
    common = os.path.commonpath(paths)
    folder = os.path.dirname(common) if common in paths else common
    return common, folder


def atomic_write(path, data):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(data)
    os.replace(temporary, path)


class TorrentEngine:
    def __init__(self, directory, offline=False):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.jobs = {}
        self.messages = []
        self.trackers = {}
        self.removing = set()
        self.removed = set()
        self.running = True
        self.last_save = time.monotonic()
        self.session = lt.session({
            "user_agent": "FluxFetch/2.0.0",
            "listen_interfaces": "127.0.0.1:0" if offline else "0.0.0.0:0,[::]:0",
            "enable_dht": not offline,
            "enable_lsd": not offline,
            "enable_upnp": not offline,
            "enable_natpmp": not offline,
            "dht_bootstrap_nodes": "dht.libtorrent.org:25401,dht.transmissionbt.com:6881,router.bt.ouinet.work:6881",
            # Bounded desktop tuning: widen the peer pool and keep high-latency peers fed.
            # TCP/uTP congestion control, adaptive request sizing and user limits stay enabled.
            "connections_limit": 500,
            "max_out_request_queue": 1024,
            "peer_connect_timeout": 10,
            "announce_to_all_tiers": True,
            "announce_to_all_trackers": True,
            "prioritize_partial_pieces": False,
            "alert_mask": int(lt.alert.category_t.error_notification | lt.alert.category_t.status_notification
                              | lt.alert.category_t.storage_notification | lt.alert.category_t.tracker_notification),
        })
        self.restore()

    def key(self, handle):
        hashes = handle.info_hashes()
        return str(hashes.v1) if hashes.has_v1() else str(hashes.v2)

    def index(self):
        records = [{k: v for k, v in job.items() if k != "handle"} for job in self.jobs.values()]
        atomic_write(self.directory / "jobs.json", json.dumps(records).encode())

    def restore(self):
        try:
            records = json.loads((self.directory / "jobs.json").read_text())
        except (FileNotFoundError, ValueError):
            return
        for record in records:
            try:
                key = record["key"]
                if not key or any(c not in "0123456789abcdef" for c in key):
                    continue
                resume = self.directory / (key + ".fastresume")
                metainfo = self.directory / (key + ".torrent")
                if resume.exists():
                    params = lt.read_resume_data(resume.read_bytes())
                elif metainfo.exists():
                    params = lt.add_torrent_params()
                    params.ti = lt.torrent_info(str(metainfo))
                else:
                    params = lt.parse_magnet_uri(record["source"])
                self.install(params, record["savePath"], record.get("limit", 0), record.get("source", ""), record.get("paused", False))
            except Exception as error:
                self.messages.append("Could not restore torrent: " + str(error))

    def install(self, params, destination, limit, source="", paused=False):
        destination = str(Path(destination).resolve())
        Path(destination).mkdir(parents=True, exist_ok=True)
        params.save_path = destination
        params.flags &= ~lt.torrent_flags.auto_managed
        # Resume files can retain flags: always use the normal swarm piece picker.
        params.flags &= ~lt.torrent_flags.sequential_download
        params.flags &= ~lt.torrent_flags.paused
        if paused:
            params.flags |= lt.torrent_flags.paused
        params.download_limit = max(0, int(limit))
        handle = self.session.add_torrent(params)
        handle.set_max_connections(250)
        key = self.key(handle)
        if key in self.jobs:
            return key
        self.removing.discard(key)
        self.jobs[key] = {"key": key, "source": source, "savePath": destination, "limit": limit,
                          "paused": paused, "handle": handle}
        self.index()
        self.save_metadata(handle)
        handle.save_resume_data()
        return key

    def save_metadata(self, handle):
        if handle.status().has_metadata:
            storage = handle.torrent_file().files()
            files = [{"path": storage.file_path(index)} for index in range(storage.num_files())
                     if not storage.file_flags(index) & lt.file_storage.flag_pad_file]
            _, folder = content_location(handle.status().save_path, files)
            # Make the real content folder visible before any piece has completed.
            # libtorrent still owns file allocation, writes and piece verification.
            Path(folder).mkdir(parents=True, exist_ok=True)
            data = lt.bencode(lt.create_torrent(handle.torrent_file()).generate())
            atomic_write(self.directory / (self.key(handle) + ".torrent"), data)

    def alerts(self):
        for alert in self.session.pop_alerts():
            try:
                handle = getattr(alert, "handle", None)
                key = self.key(handle) if handle and handle.is_valid() else None
                if isinstance(alert, lt.save_resume_data_alert) and key in self.jobs and key not in self.removing:
                    atomic_write(self.directory / (key + ".fastresume"), bytes(lt.write_resume_data_buf(alert.params)))
                elif isinstance(alert, lt.metadata_received_alert):
                    self.save_metadata(handle)
                    handle.save_resume_data()
                elif isinstance(alert, lt.torrent_removed_alert):
                    self.removed.add(str(alert.info_hashes.v1) if alert.info_hashes.has_v1() else str(alert.info_hashes.v2))
                elif isinstance(alert, (lt.tracker_error_alert, lt.tracker_reply_alert, lt.tracker_warning_alert)):
                    tracker_url = getattr(alert, "tracker_url", getattr(alert, "url", ""))
                    url = tracker_url() if callable(tracker_url) else str(tracker_url)
                    self.trackers[(key, url)] = {"url": url, "status": alert.message(),
                                                  "peers": int(getattr(alert, "num_peers", 0))}
                elif isinstance(alert, NETWORK_ERROR_ALERTS):
                    self.messages = (self.messages + [alert.message()])[-5:]
            except Exception as error:
                self.messages = (self.messages + [str(error)])[-5:]

    def snapshot(self, job):
        handle = job["handle"]
        state = handle.status()
        metadata = handle.torrent_file() if state.has_metadata else None
        error = state.errc.message() if state.errc.value() else None
        if error:
            status = "error"
        elif job["paused"]:
            status = "paused"
        elif not state.has_metadata:
            status = "metadata"
        elif state.state in (lt.torrent_status.checking_files, lt.torrent_status.checking_resume_data):
            status = "checking"
        elif state.is_seeding or state.is_finished:
            status = "seeding"
        elif state.download_payload_rate > 0:
            status = "active"
        else:
            status = "stalled"
        files = []
        if metadata:
            storage = metadata.files()
            progress = handle.file_progress()
            for index in range(storage.num_files()):
                if storage.file_flags(index) & lt.file_storage.flag_pad_file:
                    continue
                files.append({"path": storage.file_path(index), "size": storage.file_size(index),
                              "downloaded": progress[index] if index < len(progress) else 0})
        content_path, content_directory = content_location(job["savePath"], files)
        peers = [{"address": f"{peer.ip[0]}:{peer.ip[1]}", "client": str(peer.client),
                  "downloadSpeed": peer.down_speed, "uploadSpeed": peer.up_speed,
                  "progress": peer.progress} for peer in handle.get_peer_info()[:100]]
        trackers = []
        for tracker in handle.trackers():
            url = tracker.get("url", "")
            trackers.append(self.trackers.get((job["key"], url), {"url": url, "status": "Not contacted yet", "peers": 0}))
        session = self.session.status()
        diagnostic = ("Discovering peers for torrent metadata." if status == "metadata" else
                      "Waiting for peers with available pieces. Check tracker details below." if status == "stalled" and not state.num_peers else
                      "Connected peers have not sent data yet." if status == "stalled" else "")
        return {"gid": job["key"], "infoHash": job["key"], "name": state.name or "Fetching torrent metadata",
                "status": status, "totalBytes": state.total_wanted, "downloadedBytes": state.total_wanted_done,
                "uploadedBytes": state.all_time_upload, "downloadSpeed": state.download_payload_rate,
                "uploadSpeed": state.upload_payload_rate, "peers": state.num_peers, "seeders": state.num_seeds,
                "destinationDir": job["savePath"], "contentPath": content_path,
                "contentDirectory": content_directory,
                "sequentialDownload": bool(handle.flags() & lt.torrent_flags.sequential_download),
                "error": error, "files": files, "trackers": trackers,
                "peerDetails": peers, "ratio": state.all_time_upload / max(1, state.all_time_download),
                "etaSeconds": int((state.total_wanted - state.total_wanted_done) / state.download_payload_rate) if state.download_payload_rate else None,
                "dhtNodes": session.dht_nodes, "listenPort": self.session.listen_port(),
                "diagnostic": diagnostic, "engineMessages": self.messages, "engine": "libtorrent " + lt.__version__}

    def dispatch(self, method, params):
        self.alerts()
        if method == "ping":
            return {"engine": "libtorrent", "version": lt.__version__}
        if method == "list":
            return [self.snapshot(job) for job in self.jobs.values()]
        if method == "add":
            if "data" in params:
                data = base64.b64decode(params["data"], validate=True)
                if not data or len(data) > 10 * 1024 * 1024:
                    raise ValueError("Torrent metadata must be between 1 byte and 10 MB.")
                add = lt.add_torrent_params()
                add.ti = lt.torrent_info(lt.bdecode(data))
            else:
                add = lt.parse_magnet_uri(params["source"])
            return self.install(add, params["destination"], params.get("limit", 0), params.get("source", ""))
        if method == "shutdown":
            self.checkpoint()
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                self.alerts()
                time.sleep(.05)
            self.running = False
            return True
        key = params["gid"]
        if key not in self.jobs:
            raise ValueError("That torrent is no longer in the list.")
        job = self.jobs[key]
        handle = job["handle"]
        if method == "pause":
            handle.pause()
            job["paused"] = True
        elif method == "resume":
            handle.resume()
            job["paused"] = False
            handle.force_reannounce()
            handle.force_dht_announce()
        elif method == "reannounce":
            handle.force_reannounce()
            handle.force_dht_announce()
        elif method == "remove":
            self.removing.add(key)
            options = lt.options_t.delete_files if params.get("deleteFiles") else 0
            self.session.remove_torrent(handle, options)
            del self.jobs[key]
            self.index()
            # Do not allow late resume alerts to recreate this job after deletion.
            for suffix in (".torrent", ".fastresume"):
                (self.directory / (key + suffix)).unlink(missing_ok=True)
            return True
        else:
            raise ValueError("Unknown torrent command.")
        self.index()
        handle.save_resume_data()
        return True

    def checkpoint(self):
        self.index()
        for job in self.jobs.values():
            if job["handle"].is_valid():
                job["handle"].save_resume_data()

    def tick(self):
        self.alerts()
        if time.monotonic() - self.last_save > 30:
            self.checkpoint()
            self.last_save = time.monotonic()


def main():
    engine = TorrentEngine(sys.argv[1])
    commands = queue.Queue()

    def read_commands():
        for line in sys.stdin:
            try:
                if len(line) > 15 * 1024 * 1024:
                    raise ValueError("Torrent command is too large.")
                commands.put(json.loads(line))
            except Exception as error:
                print(str(error), file=sys.stderr, flush=True)
        commands.put({"id": None, "method": "shutdown", "params": {}})

    threading.Thread(target=read_commands, daemon=True).start()
    while engine.running:
        try:
            command = commands.get(timeout=.2)
        except queue.Empty:
            engine.tick()
            continue
        try:
            result = engine.dispatch(command["method"], command.get("params", {}))
            response = {"id": command["id"], "result": result}
        except Exception as error:
            response = {"id": command.get("id"), "error": str(error)}
        print(json.dumps(response, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
